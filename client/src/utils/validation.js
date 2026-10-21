/**
 * Frontend Validation Utilities
 *
 * Enforces client-side validation rules matching backend constraints in auth.validator.js.
 * Guarantees that inputs are validated before dispatching network requests,
 * while preventing passwords from being logged or exposed in error messages.
 */

const EMAIL_REGEX = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)*\.[a-zA-Z]{2,}$/;

/**
 * Validates a user's full name.
 * @param {string} name
 * @returns {string|null} Error message or null if valid
 */
export const validateName = (name) => {
  if (typeof name !== 'string' || !name.trim()) {
    return 'Name is required.';
  }
  const trimmed = name.trim();
  if (trimmed.length < 2) {
    return 'Name must be at least 2 characters long.';
  }
  if (trimmed.length > 100) {
    return 'Name cannot exceed 100 characters.';
  }
  return null;
};

/**
 * Validates an email address format.
 * @param {string} email
 * @returns {string|null} Error message or null if valid
 */
export const validateEmail = (email) => {
  if (typeof email !== 'string' || !email.trim()) {
    return 'Email address is required.';
  }
  const trimmed = email.trim();
  if (!EMAIL_REGEX.test(trimmed)) {
    return 'Please enter a valid email address.';
  }
  return null;
};

/**
 * Validates password complexity and bounds (8-128 characters).
 * @param {string} password
 * @returns {string|null} Error message or null if valid
 */
export const validatePassword = (password) => {
  if (!password || typeof password !== 'string') {
    return 'Password is required.';
  }
  if (password.length < 8) {
    return 'Password must be at least 8 characters long.';
  }
  if (password.length > 128) {
    return 'Password cannot exceed 128 characters.';
  }
  return null;
};

/**
 * Validates that the confirmation password matches the primary password.
 * @param {string} password
 * @param {string} confirmPassword
 * @returns {string|null} Error message or null if valid
 */
export const validateConfirmPassword = (password, confirmPassword) => {
  if (!confirmPassword || typeof confirmPassword !== 'string') {
    return 'Please confirm your password.';
  }
  if (password !== confirmPassword) {
    return 'Passwords do not match.';
  }
  return null;
};

/**
 * Validates the complete registration payload.
 *
 * @param {{ name?: string, email?: string, password?: string, confirmPassword?: string }} data
 * @returns {{ isValid: boolean, errors: Record<string, string> }}
 */
export const validateRegisterForm = ({ name, email, password, confirmPassword }) => {
  const errors = {};

  const nameError = validateName(name);
  if (nameError) errors.name = nameError;

  const emailError = validateEmail(email);
  if (emailError) errors.email = emailError;

  const passwordError = validatePassword(password);
  if (passwordError) errors.password = passwordError;

  const confirmError = validateConfirmPassword(password, confirmPassword);
  if (confirmError) errors.confirmPassword = confirmError;

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
  };
};

/**
 * Validates the complete login payload.
 *
 * @param {{ email?: string, password?: string }} data
 * @returns {{ isValid: boolean, errors: Record<string, string> }}
 */
export const validateLoginForm = ({ email, password }) => {
  const errors = {};

  const emailError = validateEmail(email);
  if (emailError) errors.email = emailError;

  if (!password || typeof password !== 'string') {
    errors.password = 'Password is required.';
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
  };
};

/**
 * Validates a contact's full name.
 * Requires trimmed length between 2 and 100 characters.
 *
 * @param {string} name
 * @returns {string|null} Error message or null if valid
 */
export const validateContactName = (name) => {
  if (typeof name !== 'string' || !name.trim()) {
    return 'Contact name is required.';
  }
  const trimmed = name.trim();
  if (trimmed.length < 2) {
    return 'Contact name must be at least 2 characters long.';
  }
  if (trimmed.length > 100) {
    return 'Contact name cannot exceed 100 characters.';
  }
  return null;
};

/**
 * Validates a contact's email address.
 * Requires trimmed valid email format with maximum 254 characters.
 *
 * @param {string} email
 * @returns {string|null} Error message or null if valid
 */
