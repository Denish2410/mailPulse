import { z } from 'zod';
import mongoose from 'mongoose';

/** Values Google sends back to the redirect page; bounded, printable, no whitespace. */
const oauthValue = (label, max) =>
  z
    .string({ error: `${label} is required` })
    .min(1, `${label} is required`)
    .max(max, `${label} is too long`)
    .regex(/^[\x21-\x7e]+$/, `${label} is invalid`);

export const googleCallbackSchema = z.object({
  body: z
    .object({
      state: oauthValue('State', 512),
      code: oauthValue('Authorization code', 2048),
    })
    .strict(),
});

export const senderAccountIdParamSchema = z.object({
  params: z
    .object({
      id: z
        .string({ error: 'Sender account ID is required' })
        .refine((val) => mongoose.isValidObjectId(val), { message: 'Invalid sender account ID format' }),
    })
    .strict(),
});
