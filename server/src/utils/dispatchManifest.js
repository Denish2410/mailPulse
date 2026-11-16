import mongoose from 'mongoose';
import { MAX_CAMPAIGN_RECIPIENTS } from '../models/Campaign.js';

/**
 * Dispatch manifest: the exact recipient list a campaign is locked to when it starts sending.
 *
 * The manifest is built from the contacts that passed readiness and is meant to be stored on the
 * campaign in the same atomic update that moves it to 'sending'. Delivery records are then
 * generated from it, so a crash part-way through generation can be completed (and verified)
 * against a list that no longer depends on live contact data.
 *
 * Entries use short keys because the whole list lives in ONE MongoDB document:
 *   c = contact id, e = recipient email (trimmed, lowercase), n = recipient name (max 100 chars)
 *
 * SIZE SAFETY: limits are enforced on the MEASURED BSON size of the real entries, never on an
 * estimate. Both limits are far below MongoDB's 16 MiB document limit on purpose.
 */

export const DISPATCH_MANIFEST_VERSION = 1;

/** Hard cap for the stored manifest field itself (measured BSON bytes). */
export const MAX_MANIFEST_BSON_BYTES = 4 * 1024 * 1024;

/** Hard cap for the campaign document INCLUDING its manifest (measured BSON bytes). */
export const MAX_CAMPAIGN_DOCUMENT_BSON_BYTES = 8 * 1024 * 1024;

const MAX_EMAIL_LENGTH = 254;
const MAX_NAME_LENGTH = 100;

export const DISPATCH_MANIFEST_ERROR_CODES = Object.freeze([
  'INVALID_INPUT',
  'EMPTY',
  'TOO_MANY_RECIPIENTS',
  'INVALID_ENTRY',
  'DUPLICATE_RECIPIENT',
  'MANIFEST_TOO_LARGE',
  'DOCUMENT_TOO_LARGE',
]);

/**
 * Raised when a manifest cannot be built safely. `code` is one of DISPATCH_MANIFEST_ERROR_CODES.
 * Messages never contain recipient names or addresses.
 */
export class DispatchManifestError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DispatchManifestError';
    this.code = code;
  }
}

/**
 * Exact BSON size, in bytes, of a plain object as MongoDB would store it.
 *
 * @param {object} value
 * @returns {number}
 */
export const measureBsonBytes = (value) => mongoose.mongo.BSON.calculateObjectSize(value);

/** Resolves a limit that tests may lower but nothing may raise above the hard cap. */
const boundedLimit = (requested, hardCap) =>
  Number.isInteger(requested) && requested > 0 ? Math.min(requested, hardCap) : hardCap;

/**
 * Builds the manifest for the contacts that passed readiness.
 *
 * Fails closed: any invalid or duplicate entry, an empty list, too many recipients, or a size over
 * either limit throws a DispatchManifestError and nothing is returned.
 *
 * @param {Array<{ _id: any, email: string, name?: string }>} eligibleContacts
 * @param {object} [options]
 * @param {number} [options.campaignDocumentBytes=0] - Measured BSON size of the campaign document
 *   the manifest will be stored on (without the manifest)
 * @param {number} [options.maxRecipients] - May only LOWER the recipient cap
 * @param {number} [options.maxManifestBytes] - May only LOWER the manifest size cap
 * @param {number} [options.maxDocumentBytes] - May only LOWER the document size cap
 * @returns {{ version: number, count: number, bytes: number, entries: ReadonlyArray<{ c: import('mongoose').Types.ObjectId, e: string, n: string }> }}
 * @throws {DispatchManifestError}
 */
export const buildDispatchManifest = (eligibleContacts, options = {}) => {
  if (!Array.isArray(eligibleContacts)) {
    throw new DispatchManifestError('INVALID_INPUT', 'Dispatch manifest requires a list of contacts.');
  }

  const maxRecipients = boundedLimit(options.maxRecipients, MAX_CAMPAIGN_RECIPIENTS);
  const maxManifestBytes = boundedLimit(options.maxManifestBytes, MAX_MANIFEST_BSON_BYTES);
  const maxDocumentBytes = boundedLimit(options.maxDocumentBytes, MAX_CAMPAIGN_DOCUMENT_BSON_BYTES);

  if (eligibleContacts.length === 0) {
    throw new DispatchManifestError('EMPTY', 'Dispatch manifest requires at least one recipient.');
  }
  if (eligibleContacts.length > maxRecipients) {
    throw new DispatchManifestError(
      'TOO_MANY_RECIPIENTS',
      `Dispatch manifest cannot hold more than ${maxRecipients} recipients.`
    );
  }

  const seen = new Set();
  const entries = eligibleContacts.map((contact, index) => {
    const rawId = contact?._id;
    const isObjectId = rawId instanceof mongoose.Types.ObjectId;
    const isHexId = typeof rawId === 'string' && /^[a-f0-9]{24}$/i.test(rawId);
    if (!isObjectId && !isHexId) {
      throw new DispatchManifestError('INVALID_ENTRY', `Recipient ${index} has no valid contact id.`);
    }
    const contactId = isObjectId ? rawId : new mongoose.Types.ObjectId(rawId);

    const email = typeof contact.email === 'string' ? contact.email.trim().toLowerCase() : '';
    if (!email || email.length > MAX_EMAIL_LENGTH) {
      throw new DispatchManifestError('INVALID_ENTRY', `Recipient ${index} has no valid email address.`);
    }

    const key = contactId.toString();
    if (seen.has(key)) {
      throw new DispatchManifestError('DUPLICATE_RECIPIENT', `Recipient ${index} appears more than once.`);
    }
    seen.add(key);

    // Same normalization the Delivery snapshot has always used: first 100 characters, trimmed
    const name = typeof contact.name === 'string' ? contact.name.slice(0, MAX_NAME_LENGTH).trim() : '';

    return Object.freeze({ c: contactId, e: email, n: name });
  });

  // Measured exactly as it will be embedded: one array field inside the campaign document
  const bytes = measureBsonBytes({ dispatchManifest: entries });
  if (bytes > maxManifestBytes) {
    throw new DispatchManifestError(
      'MANIFEST_TOO_LARGE',
      `Dispatch manifest is ${bytes} bytes; the limit is ${maxManifestBytes} bytes.`
    );
  }

  const campaignDocumentBytes = options.campaignDocumentBytes ?? 0;
  if (!Number.isInteger(campaignDocumentBytes) || campaignDocumentBytes < 0) {
    throw new DispatchManifestError('INVALID_INPUT', 'campaignDocumentBytes must be a non-negative integer.');
  }
  if (campaignDocumentBytes + bytes > maxDocumentBytes) {
    throw new DispatchManifestError(
      'DOCUMENT_TOO_LARGE',
      `Campaign document with its manifest would be ${campaignDocumentBytes + bytes} bytes; the limit is ${maxDocumentBytes} bytes.`
    );
  }

  return Object.freeze({
    version: DISPATCH_MANIFEST_VERSION,
    count: entries.length,
    bytes,
    entries: Object.freeze(entries),
  });
};

export default {
  DISPATCH_MANIFEST_VERSION,
  MAX_MANIFEST_BSON_BYTES,
  MAX_CAMPAIGN_DOCUMENT_BSON_BYTES,
  DispatchManifestError,
  measureBsonBytes,
  buildDispatchManifest,
};
