import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { apiClient } from '../src/lib/api.js';
import { getSenderAccounts, disconnectSenderAccount } from '../src/api/senderAccounts.js';
import {
  getSenderStatusInfo,
  getDisconnectSuccessMessage,
  getDisconnectErrorMessage,
  countUsableSenders,
  DISCONNECT_WARNING,
  STATUS_TONE_CLASSES,
} from '../src/utils/senderAccountHelpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const page = fs.readFileSync(path.resolve(__dirname, '../src/pages/settings/SenderAccountsPage.jsx'), 'utf-8');

describe('Sender account status presentation', () => {
  it('connected accounts can send and be disconnected, with no reconnect prompt', () => {
    const info = getSenderStatusInfo({ status: 'active', canSend: true });
    assert.equal(info.label, 'Connected');
    assert.equal(info.needsReconnect, false);
    assert.equal(info.canDisconnect, true);
  });

  it('reauth_required explains the cause, the paused campaigns and the same-account requirement', () => {
    const revoked = getSenderStatusInfo({ status: 'reauth_required', statusReason: 'TOKEN_REVOKED' });
    assert.equal(revoked.label, 'Reconnect required');
    assert.equal(revoked.needsReconnect, true);
    assert.match(revoked.explanation, /removed or expired/);
    assert.match(revoked.explanation, /same Google account/);
    const other = getSenderStatusInfo({ status: 'reauth_required', statusReason: 'SENDER_REAUTH_REQUIRED' });
    assert.match(other.explanation, /resume them yourself/);
    assert.equal(other.canDisconnect, true);
  });

  it('disconnected accounts offer reconnect but not another disconnect', () => {
    const info = getSenderStatusInfo({ status: 'disconnected' });
    assert.equal(info.needsReconnect, true);
    assert.equal(info.canDisconnect, false);
  });

  it('an unknown status is shown neutrally and offers no action', () => {
    const info = getSenderStatusInfo({ status: 'weird' });
    assert.equal(info.label, 'Unknown');
    assert.equal(info.canDisconnect, false);
    assert.equal(getSenderStatusInfo(undefined).label, 'Unknown');
    for (const tone of ['ok', 'warn', 'muted']) assert.ok(STATUS_TONE_CLASSES[tone]);
  });

  it('counts only usable accounts', () => {
    assert.equal(countUsableSenders([{ canSend: true }, { canSend: false }, { canSend: true }]), 2);
    assert.equal(countUsableSenders(null), 0);
  });
});

describe('Sender account disconnect', () => {
  afterEach(() => mock.restoreAll());

  it('POSTs to the account disconnect endpoint', async () => {
    let url;
    mock.method(apiClient, 'post', async (u) => {
      url = u;
      return { data: { data: { senderAccount: { id: 'a1', status: 'disconnected' }, revoked: true } } };
    });
    const result = await disconnectSenderAccount('671234567890abcdef123456');
    assert.equal(url, '/sender-accounts/671234567890abcdef123456/disconnect');
    assert.equal(result.revoked, true);
  });

  it('lists the accounts from the API', async () => {
    mock.method(apiClient, 'get', async () => ({ data: { data: { senderAccounts: [{ id: 'a1', email: 'me@gmail.com' }] } } }));
    assert.equal((await getSenderAccounts()).length, 1);
    mock.method(apiClient, 'get', async () => ({ data: {} }));
    assert.deepEqual(await getSenderAccounts(), []);
  });

  it('warns that campaigns pause and tells whether Google confirmed the revocation', () => {
    assert.match(DISCONNECT_WARNING, /pause/);
    assert.match(DISCONNECT_WARNING, /same account/);
    assert.doesNotMatch(getDisconnectSuccessMessage('me@gmail.com', true), /may still be listed/);
    assert.match(getDisconnectSuccessMessage('me@gmail.com', false), /may still be listed/);
  });

  it('maps disconnect failures to helpful messages', () => {
    assert.match(getDisconnectErrorMessage({ response: { status: 404 } }), /no longer exists/);
    assert.equal(getDisconnectErrorMessage({ response: { status: 500, data: { message: 'Server said no' } } }), 'Server said no');
    assert.match(getDisconnectErrorMessage(new Error('x')), /try again/i);
  });
});

describe('Gmail accounts page', () => {
  it('handles loading, error (with retry), empty and list states', () => {
    assert.match(page, /Loading your accounts/);
    assert.match(page, /Try again/);
    assert.match(page, /No Gmail account is connected yet/);
    assert.match(page, /accounts\.map\(/);
  });

  it('asks for confirmation before disconnecting and refreshes the list afterwards', () => {
    assert.match(page, /role="dialog"/);
    assert.match(page, /pendingDisconnect/);
    assert.match(page, /reload\(\);/);
  });

  it('reconnects through the same connect flow and never touches tokens', () => {
    assert.match(page, />\s*Reconnect\s*</);
    assert.match(page, /onClick=\{handleConnect\}/);
    assert.doesNotMatch(page, /accessToken|refreshToken|encrypted/i);
    assert.doesNotMatch(page, /console\./);
  });
});
