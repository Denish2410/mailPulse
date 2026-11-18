import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import { connectDB } from './config/db.js';
import { validateShutdownConfig } from './config/shutdown.js';
import { validateTokenEncryptionConfig } from './utils/tokenCrypto.js';
import { getErrorReporter } from './services/errorReporter.service.js';
import { getDefaultEmailService } from './services/email.service.js';
import {
  startDispatchRuntime,
  stopDispatchRuntime,
  isDispatchRuntimeRunning,
} from './services/dispatchRuntime.service.js';
import { createShutdownHandler } from './utils/gracefulShutdown.js';

/**
 * MailPulse worker: the only process that sends campaigns.
 *
 * It connects to MongoDB and runs the dispatch runtime (startup resume of interrupted campaigns,
 * the stalled-campaign watchdog and the scheduled-campaign poller, which also picks up campaigns
 * queued by "send now"). It serves no API. Its only listener is a small health endpoint:
 *
 *   GET /health   200 { status: 'ready', ... } while MongoDB is connected and the runtime runs,
 *                 503 { status: 'not_ready', ... } otherwise (including during shutdown)
 *
 * The endpoint binds to WORKER_HEALTH_HOST (default 127.0.0.1, so it is reachable by the
 * container's own health check but not from outside) on WORKER_HEALTH_PORT (default 5001). It
 * reveals nothing but these booleans.
 *
 * Shutdown (SIGTERM/SIGINT) uses the same ordered, bounded handler as the API: health endpoint
 * closed, scheduler stopped, dispatches stopped (in-flight sweeps, recoveries and sends awaited,
 * leases released), MongoDB closed.
 */

export const DEFAULT_WORKER_HEALTH_PORT = 5001;
export const DEFAULT_WORKER_HEALTH_HOST = '127.0.0.1';

/**
 * Resolves the health endpoint's port (0 = any free port, used by tests).
 *
 * @param {object} [env=process.env]
 * @returns {number}
 * @throws {Error} For a value that is not an integer between 0 and 65535
 */
export const getWorkerHealthPort = (env = process.env) => {
  const raw = env.WORKER_HEALTH_PORT;
  if (raw === undefined || raw === null || String(raw).trim() === '') return DEFAULT_WORKER_HEALTH_PORT;
  const text = String(raw).trim();
  const value = Number(text);
  if (!/^\d+$/.test(text) || value > 65535) {
    throw new Error('Worker configuration error: WORKER_HEALTH_PORT must be a whole number between 0 and 65535.');
  }
  return value;
};

let healthServer = null;
let isStarting = false;
let shuttingDown = false;

/**
 * Current worker health. Ready only while MongoDB is connected, the runtime is running and the
 * worker is not shutting down.
 *
 * @returns {{ ready: boolean, body: object }}
 */
export const getWorkerHealth = () => {
  const database = mongoose.connection.readyState === 1;
  const runtime = isDispatchRuntimeRunning();
  const ready = database && runtime && !shuttingDown;
  return {
    ready,
    body: { status: ready ? 'ready' : 'not_ready', database, runtime, shuttingDown },
  };
};

const handleHealthRequest = (req, res) => {
  const url = (req.url || '').split('?')[0];
  if (req.method !== 'GET' || url !== '/health') {
    res.writeHead(404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ status: 'not_found' }));
    return;
  }
  const { ready, body } = getWorkerHealth();
  res.writeHead(ready ? 200 : 503, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
};

/**
 * Starts the worker: validate configuration, connect to MongoDB, start the dispatch runtime, then
 * open the health endpoint.
 *
 * @param {object} [options]
 * @param {Function} [options.connectDB] - Database connection function
 * @param {number} [options.port] - Health port (defaults to WORKER_HEALTH_PORT / 5001)
 * @param {string} [options.host] - Health host (defaults to WORKER_HEALTH_HOST / 127.0.0.1)
 * @param {{ sendEmail: Function }} [options.emailService] - Defaults to the configured service
 * @param {object} [options.logger=console]
 * @param {boolean} [options.validateConfig=true]
 * @returns {Promise<import('node:http').Server>} The health server
 */
export const startWorker = async (options = {}) => {
  if (healthServer?.listening) return healthServer;
  if (isStarting) throw new Error('Worker startup is already in progress.');
  isStarting = true;
  const logger = options.logger || console;
  try {
    if (options.validateConfig ?? true) {
      validateShutdownConfig();
      // The worker will decrypt OAuth tokens to send: same fail-closed rule as the API
      validateTokenEncryptionConfig();
    }
    const port = options.port ?? getWorkerHealthPort();
    const host = options.host ?? (process.env.WORKER_HEALTH_HOST || DEFAULT_WORKER_HEALTH_HOST);

    await (options.connectDB || connectDB)();
    shuttingDown = false;
    startDispatchRuntime({ emailService: options.emailService || getDefaultEmailService(), logger });

    const server = http.createServer(handleHealthRequest);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, host, () => {
        server.off('error', reject);
        resolve();
      });
    });
    healthServer = server;
    logger.log(`[Worker] Dispatch worker running; health endpoint on ${host}:${server.address().port}/health`);
    return server;
  } finally {
    isStarting = false;
  }
};

/**
 * Graceful shutdown for the worker process. Health turns 'not_ready' as soon as it starts.
 *
 * @param {object} [options] - Passed to createShutdownHandler (tests inject exitFn, timeouts, ...)
 * @returns {Function} Shutdown function accepting a signal name
 */
export const createWorkerShutdownHandler = (options = {}) => {
  const shutdown = createShutdownHandler({
    label: 'Worker',
    serverGetter: () => healthServer,
    // Scheduler first, then dispatches; also marks the runtime stopped
    stopDispatches: stopDispatchRuntime,
    ...options,
  });
  return async (signal) => {
    shuttingDown = true;
    await shutdown(signal);
  };
};

/** Resets module state (tests). */
export const resetWorkerState = () => {
  healthServer = null;
  isStarting = false;
  shuttingDown = false;
};

const isMainModule = () => Boolean(process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]);

if (isMainModule()) {
  const handleShutdown = createWorkerShutdownHandler();
  process.on('SIGTERM', () => handleShutdown('SIGTERM'));
  process.on('SIGINT', () => handleShutdown('SIGINT'));

  const crash = (source) => async (reason) => {
    await Promise.race([
      getErrorReporter().reportError(reason, { source }),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
    process.exit(1);
  };
  process.on('unhandledRejection', crash('unhandledRejection'));
  process.on('uncaughtException', crash('uncaughtException'));

  startWorker().catch((error) => {
    console.error(`[Worker Error] Startup failed: ${error?.message || 'Error'}`);
    process.exit(1);
  });
}

export default { startWorker, createWorkerShutdownHandler, getWorkerHealth, getWorkerHealthPort };