export const validateContactEmail = (email) => {
  if (typeof email !== 'string' || !email.trim()) {
    return 'Contact email is required.';
  }
  const trimmed = email.trim();
  if (trimmed.length > 254) {
    return 'Contact email cannot exceed 254 characters.';
  }
  if (!EMAIL_REGEX.test(trimmed)) {
    return 'Please enter a valid email address.';
  }
  return null;
};

/**
 * Validates a contact form payload.
 *
 * @param {{ name?: string, email?: string }} data
 * @returns {{ isValid: boolean, errors: Record<string, string> }}
 */
export const validateContactForm = ({ name, email } = {}) => {
  const errors = {};

  const nameError = validateContactName(name);
  if (nameError) errors.name = nameError;

  const emailError = validateContactEmail(email);
  if (emailError) errors.email = emailError;

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
  };
};

const OBJECT_ID_REGEX = /^[0-9a-fA-F]{24}$/;

/**
 * Validates a campaign's name.
 * Requires trimmed length between 2 and 120 characters.
 *
 * @param {string} name
 * @returns {string|null} Error message or null if valid
 */
export const validateCampaignName = (name) => {
  if (typeof name !== 'string' || !name.trim()) {
    return 'Campaign name is required.';
  }
  const trimmed = name.trim();
  if (trimmed.length < 2) {
    return 'Campaign name must be at least 2 characters long.';
  }
  if (trimmed.length > 120) {
    return 'Campaign name cannot exceed 120 characters.';
  }
  return null;
};

/**
 * Validates a campaign's email subject line.
 * Requires trimmed length between 1 and 200 characters.
 *
 * @param {string} subject
 * @returns {string|null} Error message or null if valid
 */
export const validateCampaignSubject = (subject) => {
  if (typeof subject !== 'string' || !subject.trim()) {
    return 'Email subject is required.';
  }
  const trimmed = subject.trim();
  if (trimmed.length < 1) {
    return 'Email subject is required.';
  }
  if (trimmed.length > 200) {
    return 'Email subject cannot exceed 200 characters.';
  }
  return null;
};

/**
 * Validates plain text content length (max 100,000 characters).
 * Empty strings are explicitly valid for draft saving.
 *
 * @param {string} textContent
 * @returns {string|null} Error message or null if valid
 */
export const validateCampaignTextContent = (textContent) => {
  if (textContent === undefined || textContent === null || textContent === '') {
    return null;
  }
  if (typeof textContent !== 'string') {
    return 'Plain text content must be a string.';
  }
  if (textContent.length > 100000) {
    return 'Plain text content cannot exceed 100,000 characters.';
  }
  return null;
};

/**
 * Validates HTML content length (max 500,000 characters).
 * Empty strings are explicitly valid for draft saving.
 *
 * @param {string} htmlContent
 * @returns {string|null} Error message or null if valid
 */
export const validateCampaignHtmlContent = (htmlContent) => {
  if (htmlContent === undefined || htmlContent === null || htmlContent === '') {
    return null;
  }
  if (typeof htmlContent !== 'string') {
    return 'HTML content must be a string.';
  }
  if (htmlContent.length > 500000) {
    return 'HTML content cannot exceed 500,000 characters.';
  }
  return null;
};

/**
 * Validates campaign content (plain text and/or HTML).
 * Supports both an object parameter { textContent, htmlContent } or two string arguments.
 *
 * @param {{ textContent?: string, htmlContent?: string }|string} contentOrText
 * @param {string} [maybeHtml]
 * @returns {{ isValid: boolean, errors: Record<string, string> }}
 */
export const validateCampaignContent = (contentOrText = {}, maybeHtml) => {
  let text;
  let html;

  if (typeof contentOrText === 'object' && contentOrText !== null && !Array.isArray(contentOrText)) {
    text = contentOrText.textContent;
    html = contentOrText.htmlContent;
  } else {
    text = contentOrText;
    html = maybeHtml;
  }

  const errors = {};

  if (text !== undefined) {
    const textError = validateCampaignTextContent(text);
    if (textError) errors.textContent = textError;
  }

  if (html !== undefined) {
    const htmlError = validateCampaignHtmlContent(html);
    if (htmlError) errors.htmlContent = htmlError;
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
  };
};

