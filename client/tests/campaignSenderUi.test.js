import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getSelectableSenders, getSenderLabel, getPausedGuidance } from '../src/utils/senderAccountHelpers.js';
import { validateCampaignForm } from '../src/utils/validation.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => fs.readFileSync(path.resolve(__dirname, '../src', rel), 'utf-8');

const ok = { id: 'a1', email: 'ok@gmail.com', canSend: true, status: 'active' };
const stale = { id: 'a2', email: 'stale@gmail.com', canSend: false, status: 'reauth_required' };
const gone = { id: 'a3', email: 'gone@gmail.com', canSend: false, status: 'disconnected' };

describe('Campaign form: sender choices', () => {
  it('offers only accounts that can send', () => {
    assert.deepEqual(getSelectableSenders([ok, stale, gone]), [ok]);
    assert.deepEqual(getSelectableSenders([stale, gone]), []);
    assert.deepEqual(getSelectableSenders(null), []);
  });

  it('keeps the campaign’s current sender in the list even when it needs reconnecting', () => {
    assert.deepEqual(getSelectableSenders([ok, stale, gone], 'a2'), [ok, stale]);
  });

  it('never picks a sender for the user: the form starts empty; sending is blocked server-side until one is chosen', () => {
    const form = read('components/campaigns/CampaignFormDialog.jsx');
    assert.match(form, /useState\(''\)/);
    assert.match(form, /<option value="">Select a Gmail account…<\/option>/);
    assert.match(form, /required before sending/);
    assert.equal(validateCampaignForm({ name: 'N', subject: 'S', textContent: 'T', senderAccountId: 42 }).isValid, false);
  });

  it('links to the Gmail accounts page when no account can send, and when some need reconnecting', () => {
    const form = read('components/campaigns/CampaignFormDialog.jsx');
    assert.match(form, /No Gmail account is ready to send/);
    assert.match(form, /to="\/settings\/sender-accounts"/);
    assert.match(form, /Accounts that need reconnecting are not listed/);
  });

  it('preserves the existing sender when editing', () => {
    const form = read('components/campaigns/CampaignFormDialog.jsx');
    assert.match(form, /setSenderAccountId\(campaign\.senderAccountId \|\| ''\)/);
    assert.match(form, /getSelectableSenders\(senderAccounts, campaign\?\.senderAccountId \|\| ''\)/);
  });
});

describe('Campaign sender display', () => {
  it('labels a sender, adding its state when it cannot send', () => {
    assert.equal(getSenderLabel(ok), 'ok@gmail.com');
    assert.equal(getSenderLabel(stale), 'stale@gmail.com (reconnect required)');
    assert.equal(getSenderLabel(gone), 'gone@gmail.com (disconnected)');
    assert.equal(getSenderLabel(null), '');
  });

  it('shows the sender in the campaign list and the details dialog', () => {
    assert.match(read('components/campaigns/CampaignsTable.jsx'), /getSenderLabel\(campaign\.sender\)/);
    const preview = read('components/campaigns/CampaignPreviewDialog.jsx');
    assert.match(preview, /Sending from/);
    assert.match(preview, /getSenderLabel\(campaign\.sender\)/);
  });
});

describe('Paused campaign guidance', () => {
  it('tells the owner to reconnect the same account, then resume explicitly', () => {
    const g = getPausedGuidance({ sender: stale });
    assert.equal(g.showAccountsLink, true);
    assert.match(g.steps[0], /Reconnect stale@gmail\.com/);
    assert.match(g.steps[0], /same Google account/);
    assert.match(g.steps[1], /does not resume the campaign by itself/);
  });

  it('when the sender works again, only resume is needed; when it is gone, says it cannot be moved', () => {
    const back = getPausedGuidance({ sender: ok });
    assert.equal(back.showAccountsLink, false);
    assert.match(back.steps[0], /Resume sending/);
    const missing = getPausedGuidance({ sender: null });
    assert.match(missing.steps[0], /cannot be moved/);
    assert.equal(missing.showAccountsLink, true);
  });

  it('the details dialog renders the guidance and a link to the accounts page', () => {
    const preview = read('components/campaigns/CampaignPreviewDialog.jsx');
    assert.match(preview, /getPausedGuidance\(campaign\)/);
    assert.match(preview, /Open Gmail accounts/);
  });
});

describe('Paused-campaign panel is readable and accurate (light theme)', () => {
  const dialog = read('components/campaigns/CampaignPreviewDialog.jsx');
  const panel = dialog.slice(dialog.indexOf('Sending is paused') - 700, dialog.indexOf('Resume sending') + 400);

  it('uses amber shades the theme darkens; orange text shades are not remapped and vanish on the pale tint', () => {
    assert.doesNotMatch(panel, /text-orange-(100|200|300)/);
    assert.match(panel, /text-amber-200/);
    assert.match(panel, /text-amber-300/);
  });

  it('does not tell the owner a paused campaign "has been sent"', () => {
    assert.match(dialog, /effectiveStatus === 'paused'[\s\S]{0,120}paused/);
  });
});

describe('After "Resume sending" the dialog stops showing Paused', () => {
  it('derives the status badge from the same resumed-aware status as the panel', () => {
    const dialog = read('components/campaigns/CampaignPreviewDialog.jsx');
    assert.match(dialog, /getCampaignStatusBadge\([^)]*resumed \? 'sending' : campaign\.status/);
  });
});
