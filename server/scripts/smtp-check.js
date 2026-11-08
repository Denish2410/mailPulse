#!/usr/bin/env node
/**
 * Real-provider smoke test for the SMTP configuration in server/.env.
 *
 *   npm run smtp:check                      # connect + authenticate only, sends nothing
 *   npm run smtp:check -- --to you@x.com    # also send ONE plain test message
 *
 * Automated tests never use real SMTP; run this by hand before going live.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { getSmtpConfig, createSmtpTransport, isSmtpConfigured } from '../src/services/email.service.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const args = process.argv.slice(2);
const toIndex = args.indexOf('--to');
const recipient = toIndex !== -1 ? args[toIndex + 1] : null;

const fail = (message) => {
  console.error(`FAIL  ${message}`);
  process.exit(1);
};

if (toIndex !== -1 && (!recipient || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(recipient))) {
  fail('--to needs a valid email address.');
}
if (!isSmtpConfigured()) fail('SMTP_HOST is not set in server/.env.');

let config;
try {
  config = getSmtpConfig();
} catch (error) {
  fail(error.message);
}

console.log(`SMTP ${config.host}:${config.port} (secure=${config.secure}, auth=${config.auth ? 'yes' : 'no'}), from "${config.from}"`);

const transport = createSmtpTransport(config);
try {
  await transport.verify();
  console.log('OK    Connected and (if configured) authenticated.');
} catch (error) {
  fail(`Could not connect or authenticate: ${error.message}`);
}

if (recipient) {
  try {
    const info = await transport.sendMail({
      from: config.from,
      to: recipient,
      subject: 'MailPulse SMTP check',
      text: 'This message confirms your MailPulse SMTP settings work.',
    });
    console.log(`OK    Sent test message to ${recipient} (id ${info.messageId}). Check the inbox AND spam folder.`);
  } catch (error) {
    fail(`Connected, but sending failed: ${error.message}`);
  }
} else {
  console.log('Skipped sending (pass --to you@example.com to send one test message).');
}
transport.close();
