import SignupForm from '../models/SignupForm.js';
import PendingSubscription, { PENDING_TTL_MS, RESEND_COOLDOWN_MS } from '../models/PendingSubscription.js';
import Contact from '../models/Contact.js';
import Suppression from '../models/Suppression.js';
import { createResetToken, hashResetToken } from './passwordReset.service.js';

/**
 * Public double opt-in subscription flow.
 *
 * subscribe -> store a hashed, single-use token and email a confirmation link
 * confirm   -> create/update the contact for the form owner
 *
 * Consent rules on confirm:
 * - Addresses suppressed by a bounce, spam complaint or the owner (`admin`/`import`) stay blocked.
 * - A recipient's own earlier unsubscribe (`link`/`one-click-header`) is lifted, because they have
 *   just given fresh, explicit, verified consent.
 */

const CLEARABLE_SOURCES = ['link', 'one-click-header'];

export const buildConfirmationLink = (token, env = process.env) => {
  const origin = (env.CLIENT_URL || 'http://localhost:5173').split(',')[0].trim().replace(/\/+$/, '');
  return `${origin}/confirm-subscription?token=${token}`;
};

const esc = (value) => String(value).replace(/[<>&"']/g, '');

export const buildConfirmationEmail = ({ formName, link }) => {
  const name = esc(formName);
  return {
    subject: `Confirm your subscription to ${name}`.slice(0, 200),
    text:
      `Please confirm that you want to subscribe to ${name}:\n\n${link}\n\n` +
      'This link works for 48 hours. If you did not ask to subscribe, ignore this email and nothing will happen.\n',
    html:
      `<p>Please confirm that you want to subscribe to <strong>${name}</strong>:</p>` +
      `<p><a href="${link}">Confirm subscription</a></p>` +
      '<p>This link works for 48 hours. If you did not ask to subscribe, ignore this email and nothing will happen.</p>',
  };
};

/**
 * Starts a subscription. Never reveals whether the address is already known.
 *
 * @returns {Promise<{ queued: boolean }>} `queued` is internal (tests); callers answer uniformly
 */
export const requestSubscription = async (form, { email, name }, emailService, now = new Date()) => {
  const existingPending = await PendingSubscription.findOne({ formId: form._id, email }).lean();
  if (existingPending && now.getTime() - new Date(existingPending.createdAt).getTime() < RESEND_COOLDOWN_MS) {
    return { queued: false };
  }

  const blocked = await Suppression.exists({
    userId: form.userId,
    email,
    source: { $nin: CLEARABLE_SOURCES },
  });
  if (blocked) return { queued: false };

  const { token, tokenHash } = createResetToken(now);
  await PendingSubscription.findOneAndUpdate(
    { formId: form._id, email },
    {
      $set: {
        userId: form.userId,
        name: (name || '').slice(0, 100),
        tokenHash,
        expiresAt: new Date(now.getTime() + PENDING_TTL_MS),
        createdAt: now,
      },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const link = buildConfirmationLink(token);
  // Not awaited: response timing must not depend on SMTP. The link is never logged.
  emailService.sendEmail({ to: email, ...buildConfirmationEmail({ formName: form.name, link }) }).catch(() => {});
  return { queued: true };
};

/**
 * Completes a subscription from an emailed token (single use).
 *
 * @returns {Promise<{ confirmed: boolean, formName?: string }>}
 */
export const confirmSubscription = async (token, now = new Date()) => {
  const pending = await PendingSubscription.findOneAndDelete({
    tokenHash: hashResetToken(token),
    expiresAt: { $gt: now },
  });
  if (!pending) return { confirmed: false };

  const form = await SignupForm.findById(pending.formId).lean();
  if (!form || !form.enabled) return { confirmed: false };

  const { userId, email } = pending;
  const suppression = await Suppression.findOne({ userId, email }).lean();
  if (suppression && !CLEARABLE_SOURCES.includes(suppression.source)) {
    // Stay silent: do not reveal that the owner suppressed this address
    return { confirmed: true, formName: form.name };
  }
  if (suppression) await Suppression.deleteOne({ _id: suppression._id, userId });

  const existing = await Contact.findOne({ userId, email });
  if (existing) {
    await Contact.updateOne(
      { _id: existing._id, userId },
      {
        $addToSet: { tags: { $each: form.tags } },
        $set: { isUnsubscribed: false, unsubscribedAt: null, unsubscribeReason: null },
      }
    );
  } else {
    const fallbackName = (pending.name || email.split('@')[0]).slice(0, 100);
    await Contact.create({
      userId,
      email,
      name: fallbackName.length >= 2 ? fallbackName : `${fallbackName}_`.slice(0, 100),
      tags: form.tags,
    });
  }
  return { confirmed: true, formName: form.name };
};
