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

import { normalizeTag, MAX_TAGS_PER_CONTACT, MAX_TAG_LENGTH } from '../utils/tags.js';
import { normalizeCustomFields } from '../utils/customFields.js';

// Custom fields are normalized (lowercase keys, trimmed values, blanks dropped) or rejected
const customFieldsField = z.record(z.string(), z.any()).transform((value, ctx) => {
  const { fields, error } = normalizeCustomFields(value);
  if (error) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: error });
    return z.NEVER;
  }
  return fields;
});

// Tags are normalized (trimmed, lowercased, de-duplicated); invalid tags are rejected, not dropped
const tagsField = z
  .array(z.string(), { error: 'Tags must be an array of strings' })
  .max(MAX_TAGS_PER_CONTACT, `A contact cannot have more than ${MAX_TAGS_PER_CONTACT} tags`)
  .transform((values, ctx) => {
    const result = [];
    for (const value of values) {
      const tag = normalizeTag(value);
      if (!tag) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Tags must be 1-${MAX_TAG_LENGTH} characters: letters, numbers, spaces, hyphens or underscores`,
        });
        return z.NEVER;
      }
      if (!result.includes(tag)) result.push(tag);
    }
    return result;
  });

// Helper to validate MongoDB ObjectId format
const isValidObjectId = (val) => mongoose.isValidObjectId(val);

/**
 * Schema for validating route parameter :id
 */
export const contactIdParamSchema = z.object({
  params: z
    .object({
      id: z
        .string({ error: 'Contact ID is required' })
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
        .string({ error: 'Contact name is required' })
        .trim()
        .min(2, 'Contact name must be at least 2 characters long')
        .max(100, 'Contact name cannot exceed 100 characters'),
      email: z
        .string({ error: 'Contact email is required' })
        .trim()
        .toLowerCase()
        .max(254, 'Contact email cannot exceed 254 characters')
        .email('Please provide a valid email address'),
      tags: tagsField.optional(),
      customFields: customFieldsField.optional(),
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
        .string({ error: 'Contact ID is required' })
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
        .max(254, 'Contact email cannot exceed 254 characters')
        .email('Please provide a valid email address')
        .optional(),
      tags: tagsField.optional(),
      customFields: customFieldsField.optional(),
    })
    .strict()
    .refine(
      (data) =>
        data.name !== undefined ||
        data.email !== undefined ||
        data.tags !== undefined ||
        data.customFields !== undefined,
      { message: 'At least one field (name, email, tags or customFields) must be provided for update' }
    ),
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
        }, z.number({ error: 'Page must be a positive integer' })
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
        }, z.number({ error: 'Limit must be a positive integer' })
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
        }, z.string({ error: 'Search must be a string' })
            .max(100, 'Search term cannot exceed 100 characters')
            .optional()),
      emailDomain: z
        .preprocess((val) => {
          if (val === undefined) return undefined;
          if (typeof val === 'string') {
            return val.trim().toLowerCase();
          }
          return val;
        }, z.string({ error: 'Email domain must be a string' })
            .regex(
              /^(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\.)+[a-zA-Z]{2,}$/,
              'Invalid email domain format'
            )
            .optional()),
      tag: z
        .preprocess((val) => (typeof val === 'string' ? normalizeTag(val) ?? '__invalid__' : val),
          z.string({ error: 'Tag must be a string' }).optional())
        .refine((val) => val !== '__invalid__', { message: 'Invalid tag' }),
    })
    .strict(),
});

/**
 * Schema for POST /api/v1/contacts/import
 * The CSV is sent as text inside JSON (bounded by the 1mb body limit).
 */
export const importContactsSchema = z.object({
  body: z
    .object({
      csv: z
        .string({ error: 'CSV content is required' })
        .min(1, 'CSV content is required')
        .max(900000, 'CSV content is too large'),
    })
    .strict(),
});

/**
 * Schema for GET /api/v1/contacts/export
 */
export const exportContactsSchema = z.object({
  query: z
    .object({
      tag: z
        .preprocess((val) => (typeof val === 'string' ? normalizeTag(val) ?? '__invalid__' : val),
          z.string({ error: 'Tag must be a string' }).optional())
        .refine((val) => val !== '__invalid__', { message: 'Invalid tag' }),
    })
    .strict(),
});

export default {
  exportContactsSchema,
  importContactsSchema,
  contactIdParamSchema,
  createContactSchema,
  updateContactSchema,
  getContactsSchema,
};
