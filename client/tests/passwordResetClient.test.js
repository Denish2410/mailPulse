import { describe, it, mock, afterEach } from 'node:test';
import assert from 'node:assert/strict';

import { apiClient } from '../src/lib/api.js';
import { requestPasswordReset, resetPassword } from '../src/api/auth.js';
import { validateForgotPasswordForm, validateResetPasswordForm } from '../src/utils/validation.js';

describe('Password reset client', () => {
  afterEach(() => mock.restoreAll());

  it('requests a reset without attaching auth', async () => {
    let captured;
    mock.method(apiClient, 'post', async (url, body, config) => {
      captured = { url, body, config };
      return { data: { success: true, message: 'sent' } };
    });
    const res = await requestPasswordReset({ email: '  a@b.co ' });
    assert.equal(captured.url, '/auth/forgot-password');
    assert.deepEqual(captured.body, { email: 'a@b.co' });
    assert.equal(captured.config.skipAuth, true);
    assert.equal(res.success, true);
  });

  it('submits the token and new password', async () => {
    let captured;
    mock.method(apiClient, 'post', async (url, body, config) => {
      captured = { url, body, config };
      return { data: { success: true } };
    });
    await resetPassword({ token: 'a'.repeat(64), password: 'NewPassword123!' });
    assert.equal(captured.url, '/auth/reset-password');
    assert.deepEqual(captured.body, { token: 'a'.repeat(64), password: 'NewPassword123!' });
    assert.equal(captured.config.skipAuth, true);
  });
});

describe('Password reset validation', () => {
  it('validates the forgot-password form', () => {
    assert.equal(validateForgotPasswordForm({ email: 'a@b.co' }).isValid, true);
    assert.ok(validateForgotPasswordForm({ email: '' }).errors.email);
    assert.ok(validateForgotPasswordForm({ email: 'nope' }).errors.email);
    assert.equal(validateForgotPasswordForm().isValid, false);
  });

  it('validates the reset form', () => {
    assert.equal(validateResetPasswordForm({ password: 'LongEnough1', confirmPassword: 'LongEnough1' }).isValid, true);
    assert.ok(validateResetPasswordForm({ password: 'short', confirmPassword: 'short' }).errors.password);
    assert.ok(validateResetPasswordForm({ password: 'LongEnough1', confirmPassword: 'Different1' }).errors.confirmPassword);
    assert.equal(validateResetPasswordForm().isValid, false);
  });
});

describe('Email verification client', () => {
  afterEach(() => mock.restoreAll());

  it('verifies with a token and no auth header', async () => {
    let captured;
    mock.method(apiClient, 'post', async (url, body, config) => {
      captured = { url, body, config };
      return { data: { success: true } };
    });
    const { verifyEmail } = await import('../src/api/auth.js');
    await verifyEmail({ token: 'a'.repeat(64) });
    assert.equal(captured.url, '/auth/verify-email');
    assert.deepEqual(captured.body, { token: 'a'.repeat(64) });
    assert.equal(captured.config.skipAuth, true);
  });

  it('resends using the signed-in session', async () => {
    let captured;
    mock.method(apiClient, 'post', async (url, body, config) => {
      captured = { url, body, config };
      return { data: { data: { emailVerified: false } } };
    });
    const { resendVerificationEmail } = await import('../src/api/auth.js');
    const result = await resendVerificationEmail();
    assert.equal(captured.url, '/auth/resend-verification');
    assert.equal(captured.config?.skipAuth, undefined);
    assert.deepEqual(result, { emailVerified: false });
  });
});
