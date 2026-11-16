import mongoose from 'mongoose';
import Campaign from '../models/Campaign.js';
import Delivery from '../models/Delivery.js';
import { DISPATCH_MANIFEST_VERSION } from '../utils/dispatchManifest.js';

/**
 * Delivery generation from the dispatch manifest.
 *
 * A campaign's Delivery records are generated from the manifest STORED on it by the send lock
 * (never from live contact data), and are verified against that manifest before any delivery may
 * be claimed:
 *
 *   1. classify  - is the stored manifest valid, corrupt, or absent (a campaign locked before
 *                  manifests existed)? Only a valid manifest is ever used.
 *   2. generate  - insert one pending delivery per manifest entry. Idempotent: the unique
 *                  { campaignId, contactId } index rejects entries that already exist, and only
 *                  those duplicate-key rejections are ignored. Safe to repeat and to run from two
 *                  processes at once; every generator inserts members of the same stored list.
 *   3. verify    - the campaign's deliveries must be EXACTLY the manifest: same contacts, same
 *                  addresses, same owner, nothing missing and nothing extra.
 *
 * Nothing here deletes a delivery or changes a campaign. Error messages never contain recipient
 * names or addresses.
 */

export const DELIVERY_GENERATION_ERROR_CODES = Object.freeze([
  'CAMPAIGN_NOT_FOUND',
  'MANIFEST_LEGACY',
  'MANIFEST_CORRUPT',
  'INSERT_FAILED',
  'MEMBERSHIP_MISMATCH',
]);

/** Raised when deliveries cannot be generated or do not match the manifest. Never retried here. */
export class DeliveryGenerationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'DeliveryGenerationError';
    this.code = code;
  }
}

const DUPLICATE_KEY = 11000;

const isObjectId = (value) => value instanceof mongoose.Types.ObjectId;

/**
 * Classifies the manifest fields of a campaign document loaded WITH `+dispatchManifest`.
 *
 * - 'legacy'  : none of the three fields exist (locked before manifests, or never locked). This is
 *               decided only by the fields being absent, never inferred from delivery data.
 * - 'valid'   : version 1, a positive integer count, and exactly that many well-formed entries with
 *               unique contact ids.
 * - 'corrupt' : anything else (a partial set of fields, an unknown version, a count that does not
 *               match, a malformed or duplicated entry).
 *
 * @param {object|null|undefined} campaign
 * @returns {'valid'|'legacy'|'corrupt'}
 */
export const classifyStoredManifest = (campaign) => {
  const version = campaign?.dispatchManifestVersion;
  const count = campaign?.dispatchManifestCount;
  const entries = campaign?.dispatchManifest;

  const absent = (value) => value === undefined || value === null;
  if (absent(version) && absent(count) && absent(entries)) {
    return 'legacy';
  }

  if (version !== DISPATCH_MANIFEST_VERSION) return 'corrupt';
  if (!Number.isInteger(count) || count <= 0) return 'corrupt';
  if (!Array.isArray(entries) || entries.length !== count) return 'corrupt';

  const seen = new Set();
  for (const entry of entries) {
    if (!entry || !isObjectId(entry.c)) return 'corrupt';
    if (typeof entry.e !== 'string' || entry.e.length === 0) return 'corrupt';
    if (typeof entry.n !== 'string') return 'corrupt';
    const key = entry.c.toString();
    if (seen.has(key)) return 'corrupt';
    seen.add(key);
  }
  return 'valid';
};

/**
 * Loads the fields generation needs, explicitly selecting the manifest (it is `select: false`).
 *
 * @param {import('mongoose').Types.ObjectId|string} campaignId
 * @returns {Promise<object|null>}
 */
export const loadCampaignManifest = (campaignId) =>
  Campaign.findById(campaignId)
    .select('userId subjectB status dispatchManifestVersion dispatchManifestCount +dispatchManifest')
    .lean();

/** True when an insertMany failure consists ONLY of duplicate-key rejections. */
const isOnlyDuplicateKeys = (error) => {
  const writeErrors = Array.isArray(error?.writeErrors) ? error.writeErrors : [];
  if (writeErrors.length > 0) {
    return writeErrors.every((writeError) => (writeError?.code ?? writeError?.err?.code) === DUPLICATE_KEY);
  }
  return error?.code === DUPLICATE_KEY;
};

/**
 * Inserts one pending delivery per manifest entry; entries that already have a delivery are left
 * exactly as they are (whatever their status).
 *
 * The A/B variant comes from the entry's position in the manifest, so every generator assigns the
 * same variant to the same recipient.
 *
 * @param {object} params
 * @param {import('mongoose').Types.ObjectId|string} params.campaignId
 * @param {import('mongoose').Types.ObjectId|string} params.userId - The campaign's owner
 * @param {string} [params.subjectB] - Non-empty when the campaign is an A/B test
 * @param {Array<{ c: import('mongoose').Types.ObjectId, e: string, n: string }>} params.entries
 * @param {number|null} [params.fence=null] - Fence for the inserted deliveries (a recovering owner
 *   passes its lease epoch so they carry the same fence as every other pending delivery)
 * @returns {Promise<void>}
 * @throws {DeliveryGenerationError} 'INSERT_FAILED' for anything other than duplicate keys
 */
