/**
 * Test helper: the three dispatch-manifest fields for a campaign that is seeded directly in
 * 'sending' (as if the send lock had already run), built with the real manifest builder.
 */
import { buildDispatchManifest } from '../../src/utils/dispatchManifest.js';

/**
 * @param {Array<{ _id: any, email: string, name?: string }>} contacts - The campaign's recipients
 * @returns {{ dispatchManifestVersion: number, dispatchManifestCount: number, dispatchManifest: object[] }}
 */
export const manifestFieldsFor = (contacts) => {
  const manifest = buildDispatchManifest(
    contacts.map((contact) => ({ _id: contact._id, email: contact.email, name: contact.name }))
  );
  return {
    dispatchManifestVersion: manifest.version,
    dispatchManifestCount: manifest.count,
    dispatchManifest: manifest.entries.map((entry) => ({ ...entry })),
  };
};

export default { manifestFieldsFor };
