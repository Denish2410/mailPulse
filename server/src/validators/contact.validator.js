import { z } from 'zod';
import mongoose from 'mongoose';

/**
 * Contact Request Validation Schemas
 *
 * Implements strict, reusable Zod schemas for contact management:
 * - createContactSchema: Validates required name and email; strictly rejects unexpected fields.
 * - updateContactSchema: Validates contact ID parameter and optional name/email fields;
 *   strictly disallows protected fields (_id, userId, timestamps) and requires at least one field.
 * - contactIdParamSchema: Validates that the route parameter is a valid 24-hex-character MongoDB ObjectId.
 */

// Helper to validate MongoDB ObjectId format
const isValidObjectId = (val) => mongoose.isValidObjectId(val);

/**
 * Schema for validating route parameter :id
 */
export const contactIdParamSchema = z.object({
  params: z
    .object({
      id: z
        .string({ required_error: 'Contact ID is required' })
        .refine(isValidObjectId, { message: 'Invalid contact ID format' }),
    })
    .strict(),
});

/**
 * Schema for POST /api/v1/contacts
 */
export const createContactSchema = z.object({
  body: z
    .object({
      name: z
        .string({ required_error: 'Contact name is required' })
        .trim()
        .min(2, 'Contact name must be at least 2 characters long')
        .max(100, 'Contact name cannot exceed 100 characters'),
      email: z
        .string({ required_error: 'Contact email is required' })
        .trim()
        .toLowerCase()
        .email('Please provide a valid email address'),
    })
    .strict(),
});

/**
 * Schema for PATCH /api/v1/contacts/:id
 */
export const updateContactSchema = z.object({
  params: z
    .object({
      id: z
        .string({ required_error: 'Contact ID is required' })
        .refine(isValidObjectId, { message: 'Invalid contact ID format' }),
    })
    .strict(),
  body: z
    .object({
      name: z
        .string()
        .trim()
        .min(2, 'Contact name must be at least 2 characters long')
        .max(100, 'Contact name cannot exceed 100 characters')
        .optional(),
      email: z
        .string()
        .trim()
        .toLowerCase()
        .email('Please provide a valid email address')
        .optional(),
    })
    .strict()
    .refine((data) => data.name !== undefined || data.email !== undefined, {
      message: 'At least one field (name or email) must be provided for update',
    }),
});

/**
 * Schema for GET /api/v1/contacts (Pagination, Search, Filtering)
 */
export const getContactsSchema = z.object({
  query: z
    .object({
      page: z
        .preprocess((val) => {
          if (val === undefined) return 1;
          if (typeof val === 'string') {
            const trimmed = val.trim();
            if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
            return NaN;
          }
          if (typeof val === 'number') return val;
          return NaN;
        }, z.number({ invalid_type_error: 'Page must be a positive integer' })
            .int('Page must be a positive integer')
            .min(1, 'Page must be a positive integer'))
        .default(1),
      limit: z
        .preprocess((val) => {
          if (val === undefined) return 20;
          if (typeof val === 'string') {
            const trimmed = val.trim();
            if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
            return NaN;
          }
          if (typeof val === 'number') return val;
          return NaN;
        }, z.number({ invalid_type_error: 'Limit must be a positive integer' })
            .int('Limit must be a positive integer')
            .min(1, 'Limit must be a positive integer')
            .max(100, 'Limit cannot exceed 100'))
        .default(20),
      search: z
        .preprocess((val) => {
          if (val === undefined) return undefined;
          if (typeof val === 'string' || typeof val === 'number') {
            const str = String(val).trim();
            return str.length > 0 ? str : undefined;
          }
          return val;
        }, z.string({ invalid_type_error: 'Search must be a string' })
            .max(100, 'Search term cannot exceed 100 characters')
            .optional()),
      emailDomain: z
        .preprocess((val) => {
          if (val === undefined) return undefined;
          if (typeof val === 'string') {
            return val.trim().toLowerCase();
          }
          return val;
        }, z.string({ invalid_type_error: 'Email domain must be a string' })
            .regex(
              /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/,
              'Invalid email domain format'
            )
            .optional()),
    })
    .strict(),
});

export default {
  contactIdParamSchema,
  createContactSchema,
  updateContactSchema,
  getContactsSchema,
};
