import { z } from 'zod';
import mongoose from 'mongoose';
import { MAX_CAMPAIGN_RECIPIENTS } from '../models/Campaign.js';
import { normalizeTag, MAX_TAG_LENGTH } from '../utils/tags.js';

/**
 * Campaign Request Validation Schemas
 *
 * Implements strict, reusable Zod schemas for campaign management (Phase 4):
 * - campaignIdParamSchema: Validates MongoDB ObjectId route parameter :id.
 * - createCampaignSchema: Validates required name, subject, and optional textContent, htmlContent, recipientIds.
 *   Strictly disallows protected fields (_id, userId, status, timestamps).
 * - updateCampaignSchema: Validates optional fields for partial update and requires at least one field.
 * - getCampaignsQuerySchema: Validates pagination parameters (page, limit), optional search, and status.
 * - sendCampaignSchema: Requires explicit confirmation to send a campaign (Phase 5).
 * - getCampaignDeliveriesSchema: Validates delivery log pagination and status filter (Phase 5).
 */

// Helper to validate MongoDB ObjectId format
const isValidObjectId = (val) => mongoose.isValidObjectId(val);

/**
 * Schema for validating route parameter :id
 */
export const campaignIdParamSchema = z.object({
  params: z
    .object({
      id: z
        .string({ required_error: 'Campaign ID is required' })
        .refine(isValidObjectId, { message: 'Invalid campaign ID format' }),
    })
    .strict(),
});

/**
 * Schema for POST /api/v1/campaigns (Create Campaign Draft)
 */
export const createCampaignSchema = z.object({
  body: z
    .object({
      name: z
        .string({ required_error: 'Campaign name is required' })
        .trim()
        .min(2, 'Campaign name must be at least 2 characters long')
        .max(120, 'Campaign name cannot exceed 120 characters'),
      subject: z
        .string({ required_error: 'Email subject is required' })
        .trim()
        .min(1, 'Email subject cannot be empty')
        .max(200, 'Email subject cannot exceed 200 characters'),
      subjectB: z
        .string()
        .trim()
        .max(200, 'Variant B subject cannot exceed 200 characters')
        .optional()
        .default(''),
      textContent: z
        .string()
        .max(100000, 'Plain text content cannot exceed 100,000 characters')
        .optional()
        .default(''),
      htmlContent: z
        .string()
        .max(500000, 'HTML content cannot exceed 500,000 characters')
        .optional()
        .default(''),
      recipientIds: z
        .array(
          z
            .string({ invalid_type_error: 'Each recipient ID must be a valid string' })
            .refine(isValidObjectId, { message: 'Invalid recipient ID format' })
        )
        .max(
          MAX_CAMPAIGN_RECIPIENTS,
          `A campaign cannot target more than ${MAX_CAMPAIGN_RECIPIENTS} recipients`
        )
        .optional()
        .default([]),
    })
    .strict(),
});

/**
 * Schema for PATCH /api/v1/campaigns/:id (Update Campaign Draft)
 */
export const updateCampaignSchema = z.object({
  params: z
    .object({
      id: z
        .string({ required_error: 'Campaign ID is required' })
        .refine(isValidObjectId, { message: 'Invalid campaign ID format' }),
    })
    .strict(),
  body: z
    .object({
      name: z
        .string()
        .trim()
        .min(2, 'Campaign name must be at least 2 characters long')
        .max(120, 'Campaign name cannot exceed 120 characters')
        .optional(),
      subject: z
        .string()
        .trim()
        .min(1, 'Email subject cannot be empty')
        .max(200, 'Email subject cannot exceed 200 characters')
        .optional(),
      subjectB: z
        .string()
        .trim()
        .max(200, 'Variant B subject cannot exceed 200 characters')
        .optional(),
      textContent: z
        .string()
        .max(100000, 'Plain text content cannot exceed 100,000 characters')
        .optional(),
      htmlContent: z
        .string()
        .max(500000, 'HTML content cannot exceed 500,000 characters')
        .optional(),
      recipientIds: z
        .array(
          z
            .string({ invalid_type_error: 'Each recipient ID must be a valid string' })
            .refine(isValidObjectId, { message: 'Invalid recipient ID format' })
        )
        .max(
          MAX_CAMPAIGN_RECIPIENTS,
          `A campaign cannot target more than ${MAX_CAMPAIGN_RECIPIENTS} recipients`
        )
        .optional(),
    })
    .strict()
    .refine(
      (data) =>
        data.name !== undefined ||
        data.subject !== undefined ||
        data.subjectB !== undefined ||
        data.textContent !== undefined ||
        data.htmlContent !== undefined ||
        data.recipientIds !== undefined,
      {
        message: 'At least one field must be provided for update',
      }
    ),
});

/**
 * Schema for POST /api/v1/campaigns/:id/test-email (Send Campaign Test Email)
 *
 * - The destination is always the authenticated user's own account email, resolved server-side.
 * - An optional `to` may be supplied for explicitness, but the controller rejects it unless it
 *   matches the account email (case-insensitive).
 * - Strict: unknown keys such as `recipients`, `recipientIds`, `cc`, or `bcc` are rejected so
 *   callers cannot attempt to redirect or expand delivery.
 * - An omitted or empty body is accepted.
 */
