import { z } from 'zod';
import mongoose from 'mongoose';

const SOURCES = ['link', 'one-click-header', 'admin', 'import', 'bounce', 'complaint'];

export const suppressionIdParamSchema = z.object({
  params: z
    .object({
      id: z
        .string({ error: 'Suppression ID is required' })
        .refine((val) => mongoose.isValidObjectId(val), { message: 'Invalid suppression ID format' }),
    })
    .strict(),
});

export const createSuppressionSchema = z.object({
  body: z
    .object({
      email: z
        .string({ error: 'Email is required' })
        .trim()
        .toLowerCase()
        .max(254, 'Email cannot exceed 254 characters')
        .email('Please provide a valid email address'),
      reason: z.string().trim().max(250, 'Reason cannot exceed 250 characters').optional(),
    })
    .strict(),
});

export const getSuppressionsQuerySchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).optional().default(1),
      limit: z.coerce.number().int().min(1).max(100).optional().default(20),
      search: z.string().trim().max(254).optional(),
      source: z.enum(SOURCES).optional(),
    })
    .strict(),
});
