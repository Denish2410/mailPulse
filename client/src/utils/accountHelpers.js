/**
 * Helpers for the Account settings page.
 */

export const MAX_MAILING_ADDRESS_LENGTH = 300;

/**
 * Validates the profile form. Only the fields present are checked.
 *
 * @param {{ name?: string, mailingAddress?: string }} values
 * @returns {{ isValid: boolean, errors: Record<string, string> }}
 */
export const validateProfileForm = ({ name, mailingAddress } = {}) => {
  const errors = {};
  if (name !== undefined) {
    const trimmed = String(name).trim();
    if (trimmed.length < 2) errors.name = 'Name must be at least 2 characters.';
    else if (trimmed.length > 100) errors.name = 'Name cannot exceed 100 characters.';
  }
  if (mailingAddress !== undefined && String(mailingAddress).trim().length > MAX_MAILING_ADDRESS_LENGTH) {
    errors.mailingAddress = `Mailing address cannot exceed ${MAX_MAILING_ADDRESS_LENGTH} characters.`;
  }
  return { isValid: Object.keys(errors).length === 0, errors };
};

/**
 * Friendly message for a failed account-deletion request.
 *
 * @param {unknown} error
 * @returns {string}
 */
export const getDeleteAccountErrorMessage = (error) => {
  const status = error?.response?.status;
  const serverMessage = error?.response?.data?.message;
  if (status === 403) return 'That password is not correct.';
  if (status === 409 && typeof serverMessage === 'string') return serverMessage;
  if (status === 429) return 'Too many attempts. Please wait a few minutes and try again.';
  return 'Could not delete the account. Please try again.';
};

/**
 * File name for the downloaded data export, e.g. mailpulse-export-2026-11-09.json.
 *
 * @param {Date} [date]
 * @returns {string}
 */
export const getExportFileName = (date = new Date()) =>
  `mailpulse-export-${date.toISOString().slice(0, 10)}.json`;