export const generateDeliveriesFromManifest = async ({ campaignId, userId, subjectB, entries, fence = null }) => {
  const documents = entries.map((entry, index) => ({
    campaignId,
    // Alternate A/B so the split is exactly even; without a test everyone is 'A'
    variant: subjectB && index % 2 === 1 ? 'B' : 'A',
    userId,
    contactId: entry.c,
    email: entry.e,
    name: entry.n,
    status: 'pending',
    ...(Number.isInteger(fence) && { fence }),
  }));

  try {
    await Delivery.insertMany(documents, { ordered: false, throwOnValidationError: true });
  } catch (error) {
    if (isOnlyDuplicateKeys(error)) {
      return;
    }
    throw new DeliveryGenerationError(
      'INSERT_FAILED',
      `Delivery generation for campaign ${String(campaignId)} failed (${error?.name || 'Error'}).`
    );
  }
};

/**
 * Verifies that the campaign's deliveries are exactly its manifest.
 *
 * @param {object} params
 * @param {import('mongoose').Types.ObjectId|string} params.campaignId
 * @param {import('mongoose').Types.ObjectId|string} params.userId - The campaign's owner
 * @param {Array<{ c: import('mongoose').Types.ObjectId, e: string, n: string }>} params.entries
 * @returns {Promise<number>} The verified number of deliveries
 * @throws {DeliveryGenerationError} 'MEMBERSHIP_MISMATCH' (counts only; no recipient data)
 */
export const verifyDeliveriesMatchManifest = async ({ campaignId, userId, entries }) => {
  const deliveries = await Delivery.find({ campaignId }).select('contactId userId email').lean();

  const expected = new Map(entries.map((entry) => [entry.c.toString(), entry.e]));
  const owner = String(userId);
  const seen = new Set();
  let unexpected = 0;
  let wrongOwner = 0;
  let wrongAddress = 0;

  for (const delivery of deliveries) {
    const key = String(delivery.contactId);
    if (!expected.has(key) || seen.has(key)) {
      unexpected += 1;
      continue;
    }
    seen.add(key);
    if (String(delivery.userId) !== owner) wrongOwner += 1;
    if (delivery.email !== expected.get(key)) wrongAddress += 1;
  }
  const missing = expected.size - seen.size;

  if (missing > 0 || unexpected > 0 || wrongOwner > 0 || wrongAddress > 0) {
    throw new DeliveryGenerationError(
      'MEMBERSHIP_MISMATCH',
      `Deliveries of campaign ${String(campaignId)} do not match its manifest ` +
        `(expected ${expected.size}, found ${deliveries.length}, missing ${missing}, unexpected ${unexpected}, ` +
        `wrong owner ${wrongOwner}, wrong address ${wrongAddress}).`
    );
  }
  return deliveries.length;
};

/**
 * Generates (idempotently) and verifies a campaign's deliveries from its STORED manifest. Returns
 * only when the deliveries are exactly the manifest; otherwise throws and nothing may be claimed.
 *
 * @param {import('mongoose').Types.ObjectId|string} campaignId
 * @param {object} [options]
 * @param {number|null} [options.fence=null] - See generateDeliveriesFromManifest
 * @returns {Promise<{ count: number }>}
 * @throws {DeliveryGenerationError}
 */
export const ensureDeliveriesFromManifest = async (campaignId, { fence = null } = {}) => {
  const campaign = await loadCampaignManifest(campaignId);
  if (!campaign) {
    throw new DeliveryGenerationError('CAMPAIGN_NOT_FOUND', `Campaign ${String(campaignId)} not found.`);
  }

  const kind = classifyStoredManifest(campaign);
  if (kind === 'legacy') {
    throw new DeliveryGenerationError(
      'MANIFEST_LEGACY',
      `Campaign ${String(campaignId)} has no dispatch manifest.`
    );
  }
  if (kind === 'corrupt') {
    throw new DeliveryGenerationError(
      'MANIFEST_CORRUPT',
      `Campaign ${String(campaignId)} has an invalid dispatch manifest.`
    );
  }

  const params = {
    campaignId: campaign._id,
    userId: campaign.userId,
    subjectB: campaign.subjectB,
    entries: campaign.dispatchManifest,
  };
  await generateDeliveriesFromManifest({ ...params, fence });
  const count = await verifyDeliveriesMatchManifest(params);
  return { count };
};

export default {
  DeliveryGenerationError,
  classifyStoredManifest,
  loadCampaignManifest,
  generateDeliveriesFromManifest,
  verifyDeliveriesMatchManifest,
  ensureDeliveriesFromManifest,
};
