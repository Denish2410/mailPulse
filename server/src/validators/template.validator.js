import { z } from 'zod';
import mongoose from 'mongoose';

const isValidObjectId = (val) => mongoose.isValidObjectId(val);

const nameField = z
  .string({ required_error: 'Template name is required' })
  .trim()
  .min(2, 'Template name must be at least 2 characters long')
  .max(120, 'Template name cannot exceed 120 characters');
const subjectField = z.string().trim().max(200, 'Template subject cannot exceed 200 characters');
const textField = z.string().max(100000, 'Plain text content cannot exceed 100,000 characters');
const htmlField = z.string().max(500000, 'HTML content cannot exceed 500,000 characters');

export const templateIdParamSchema = z.object({
  params: z
    .object({
      id: z
        .string({ required_error: 'Template ID is required' })
        .refine(isValidObjectId, { message: 'Invalid template ID format' }),
    })
    .strict(),
});

export const createTemplateSchema = z.object({
  body: z
    .object({
      name: nameField,
      subject: subjectField.optional().default(''),
      textContent: textField.optional().default(''),
      htmlContent: htmlField.optional().default(''),
    })
    .strict(),
});

export const updateTemplateSchema = z.object({
  params: templateIdParamSchema.shape.params,
  body: z
    .object({
      name: nameField.optional(),
      subject: subjectField.optional(),
      textContent: textField.optional(),
      htmlContent: htmlField.optional(),
    })
    .strict()
    .refine((body) => Object.keys(body).length > 0, {
      message: 'At least one field must be provided',
    }),
});

export const getTemplatesQuerySchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).optional().default(1),
      limit: z.coerce.number().int().min(1).max(100).optional().default(20),
      search: z.string().trim().max(120).optional(),
    })
    .strict(),
});
