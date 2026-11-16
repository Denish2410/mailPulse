import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import mongoose from 'mongoose';

import { MAX_CAMPAIGN_RECIPIENTS } from '../src/models/Campaign.js';
import {
  DISPATCH_MANIFEST_VERSION,
  MAX_MANIFEST_BSON_BYTES,
  MAX_CAMPAIGN_DOCUMENT_BSON_BYTES,
  DispatchManifestError,
  buildDispatchManifest,
  measureBsonBytes,
} from '../src/utils/dispatchManifest.js';

const MONGODB_DOCUMENT_LIMIT_BYTES = 16 * 1024 * 1024;

const contact = (overrides = {}) => ({
  _id: new mongoose.Types.ObjectId(),
  email: `person-${new mongoose.Types.ObjectId().toString()}@example.com`,
  name: 'Person',
  ...overrides,
});

const expectCode = (fn, code) =>
  assert.throws(fn, (error) => {
    assert.ok(error instanceof DispatchManifestError);
    assert.equal(error.code, code);
    return true;
  });

describe('Dispatch manifest builder (no DB)', () => {
  describe('limits', () => {
    it('keeps both size limits far below the MongoDB document limit', () => {
      assert.ok(MAX_MANIFEST_BSON_BYTES <= MONGODB_DOCUMENT_LIMIT_BYTES / 4);
      assert.ok(MAX_CAMPAIGN_DOCUMENT_BSON_BYTES <= MONGODB_DOCUMENT_LIMIT_BYTES / 2);
      assert.ok(MAX_MANIFEST_BSON_BYTES < MAX_CAMPAIGN_DOCUMENT_BSON_BYTES);
    });

    it('the largest legal manifest (max recipients, longest fields, 3-byte characters) fits the limit', () => {
      const longName = '中'.repeat(100); // 100 UTF-16 units, 3 UTF-8 bytes each
      const contacts = Array.from({ length: MAX_CAMPAIGN_RECIPIENTS }, (_, i) => {
        const local = `${String(i).padStart(6, '0')}${'a'.repeat(58)}`; // 64 characters
        const email = `${local}@${'b'.repeat(185)}.com`; // 64 + 1 + 185 + 4 = 254
        assert.equal(email.length, 254);
        return contact({ email, name: longName });
      });
      const manifest = buildDispatchManifest(contacts);
      assert.equal(manifest.count, MAX_CAMPAIGN_RECIPIENTS);
      assert.ok(manifest.bytes <= MAX_MANIFEST_BSON_BYTES, `measured ${manifest.bytes} bytes`);
    });

    it('rejects more recipients than a campaign may have', () => {
      const contacts = Array.from({ length: MAX_CAMPAIGN_RECIPIENTS + 1 }, () => contact());
      expectCode(() => buildDispatchManifest(contacts), 'TOO_MANY_RECIPIENTS');
    });

    it('rejects a manifest over the measured size limit', () => {
      const contacts = Array.from({ length: 10 }, () => contact());
      const { bytes } = buildDispatchManifest(contacts);
      expectCode(() => buildDispatchManifest(contacts, { maxManifestBytes: bytes - 1 }), 'MANIFEST_TOO_LARGE');
      assert.equal(buildDispatchManifest(contacts, { maxManifestBytes: bytes }).bytes, bytes);
    });

    it('rejects a manifest that would push the campaign document over its limit', () => {
      const contacts = [contact(), contact()];
      const { bytes } = buildDispatchManifest(contacts);
      const campaignDocumentBytes = MAX_CAMPAIGN_DOCUMENT_BSON_BYTES - bytes + 1;
      expectCode(() => buildDispatchManifest(contacts, { campaignDocumentBytes }), 'DOCUMENT_TOO_LARGE');
      assert.equal(
        buildDispatchManifest(contacts, { campaignDocumentBytes: campaignDocumentBytes - 1 }).count,
        2
      );
    });

    it('options can lower a limit but never raise it above the hard cap', () => {
      const contacts = Array.from({ length: 3 }, () => contact());
      expectCode(() => buildDispatchManifest(contacts, { maxRecipients: 2 }), 'TOO_MANY_RECIPIENTS');
      const tooMany = Array.from({ length: MAX_CAMPAIGN_RECIPIENTS + 1 }, () => contact());
      expectCode(
        () => buildDispatchManifest(tooMany, { maxRecipients: MAX_CAMPAIGN_RECIPIENTS * 10 }),
        'TOO_MANY_RECIPIENTS'
      );
      expectCode(
        () =>
          buildDispatchManifest(contacts, {
            campaignDocumentBytes: MAX_CAMPAIGN_DOCUMENT_BSON_BYTES,
            maxDocumentBytes: MONGODB_DOCUMENT_LIMIT_BYTES * 4,
          }),
        'DOCUMENT_TOO_LARGE'
      );
    });

    it('reports the exact BSON size of the embedded field', () => {
      const manifest = buildDispatchManifest([contact(), contact({ name: 'Zoë' })]);
      assert.equal(manifest.bytes, measureBsonBytes({ dispatchManifest: manifest.entries }));
    });
  });

  describe('entries', () => {
    it('stores contact id, normalized email and name under short keys, with version and count', () => {
      const id = new mongoose.Types.ObjectId();
      const manifest = buildDispatchManifest([{ _id: id, email: '  Ada@Example.COM ', name: '  Ada Lovelace  ' }]);
      assert.equal(manifest.version, DISPATCH_MANIFEST_VERSION);
      assert.equal(manifest.count, 1);
      assert.deepEqual(Object.keys(manifest.entries[0]), ['c', 'e', 'n']);
      assert.ok(manifest.entries[0].c.equals(id));
      assert.equal(manifest.entries[0].e, 'ada@example.com');
      assert.equal(manifest.entries[0].n, 'Ada Lovelace');
    });

    it('accepts a 24-character hex contact id and stores it as an ObjectId', () => {
      const id = new mongoose.Types.ObjectId();
      const manifest = buildDispatchManifest([{ _id: id.toString(), email: 'a@example.com', name: 'A' }]);
      assert.ok(manifest.entries[0].c instanceof mongoose.Types.ObjectId);
      assert.ok(manifest.entries[0].c.equals(id));
    });

    it('truncates names to 100 characters and treats a missing name as empty', () => {
      const manifest = buildDispatchManifest([
        contact({ name: 'x'.repeat(150) }),
        contact({ name: undefined }),
        contact({ name: 42 }),
      ]);
      assert.equal(manifest.entries[0].n.length, 100);
      assert.equal(manifest.entries[1].n, '');
      assert.equal(manifest.entries[2].n, '');
    });

    it('keeps names and emails that begin with "$" as literal text', () => {
      const manifest = buildDispatchManifest([contact({ name: '$name', email: '$money@example.com' })]);
      assert.equal(manifest.entries[0].n, '$name');
      assert.equal(manifest.entries[0].e, '$money@example.com');
    });

    it('preserves the order of the eligible contacts', () => {
      const contacts = Array.from({ length: 5 }, () => contact());
      const manifest = buildDispatchManifest(contacts);
      assert.deepEqual(
        manifest.entries.map((entry) => entry.c.toString()),
        contacts.map((c) => c._id.toString())
      );
    });

    it('is immutable: the manifest, its entry list and every entry are frozen', () => {
      const manifest = buildDispatchManifest([contact(), contact()]);
      assert.ok(Object.isFrozen(manifest));
      assert.ok(Object.isFrozen(manifest.entries));
      assert.ok(manifest.entries.every((entry) => Object.isFrozen(entry)));
      assert.throws(() => manifest.entries.push({}), TypeError);
      assert.throws(() => {
        manifest.entries[0].e = 'other@example.com';
      }, TypeError);
    });
  });

  describe('fail-closed validation', () => {
    it('rejects input that is not a list, and an empty list', () => {
      expectCode(() => buildDispatchManifest(null), 'INVALID_INPUT');
      expectCode(() => buildDispatchManifest({ length: 1 }), 'INVALID_INPUT');
      expectCode(() => buildDispatchManifest([]), 'EMPTY');
    });

    it('rejects entries without a valid contact id', () => {
      expectCode(() => buildDispatchManifest([contact({ _id: undefined })]), 'INVALID_ENTRY');
      expectCode(() => buildDispatchManifest([contact({ _id: 'not-an-id' })]), 'INVALID_ENTRY');
      expectCode(() => buildDispatchManifest([contact({ _id: 12345 })]), 'INVALID_ENTRY');
      expectCode(() => buildDispatchManifest([null]), 'INVALID_ENTRY');
    });

    it('rejects entries without a usable email address', () => {
      expectCode(() => buildDispatchManifest([contact({ email: '' })]), 'INVALID_ENTRY');
      expectCode(() => buildDispatchManifest([contact({ email: '   ' })]), 'INVALID_ENTRY');
      expectCode(() => buildDispatchManifest([contact({ email: undefined })]), 'INVALID_ENTRY');
      expectCode(() => buildDispatchManifest([contact({ email: `${'a'.repeat(250)}@x.co` })]), 'INVALID_ENTRY');
    });

    it('rejects the same contact appearing twice, whatever form its id takes', () => {
      const id = new mongoose.Types.ObjectId();
      expectCode(
        () =>
          buildDispatchManifest([
            { _id: id, email: 'a@example.com', name: 'A' },
            { _id: id.toString(), email: 'b@example.com', name: 'B' },
          ]),
        'DUPLICATE_RECIPIENT'
      );
    });

    it('rejects an invalid campaign document size', () => {
      expectCode(() => buildDispatchManifest([contact()], { campaignDocumentBytes: -1 }), 'INVALID_INPUT');
      expectCode(() => buildDispatchManifest([contact()], { campaignDocumentBytes: 1.5 }), 'INVALID_INPUT');
    });

    it('never puts a recipient name or address in an error message', () => {
      try {
        buildDispatchManifest([contact({ name: 'Secret Name', email: `${'s'.repeat(250)}@secret.example` })]);
        assert.fail('expected a DispatchManifestError');
      } catch (error) {
        assert.ok(error instanceof DispatchManifestError);
        assert.ok(!/secret/i.test(error.message));
      }
    });
  });
});
