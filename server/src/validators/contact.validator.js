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

export default {
  contactIdParamSchema,
  createContactSchema,
  updateContactSchema,
};