/**
 * Validates an array of recipient contact IDs.
 * Each recipient ID must be a valid 24-character hexadecimal MongoDB ObjectId string.
 * Empty array is valid (drafts do not require recipients).
 *
 * @param {string[]} recipientIds
 * @returns {string|null} Error message or null if valid
 */
export const validateCampaignRecipients = (recipientIds) => {
  if (recipientIds === undefined || recipientIds === null) {
    return null;
  }

  if (!Array.isArray(recipientIds)) {
    return 'Recipients must be an array of contact IDs.';
  }

  for (let i = 0; i < recipientIds.length; i++) {
    const id = recipientIds[i];
    if (typeof id !== 'string' || !OBJECT_ID_REGEX.test(id.trim())) {
      return 'One or more recipient IDs are invalid.';
    }
  }

  return null;
};

/**
 * Helper to deduplicate an array of recipient IDs while preserving order.
 *
 * @param {string[]} [ids=[]]
 * @returns {string[]}
 */
export const deduplicateRecipientIds = (ids) => {
  if (!Array.isArray(ids)) return [];
  return [...new Set(ids.map((id) => (typeof id === 'string' ? id.trim() : id)))];
};

/**
 * Validates a campaign form payload.
 * Enforces client constraints matching backend campaign.validator.js.
 * Disallows protected fields (status, userId, _id, createdAt, updatedAt, recipientsCount).
 *
 * @param {object} [data={}]
 * @param {object} [options={}]
 * @param {boolean} [options.isUpdate=false]
 * @returns {{ isValid: boolean, errors: Record<string, string> }}
 */
export const validateCampaignForm = (data = {}, { isUpdate = false } = {}) => {
  const errors = {};

  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return {
      isValid: false,
      errors: { _form: 'Invalid form data.' },
    };
  }

  // 1. Reject protected fields
  const PROTECTED_FIELDS = ['status', 'userId', '_id', 'id', 'createdAt', 'updatedAt', 'recipientsCount'];
  for (const field of PROTECTED_FIELDS) {
    if (field in data) {
      errors[field] = `${field} is a protected field and cannot be set.`;
    }
  }

  // 2. Validate Name
  if (!isUpdate || data.name !== undefined) {
    const nameError = validateCampaignName(data.name);
    if (nameError) errors.name = nameError;
  }

  // 3. Validate Subject
  if (!isUpdate || data.subject !== undefined) {
    const subjectError = validateCampaignSubject(data.subject);
    if (subjectError) errors.subject = subjectError;
  }

  // 4. Validate Content
  const contentResult = validateCampaignContent({
    textContent: data.textContent,
    htmlContent: data.htmlContent,
  });
  if (!contentResult.isValid) {
    Object.assign(errors, contentResult.errors);
  }

  // 5. Validate Recipient IDs
  if (data.recipientIds !== undefined) {
    const recipientError = validateCampaignRecipients(data.recipientIds);
    if (recipientError) errors.recipientIds = recipientError;
  }

  // 6. For update: ensure at least one editable field is provided
  if (isUpdate && Object.keys(errors).length === 0) {
    const hasAtLeastOneField =
      data.name !== undefined ||
      data.subject !== undefined ||
      data.textContent !== undefined ||
      data.htmlContent !== undefined ||
      data.recipientIds !== undefined;

    if (!hasAtLeastOneField) {
      errors._form = 'At least one field must be provided for update.';
    }
  }

  return {
    isValid: Object.keys(errors).length === 0,
    errors,
  };
};

export default {
  validateName,
  validateEmail,
  validatePassword,
  validateConfirmPassword,
  validateRegisterForm,
  validateLoginForm,
  validateContactName,
  validateContactEmail,
  validateContactForm,
  validateCampaignName,
  validateCampaignSubject,
  validateCampaignTextContent,
  validateCampaignHtmlContent,
  validateCampaignContent,
  validateCampaignRecipients,
  deduplicateRecipientIds,
  validateCampaignForm,
};
