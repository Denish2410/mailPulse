import mongoose from 'mongoose';
import { MemoryStore } from 'express-rate-limit';

/**
 * Rate-limit counters shared by every application instance.
 *
 * express-rate-limit keeps counters in process memory by default, so with N instances each
 * client effectively gets N times the limit (and login brute-force protection is diluted).
 * Setting RATE_LIMIT_STORE=mongo moves the counters into MongoDB (collection `ratelimits`, one
 * document per key and window, removed by a TTL index), which every instance already reaches.
 *
 * Each hit is ONE atomic upsert driven by an aggregation pipeline, so concurrent requests on
 * different instances can neither lose a count nor reset each other's window.
 *
 * If the database cannot be reached the store fails OPEN (the request is allowed and a warning is
 * logged at most once a minute): a database blip must not lock every user out of the API.
 */

const COLLECTION = 'ratelimits';
const WARN_EVERY_MS = 60 * 1000;

export class MongoRateLimitStore {
  /**
   * @param {string} name - Namespace so limiters never share counters (e.g. "auth", "api")
   * @param {{ logger?: { warn: Function }, now?: () => number }} [options]
   */
  constructor(name, { logger = console, now = Date.now } = {}) {
    this.prefix = `${name}:`;
    this.logger = logger;
    this.now = now;
    this.windowMs = 60 * 1000;
    this.localKeys = false; // counters live in the database, not in this process
    this.lastWarnAt = 0;
    this.indexReady = null;
  }

  init(options) {
    this.windowMs = options.windowMs;
  }

  collection() {
    return mongoose.connection.collection(COLLECTION);
  }

  ensureIndex() {
    // TTL index removes expired windows; counting itself never relies on it (expiresAt is checked)
    this.indexReady ||= this.collection()
      .createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 })
      .catch(() => {});
    return this.indexReady;
  }

  warn(error) {
    const t = this.now();
    if (t - this.lastWarnAt >= WARN_EVERY_MS) {
      this.lastWarnAt = t;
      this.logger.warn(`[RateLimit] Store unavailable, allowing requests: ${error?.name || 'Error'}`);
    }
  }

  async increment(key) {
    const now = this.now();
    const _id = this.prefix + key;
    const nowDate = new Date(now);
    const fresh = new Date(now + this.windowMs);
    const live = { $gt: [{ $ifNull: ['$expiresAt', new Date(0)] }, nowDate] };
    const update = [
      {
        $set: {
          hits: { $cond: [live, { $add: [{ $ifNull: ['$hits', 0] }, 1] }, 1] },
          expiresAt: { $cond: [live, '$expiresAt', fresh] },
        },
      },
    ];

    try {
      await this.ensureIndex();
      let doc;
      try {
        doc = await this.collection().findOneAndUpdate({ _id }, update, { upsert: true, returnDocument: 'after' });
      } catch (error) {
        // Two instances upserting the same new key at once: the loser retries as a plain update
        if (error?.code !== 11000) throw error;
        doc = await this.collection().findOneAndUpdate({ _id }, update, { upsert: true, returnDocument: 'after' });
      }
      const value = doc?.value ?? doc; // driver v5 returns { value }, v6+ returns the document
      return { totalHits: value.hits, resetTime: value.expiresAt };
    } catch (error) {
      this.warn(error);
      return { totalHits: 1, resetTime: fresh };
    }
  }

  async decrement(key) {
    try {
      await this.collection().updateOne({ _id: this.prefix + key, hits: { $gt: 0 } }, { $inc: { hits: -1 } });
    } catch (error) {
      this.warn(error);
    }
  }

  async resetKey(key) {
    try {
      await this.collection().deleteOne({ _id: this.prefix + key });
    } catch (error) {
      this.warn(error);
    }
  }
}

/**
 * Store handed to express-rate-limit. The choice between memory and MongoDB is made on first use
 * (not at import time) because limiters are constructed when route modules load, which is before
 * server.js has read the .env file. With RATE_LIMIT_STORE unset behaviour is exactly the default
 * in-memory store.
 */
class ConfigurableStore {
  constructor(name, env) {
    this.name = name;
    this.env = env;
    this.options = null;
    this.impl = null;
  }

  resolve() {
    if (!this.impl) {
      const useMongo = String(this.env.RATE_LIMIT_STORE ?? '').trim().toLowerCase() === 'mongo';
      this.impl = useMongo ? new MongoRateLimitStore(this.name) : new MemoryStore();
      this.impl.init?.(this.options || { windowMs: 60 * 1000 });
    }
    return this.impl;
  }

  init(options) {
    this.options = options;
  }

  get localKeys() {
    return this.resolve().localKeys;
  }

  get(key) {
    return this.resolve().get?.(key);
  }

  increment(key) {
    return this.resolve().increment(key);
  }

  decrement(key) {
    return this.resolve().decrement(key);
  }

  resetKey(key) {
    return this.resolve().resetKey(key);
  }

  resetAll() {
    return this.resolve().resetAll?.();
  }
}

/**
 * @param {string} name - Unique per limiter
 * @param {object} [env=process.env]
 * @returns {object} A store for express-rate-limit's `store` option
 */
export const createRateLimitStore = (name, env = process.env) => new ConfigurableStore(name, env);