export const sendTestEmailSchema = z.object({
  params: z
    .object({
      id: z
        .string({ required_error: 'Campaign ID is required' })
        .refine(isValidObjectId, { message: 'Invalid campaign ID format' }),
    })
    .strict(),
  body: z
    .object({
      to: z
        .string({ invalid_type_error: 'Destination email must be a string' })
        .trim()
        .min(1, 'Destination email cannot be empty')
        .max(254, 'Destination email cannot exceed 254 characters')
        .email('Invalid destination email address format')
        .optional(),
    })
    .strict()
    .optional()
    .default({}),
});

/**
 * Schema for GET /api/v1/campaigns (Pagination, Search, Filtering)
 */
export const getCampaignsQuerySchema = z.object({
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
          .int('Page must be an integer')
          .min(1, 'Page must be at least 1')
        ),
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
          .int('Limit must be an integer')
          .min(1, 'Limit must be at least 1')
          .max(100, 'Limit cannot exceed 100')
        ),
      search: z
        .string()
        .max(100, 'Search query cannot exceed 100 characters')
        .optional(),
      status: z
        .enum(['draft', 'scheduled', 'sending', 'sent', 'failed'], {
          errorMap: () => ({ message: 'Status must be one of draft, scheduled, sending, sent, or failed' }),
        })
        .optional(),
    })
    .strict(),
});

/**
 * Schema for POST /api/v1/campaigns/:id/send (Send Campaign to Recipients)
 *
 * - Requires an explicit `{ "confirm": true }` body so a campaign is never sent by an
 *   accidental or replayed bare POST.
 * - Strict: recipients, addresses, or content cannot be supplied here; the server always sends
 *   the stored draft to its stored, owner-verified recipients.
 */
export const sendCampaignSchema = z.object({
  params: z
    .object({
      id: z
        .string({ required_error: 'Campaign ID is required' })
        .refine(isValidObjectId, { message: 'Invalid campaign ID format' }),
    })
    .strict(),
  body: z
    .object({
      confirm: z.literal(true, {
        errorMap: () => ({ message: 'Sending must be explicitly confirmed with confirm: true' }),
      }),
    })
    .strict(),
});

/**
 * Parses a positive integer query parameter, applying a default when omitted.
 */
const positiveIntQuery = (fallback, label, max = Number.MAX_SAFE_INTEGER) =>
  z.preprocess((val) => {
    if (val === undefined) return fallback;
    if (typeof val === 'string') {
      const trimmed = val.trim();
      if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
      return NaN;
    }
    if (typeof val === 'number') return val;
    return NaN;
  }, z.number({ invalid_type_error: `${label} must be a positive integer` })
    .int(`${label} must be an integer`)
    .min(1, `${label} must be at least 1`)
    .max(max, `${label} cannot exceed ${max}`));

/**
 * Schema for GET /api/v1/campaigns/:id/deliveries (Delivery Log)
 */
export const getCampaignDeliveriesSchema = z.object({
  params: z
    .object({
      id: z
        .string({ required_error: 'Campaign ID is required' })
        .refine(isValidObjectId, { message: 'Invalid campaign ID format' }),
    })
    .strict(),
  query: z
    .object({
      page: positiveIntQuery(1, 'Page'),
      limit: positiveIntQuery(20, 'Limit', 100),
      status: z
        .enum(['pending', 'processing', 'sent', 'failed'], {
          errorMap: () => ({
            message: 'Status must be one of pending, processing, sent, or failed',
          }),
        })
        .optional(),
    })
    .strict(),
});

/**
 * Schema for POST /api/v1/campaigns/:id/schedule (Schedule Campaign)
 *
 * Validates params.id and body.scheduledAt.
 * scheduledAt must be a valid ISO 8601 string or parseable date string representing a future time.
 */
export const scheduleCampaignSchema = z.object({
  params: z
    .object({
      id: z
        .string({ required_error: 'Campaign ID is required' })
        .refine(isValidObjectId, { message: 'Invalid campaign ID format' }),
    })
    .strict(),
  body: z
    .object({
      scheduledAt: z
        .string({ required_error: 'scheduledAt is required' })
        .refine((val) => !isNaN(Date.parse(val)), {
          message: 'scheduledAt must be a valid date string',
        })
        .refine((val) => new Date(val).getTime() > Date.now(), {
          message: 'scheduledAt must be a future date and time',
        }),
    })
    .strict(),
});

/**
 * Schema for POST /api/v1/campaigns/:id/audience (Phase 11)
 *
 * Exactly one audience source: a list of tags (contacts having ANY of them) or a saved segment.
 * `mode` 'replace' (default) overwrites the recipient list; 'add' merges into it.
 */
export const applyAudienceSchema = z.object({
  params: z
    .object({
      id: z
        .string({ required_error: 'Campaign ID is required' })
        .refine(isValidObjectId, { message: 'Invalid campaign ID format' }),
    })
    .strict(),
  body: z
    .object({
      tags: z
        .array(z.string())
        .min(1, 'Provide at least one tag')
        .max(20, 'At most 20 tags')
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
        })
        .optional(),
      segmentId: z
        .string()
        .refine(isValidObjectId, { message: 'Invalid segment ID format' })
        .optional(),
      mode: z.enum(['replace', 'add']).optional().default('replace'),
    })
    .strict()
    .refine((body) => (body.tags !== undefined) !== (body.segmentId !== undefined), {
      message: 'Provide exactly one of tags or segmentId',
    }),
});
