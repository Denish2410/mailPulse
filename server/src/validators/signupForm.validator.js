import { z } from 'zod';
import mongoose from 'mongoose';
import { normalizeTag, MAX_TAGS_PER_CONTACT, MAX_TAG_LENGTH } from '../utils/tags.js';

const tagList = z
  .array(z.string())
  .max(MAX_TAGS_PER_CONTACT, `At most ${MAX_TAGS_PER_CONTACT} tags`)
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

const nameField = z
  .string({ error: 'Form name is required' })
  .trim()
  .min(2, 'Form name must be at least 2 characters long')
  .max(120, 'Form name cannot exceed 120 characters');
const descriptionField = z.string().trim().max(300, 'Description cannot exceed 300 characters');

const idParams = z
  .object({
    id: z
      .string({ error: 'Form ID is required' })
      .refine((val) => mongoose.isValidObjectId(val), { message: 'Invalid form ID format' }),
  })
  .strict();

export const signupFormIdParamSchema = z.object({ params: idParams });

export const createSignupFormSchema = z.object({
  body: z
    .object({
      name: nameField,
      description: descriptionField.optional().default(''),
      tags: tagList.optional().default([]),
      enabled: z.boolean().optional().default(true),
    })
    .strict(),
});

export const updateSignupFormSchema = z.object({
  params: idParams,
  body: z
    .object({
      name: nameField.optional(),
      description: descriptionField.optional(),
      tags: tagList.optional(),
      enabled: z.boolean().optional(),
    })
    .strict()
    .refine((body) => Object.keys(body).length > 0, { message: 'At least one field must be provided' }),
});
