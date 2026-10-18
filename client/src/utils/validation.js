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
};
