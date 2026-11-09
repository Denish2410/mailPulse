import { z } from 'zod';

/**
 * Authentication Request Validation Schemas
 *
 * Implements strict, reusable Zod schemas for user registration and login.
 * - Enforces name length constraints (2-100 characters) matching the User model.
 * - Normalizes and trims email strings, validating standard email formats.
 * - Enforces minimum 8-character and maximum 128-character password length for registration.
 *   The 128-character limit prevents CPU/memory exhaustion DoS attacks against Argon2id
 *   without silently truncating submitted passwords.
 */

export const registerSchema = z.object({
  body: z.object({
    name: z
      .string({ error: 'Name is required' })
      .trim()
      .min(2, 'Name must be at least 2 characters long')
      .max(100, 'Name cannot exceed 100 characters'),
    email: z
      .string({ error: 'Email is required' })
      .trim()
      .toLowerCase()
      .email('Please provide a valid email address'),
    password: z
      .string({ error: 'Password is required' })
      .min(8, 'Password must be at least 8 characters long')
      .max(128, 'Password cannot exceed 128 characters'),
  }),
});

export const loginSchema = z.object({
  body: z.object({
    email: z
      .string({ error: 'Email is required' })
      .trim()
      .toLowerCase()
      .email('Please provide a valid email address'),
    password: z
      .string({ error: 'Password is required' })
      .min(1, 'Password is required')
      .max(128, 'Password cannot exceed 128 characters'),
  }),
});

export const forgotPasswordSchema = z.object({
  body: z
    .object({
      email: z
        .string({ error: 'Email is required' })
        .trim()
        .toLowerCase()
        .email('Please provide a valid email address'),
    })
    .strict(),
});

export const resetPasswordSchema = z.object({
  body: z
    .object({
      token: z
        .string({ error: 'Reset token is required' })
        .regex(/^[a-f0-9]{64}$/, 'Invalid or expired reset link.'),
      password: z
        .string({ error: 'Password is required' })
        .min(8, 'Password must be at least 8 characters long')
        .max(128, 'Password cannot exceed 128 characters'),
    })
    .strict(),
});

export const verifyEmailSchema = z.object({
  body: z
    .object({
      token: z
        .string({ error: 'Verification token is required' })
        .regex(/^[a-f0-9]{64}$/, 'Invalid or expired verification link.'),
    })
    .strict(),
});

export const updateProfileSchema = z.object({
  body: z
    .object({
      name: z
        .string()
        .trim()
        .min(2, 'Name must be at least 2 characters long')
        .max(100, 'Name cannot exceed 100 characters')
        .optional(),
      mailingAddress: z
        .string()
        .trim()
        .max(300, 'Mailing address cannot exceed 300 characters')
        .optional(),
    })
    .strict()
    .refine((data) => data.name !== undefined || data.mailingAddress !== undefined, {
      message: 'At least one field must be provided for update',
    }),
});

export const deleteAccountSchema = z.object({
  body: z
    .object({
      password: z.string({ error: 'Password is required' }).min(1, 'Password is required').max(128),
    })
    .strict(),
});

export default {
  updateProfileSchema,
  deleteAccountSchema,
  verifyEmailSchema,
  forgotPasswordSchema,
  resetPasswordSchema,
  registerSchema,
  loginSchema,
};
