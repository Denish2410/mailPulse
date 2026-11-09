import { z } from 'zod';

const slugParams = z
  .object({ slug: z.string().regex(/^[a-f0-9]{24}$/, 'Invalid form link') })
  .strict();

export const publicFormParamSchema = z.object({ params: slugParams });

export const publicSubscribeSchema = z.object({
  params: slugParams,
  body: z
    .object({
      email: z
        .string({ error: 'Email is required' })
        .trim()
        .toLowerCase()
        .max(254, 'Email cannot exceed 254 characters')
        .email('Please provide a valid email address'),
      name: z.string().trim().max(100, 'Name cannot exceed 100 characters').optional(),
      // Honeypot: real people never see or fill this field
      website: z.string().max(200).optional(),
    })
    .strict(),
});

export const confirmSubscriptionSchema = z.object({
  body: z
    .object({
      token: z.string({ error: 'Token is required' }).regex(/^[a-f0-9]{64}$/, 'Invalid or expired confirmation link.'),
    })
    .strict(),
});
