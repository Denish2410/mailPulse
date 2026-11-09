/**
 * Password strength policy (applied when a password is CREATED: registration and reset; never at
 * login, so existing accounts can still sign in).
 *
 * Length is still the main rule (8-128, enforced by the schemas). On top of it this rejects the
 * passwords attackers try first: extremely repetitive ones, simple runs like 12345678 or abcdefgh,
 * a list of the most common passwords, and passwords built from the account's own email name.
 * It deliberately avoids arbitrary composition rules (must contain a symbol...), which push
 * people toward predictable patterns.
 *
 * KEEP IN SYNC with client/src/utils/passwordPolicy.js (shown as live feedback in the forms).
 */

const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password12', 'password123', 'passw0rd', 'p@ssw0rd', 'p@ssword',
  '12345678', '123456789', '1234567890', '11111111', '00000000', '87654321', '12341234', '123123123',
  'qwertyui', 'qwerty123', 'qwertyuiop', 'asdfghjk', 'asdfghjkl', 'zxcvbnm1', '1q2w3e4r', '1qaz2wsx',
  'iloveyou', 'letmein1', 'welcome1', 'welcome123', 'admin123', 'administrator', 'changeme', 'changeme1',
  'abc12345', 'abcd1234', 'monkey123', 'dragon123', 'football1', 'baseball1', 'superman1', 'trustno1',
  'mailpulse', 'mailpulse1', 'mailpulse123', 'mailpulse!', 'campaign1', 'newsletter',
]);

const MIN_DISTINCT_CHARACTERS = 4;

/** True for runs where every character is the previous code point +1 or -1 (12345678, abcdefgh). */
const isSimpleRun = (value) => {
  if (value.length < 6) return false;
  let step = null;
  for (let i = 1; i < value.length; i += 1) {
    const diff = value.charCodeAt(i) - value.charCodeAt(i - 1);
    if (diff !== 1 && diff !== -1) return false;
    if (step === null) step = diff;
    else if (diff !== step) return false;
  }
  return true;
};

/**
 * @param {string} password
 * @param {{ email?: string }} [context]
 * @returns {string|null} A message for the user, or null when the password is acceptable
 */
export const getPasswordWeakness = (password, { email } = {}) => {
  if (typeof password !== 'string') return null; // other rules report missing/invalid types
  const lower = password.toLowerCase();

  if (new Set(password).size < MIN_DISTINCT_CHARACTERS) {
    return 'Password is too repetitive. Use a mix of different characters.';
  }
  if (isSimpleRun(lower)) {
    return 'Password is too simple (a run of characters like 12345678 or abcdefgh).';
  }
  if (COMMON_PASSWORDS.has(lower)) {
    return 'Password is too common. Choose something less guessable.';
  }
  const local = typeof email === 'string' ? email.split('@')[0].toLowerCase() : '';
  if (local.length >= 4 && lower.includes(local)) {
    return 'Password must not contain your email name.';
  }
  return null;
};
