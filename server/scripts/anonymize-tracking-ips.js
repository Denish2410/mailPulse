#!/usr/bin/env node
/**
 * One-off privacy migration: converts raw visitor IPs stored on old TrackingEvent documents into
 * keyed hashes (`ipHash`) and removes the raw `ip` field.
 *
 *   npm --prefix server run anonymize:tracking-ips            # do it
 *   npm --prefix server run anonymize:tracking-ips -- --dry-run   # only count
 *
 * Safe to re-run. Uses the same secret as the running app (TRACKING_SECRET or JWT_SECRET from
 * server/.env), so hashes match those written by new events.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const { hashIp } = await import('../src/services/tracking.service.js');
const TrackingEvent = (await import('../src/models/TrackingEvent.js')).default;

const dryRun = process.argv.includes('--dry-run');
await mongoose.connect(process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/mailpulse');

const filter = { ip: { $type: 'string', $ne: '' } };
const total = await TrackingEvent.countDocuments(filter);
console.log(`${total} event(s) still hold a raw IP address.`);

if (!dryRun && total > 0) {
  let done = 0;
  const cursor = TrackingEvent.find(filter).select('_id ip').lean().cursor();
  let ops = [];
  for await (const doc of cursor) {
    ops.push({
      updateOne: { filter: { _id: doc._id }, update: { $set: { ipHash: hashIp(doc.ip) }, $unset: { ip: '' } } },
    });
    if (ops.length >= 1000) {
      await TrackingEvent.bulkWrite(ops, { ordered: false });
      done += ops.length;
      ops = [];
    }
  }
  if (ops.length > 0) {
    await TrackingEvent.bulkWrite(ops, { ordered: false });
    done += ops.length;
  }
  console.log(`Anonymized ${done} event(s).`);
} else if (dryRun) {
  console.log('Dry run: nothing changed.');
}
await mongoose.disconnect();
