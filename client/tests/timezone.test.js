import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  zonedLocalToUtcMs,
  zonedInputToFutureIso,
  formatInTimeZone,
  isValidTimeZone,
  getTimeZoneOptions,
} from '../src/utils/timezone.js';

const iso = (value, zone) => new Date(zonedLocalToUtcMs(value, zone)).toISOString();

describe('Timezone scheduling helpers', () => {
  it('converts wall-clock time in a zone to the right UTC instant', () => {
    assert.equal(iso('2026-11-09T09:00', 'UTC'), '2026-11-09T09:00:00.000Z');
    assert.equal(iso('2026-11-09T09:00', 'Asia/Kolkata'), '2026-11-09T03:30:00.000Z');
    assert.equal(iso('2026-11-09T09:00', 'America/New_York'), '2026-11-09T14:00:00.000Z'); // EST
    assert.equal(iso('2026-07-09T09:00', 'America/New_York'), '2026-07-09T13:00:00.000Z'); // EDT
    assert.equal(iso('2026-11-09T09:00', 'Australia/Sydney'), '2026-11-08T22:00:00.000Z');
  });

  it('rejects times that do not exist in the zone (DST gap) and bad dates', () => {
    // US clocks jump 02:00 -> 03:00 on 2026-03-08
    assert.equal(zonedLocalToUtcMs('2026-03-08T02:30', 'America/New_York'), null);
    assert.equal(zonedLocalToUtcMs('2026-02-31T10:00', 'UTC'), null);
  });

  it('resolves an ambiguous (repeated) hour to a valid instant', () => {
    // US clocks fall back 02:00 -> 01:00 on 2026-11-01, so 01:30 happens twice
    const ms = zonedLocalToUtcMs('2026-11-01T01:30', 'America/New_York');
    assert.ok(ms !== null);
    assert.match(formatInTimeZone(ms, 'America/New_York'), /1:30 AM/);
  });

  it('rejects malformed input and unknown zones', () => {
    assert.equal(zonedLocalToUtcMs('', 'UTC'), null);
    assert.equal(zonedLocalToUtcMs('tomorrow', 'UTC'), null);
    assert.equal(zonedLocalToUtcMs('2026-11-09T09:00', 'Mars/Olympus'), null);
    assert.equal(isValidTimeZone('Mars/Olympus'), false);
    assert.equal(isValidTimeZone('Europe/Paris'), true);
  });

  it('only returns an ISO string for times strictly in the future', () => {
    const now = Date.parse('2026-11-09T00:00:00Z');
    assert.equal(zonedInputToFutureIso('2026-11-09T09:00', 'UTC', now), '2026-11-09T09:00:00.000Z');
    // 09:00 in Kolkata is 03:30 UTC, still future; 04:00 in Tokyo is 19:00 UTC the day before
    assert.ok(zonedInputToFutureIso('2026-11-09T09:00', 'Asia/Kolkata', now));
    assert.equal(zonedInputToFutureIso('2026-11-09T04:00', 'Asia/Tokyo', now), null);
  });

  it('formats an instant in a chosen zone', () => {
    assert.match(formatInTimeZone('2026-11-09T03:30:00Z', 'Asia/Kolkata'), /9:00 AM/);
    assert.equal(formatInTimeZone('garbage', 'UTC'), '');
  });

  it('lists the browser zone first without duplicates', () => {
    const options = getTimeZoneOptions('Europe/Paris');
    assert.equal(options[0], 'Europe/Paris');
    assert.equal(options.filter((z) => z === 'Europe/Paris').length, 1);
    assert.ok(options.includes('UTC'));
  });
});
