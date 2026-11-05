import { z } from 'zod';
import mongoose from 'mongoose';
import { normalizeTag, MAX_TAG_LENGTH } from '../utils/tags.js';
import {
  ENGAGEMENT_TYPES,
  MAX_ENGAGEMENT_DAYS,
  MAX_SEGMENT_TAGS,
  normalizeCriteria,
  hasCriteria,
} from '../services/segment.service.js';

const isValidObjectId = (val) => mongoose.isValidObjectId(val);

const tagList = z
  .array(z.string())
  .max(MAX_SEGMENT_TAGS, `At most ${MAX_SEGMENT_TAGS} tags per rule`)
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

const days = z.number().int().min(1).max(MAX_ENGAGEMENT_DAYS);

export const criteriaSchema = z
  .object({
    tagsAny: tagList.optional(),
    tagsAll: tagList.optional(),
    tagsNone: tagList.optional(),
    engagement: z.object({ type: z.enum(ENGAGEMENT_TYPES), days }).strict().optional(),
    createdWithinDays: days.optional(),
  })
  .strict()
  .refine((criteria) => hasCriteria(normalizeCriteria(criteria)), {
    message: 'At least one segment rule is required',
  });

const nameField = z
  .string({ required_error: 'Segment name is required' })
  .trim()
  .min(2, 'Segment name must be at least 2 characters long')
  .max(120, 'Segment name cannot exceed 120 characters');
const descriptionField = z.string().trim().max(500, 'Description cannot exceed 500 characters');

const idParams = z
  .object({
    id: z
      .string({ required_error: 'Segment ID is required' })
      .refine(isValidObjectId, { message: 'Invalid segment ID format' }),
  })
  .strict();

export const segmentIdParamSchema = z.object({ params: idParams });

export const createSegmentSchema = z.object({
  body: z
    .object({
      name: nameField,
      description: descriptionField.optional().default(''),
      criteria: criteriaSchema,
    })
    .strict(),
});

export const updateSegmentSchema = z.object({
  params: idParams,
  body: z
    .object({
      name: nameField.optional(),
      description: descriptionField.optional(),
      criteria: criteriaSchema.optional(),
    })
    .strict()
    .refine((body) => Object.keys(body).length > 0, { message: 'At least one field must be provided' }),
});

export const previewCriteriaSchema = z.object({
  body: z.object({ criteria: criteriaSchema }).strict(),
});

export const getSegmentsQuerySchema = z.object({
  query: z
    .object({
      page: z.coerce.number().int().min(1).optional().default(1),
      limit: z.coerce.number().int().min(1).max(100).optional().default(20),
      search: z.string().trim().max(120).optional(),
    })
    .strict(),
});
