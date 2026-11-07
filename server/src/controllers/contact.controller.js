import mongoose from 'mongoose';
import Contact from '../models/Contact.js';
import { AppError } from '../middleware/errorHandler.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { importContactsFromCsv, ImportError } from '../services/contactImport.service.js';
import { toCsv } from '../utils/csv.js';
import { toPlainCustomFields } from '../utils/customFields.js';

/**
 * Format a Mongoose Contact document into a safe, client-facing representation.
 *
 * @param {import('../models/Contact.js').default|object} contact
 * @returns {object} Safe contact payload
 */
export const formatSafeContact = (contact) => {
  const doc = contact.toObject ? contact.toObject() : { ...contact };
  const idStr = (doc._id || doc.id).toString();

  return {
    id: idStr,
    name: doc.name,
    email: doc.email,
    tags: Array.isArray(doc.tags) ? doc.tags : [],
    customFields: toPlainCustomFields(doc.customFields),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
};

/**
 * Create a new contact belonging to the authenticated user.
 *
 * Route: POST /api/v1/contacts
 * Access: Protected (Bearer JWT)
 */
export const createContact = asyncHandler(async (req, res) => {
  const userId = req.auth?.userId;
  if (!userId || !mongoose.isValidObjectId(userId)) {
    throw new AppError('Authentication required. Invalid user identity.', 401);
  }

  const { name, email, tags = [], customFields } = req.body;
  const normalizedEmail = email.trim().toLowerCase();

  // 1. Proactively check if a contact with this email already exists for this owner
  const existing = await Contact.findOne({ userId, email: normalizedEmail });
  if (existing) {
    throw new AppError('A contact with this email already exists.', 409);
  }

  // 2. Persist contact, catching any concurrent race condition via index error code 11000
  let contact;
  try {
    contact = await Contact.create({
      userId,
      name: name.trim(),
      email: normalizedEmail,
      tags,
      ...(customFields && Object.keys(customFields).length > 0 && { customFields }),
    });
  } catch (err) {
    if (err.code === 11000) {
      throw new AppError('A contact with this email already exists.', 409);
    }
    throw err;
  }

  res.status(201).json({
    success: true,
    message: 'Contact created successfully',
    data: {
      contact: formatSafeContact(contact),
    },
  });
});

/**
 * Escape regular expression special characters to ensure literal substring matching.
 *
 * @param {string} string - Raw string to escape
 * @returns {string} Regex-escaped string
 */
export const escapeRegex = (string) => {
  return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
};

/**
 * Retrieve contacts belonging to the authenticated user with pagination, search, and domain filtering.
 *
 * Route: GET /api/v1/contacts
 * Access: Protected (Bearer JWT)
 */
export const getContacts = asyncHandler(async (req, res) => {
  const userId = req.auth?.userId;
  if (!userId || !mongoose.isValidObjectId(userId)) {
    throw new AppError('Authentication required. Invalid user identity.', 401);
  }

  const { page = 1, limit = 20, search, emailDomain, tag } = req.query;

  // Build filter scoped strictly to the authenticated owner
  const filter = { userId };
  const conditions = [];

  // 1. Optional case-insensitive search by name or email
  if (search && typeof search === 'string' && search.trim().length > 0) {
    const searchRegex = new RegExp(escapeRegex(search.trim()), 'i');
    conditions.push({
      $or: [{ name: searchRegex }, { email: searchRegex }],
    });
  }

  // 2. Optional email-domain filter (exact domain match at end of email)
  if (emailDomain && typeof emailDomain === 'string' && emailDomain.trim().length > 0) {
    const domainRegex = new RegExp(`@${escapeRegex(emailDomain.trim().toLowerCase())}$`, 'i');
    conditions.push({ email: domainRegex });
  }

  // 3. Optional tag filter (exact, normalized tag)
  if (tag && typeof tag === 'string') {
    conditions.push({ tags: tag });
  }

  if (conditions.length === 1) {
    Object.assign(filter, conditions[0]);
  } else if (conditions.length > 1) {
    filter.$and = conditions;
  }

  const skip = (page - 1) * limit;

  // Execute query and document count concurrently using identical filter
  const [contacts, total] = await Promise.all([
    Contact.find(filter)
      .sort({ createdAt: -1, _id: -1 })
      .skip(skip)
      .limit(limit),
    Contact.countDocuments(filter),
  ]);

  const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
  const hasNextPage = page < totalPages;
  const hasPrevPage = page > 1 && total > 0;

  res.status(200).json({
    success: true,
    message: 'Contacts retrieved successfully',
    data: {
      contacts: contacts.map(formatSafeContact),
      count: contacts.length,
      pagination: {
        page,
        limit,
        total,
        totalPages,
        hasNextPage,
        hasPrevPage,
      },
      page,
      limit,
      total,
      totalPages,
      hasNextPage,
      hasPrevPage,
    },
  });
});

/**
 * Update an existing contact belonging to the authenticated user.
 *
 * Route: PATCH /api/v1/contacts/:id
 * Access: Protected (Bearer JWT)
 */
export const updateContact = asyncHandler(async (req, res) => {
  const userId = req.auth?.userId;
  if (!userId || !mongoose.isValidObjectId(userId)) {
    throw new AppError('Authentication required. Invalid user identity.', 401);
  }

  const { id } = req.params;
  const { name, email, tags, customFields } = req.body;

  // 1. Query using BOTH contact ID and authenticated owner's ID
  // Returning 404 for unowned contacts prevents ownership enumeration attacks
  const contact = await Contact.findOne({ _id: id, userId });
  if (!contact) {
    throw new AppError('Contact not found.', 404);
  }

  // 2. Validate email changes for uniqueness within this owner's list
  if (email !== undefined) {
    const normalizedEmail = email.trim().toLowerCase();
    if (normalizedEmail !== contact.email) {
      const duplicate = await Contact.findOne({
        userId,
        email: normalizedEmail,
        _id: { $ne: id },
      });

      if (duplicate) {
        throw new AppError('A contact with this email already exists.', 409);
      }
      contact.email = normalizedEmail;
    }
  }

  // 3. Update name if provided
  if (name !== undefined) {
    contact.name = name.trim();
  }

  // 3b. Replace tags if provided (already normalized by validation)
  if (tags !== undefined) {
    contact.tags = tags;
  }

  // 3c. Replace custom fields if provided ({} clears them)
  if (customFields !== undefined) {
    contact.customFields = Object.keys(customFields).length > 0 ? customFields : undefined;
  }

  // 4. Save updated document, preserving existing record if error occurs
  try {
    await contact.save();
  } catch (err) {
    if (err.code === 11000) {
      throw new AppError('A contact with this email already exists.', 409);
    }
    throw err;
  }

  res.status(200).json({
    success: true,
    message: 'Contact updated successfully',
    data: {
      contact: formatSafeContact(contact),
    },
  });
});

/**
 * Delete a contact belonging to the authenticated user.
 *
 * Route: DELETE /api/v1/contacts/:id
 * Access: Protected (Bearer JWT)
 */
export const deleteContact = asyncHandler(async (req, res) => {
  const userId = req.auth?.userId;
  if (!userId || !mongoose.isValidObjectId(userId)) {
    throw new AppError('Authentication required. Invalid user identity.', 401);
  }

  const { id } = req.params;

  // Delete using BOTH contact ID and authenticated owner's ID
  const deleted = await Contact.findOneAndDelete({ _id: id, userId });
  if (!deleted) {
    throw new AppError('Contact not found.', 404);
  }

  res.status(200).json({
    success: true,
    message: 'Contact deleted successfully',
  });
});

export default {
  createContact,
  getContacts,
  updateContact,
  deleteContact,
  formatSafeContact,
};

/**
 * List the authenticated user's tags with contact counts.
 *
 * Route: GET /api/v1/contacts/tags
 * Access: Protected (Bearer JWT)
 */
export const getContactTags = asyncHandler(async (req, res) => {
  const userId = req.auth?.userId;
  if (!userId || !mongoose.isValidObjectId(userId)) {
    throw new AppError('Authentication required. Invalid user identity.', 401);
  }

  const rows = await Contact.aggregate([
    { $match: { userId: new mongoose.Types.ObjectId(userId) } },
    { $unwind: '$tags' },
    { $group: { _id: '$tags', count: { $sum: 1 } } },
    { $sort: { count: -1, _id: 1 } },
    { $limit: 500 },
  ]);

  res.status(200).json({
    success: true,
    message: 'Tags retrieved successfully',
    data: { tags: rows.map((row) => ({ tag: row._id, count: row.count })) },
  });
});

/**
 * Bulk-create contacts from CSV text for the authenticated user.
 *
 * Route: POST /api/v1/contacts/import
 * Access: Protected (Bearer JWT)
 */
export const importContacts = asyncHandler(async (req, res) => {
  const userId = req.auth?.userId;
  if (!userId || !mongoose.isValidObjectId(userId)) {
    throw new AppError('Authentication required. Invalid user identity.', 401);
  }

  let result;
  try {
    result = await importContactsFromCsv(userId, req.body.csv);
  } catch (err) {
    if (err instanceof ImportError) {
      throw new AppError(err.message, 400, null, { expose: true });
    }
    throw err;
  }

  res.status(200).json({
    success: true,
    message: 'Contact import finished',
    data: result,
  });
});

const MAX_EXPORT_ROWS = 50000;

/**
 * Download the authenticated user's contacts as CSV (optionally filtered by ?tag=).
 * Cells are formula-injection safe. The CSV re-imports through POST /contacts/import.
 *
 * Route: GET /api/v1/contacts/export
 * Access: Protected (Bearer JWT)
 */
export const exportContacts = asyncHandler(async (req, res) => {
  const userId = req.auth?.userId;
  if (!userId || !mongoose.isValidObjectId(userId)) {
    throw new AppError('Authentication required. Invalid user identity.', 401);
  }

  const filter = { userId };
  if (req.query.tag) filter.tags = req.query.tag;

  const contacts = await Contact.find(filter)
    .sort({ createdAt: 1, _id: 1 })
    .limit(MAX_EXPORT_ROWS)
    .select('name email tags isUnsubscribed createdAt')
    .lean();

  const csv = toCsv(
    ['name', 'email', 'tags', 'status', 'created'],
    contacts.map((c) => [
      c.name,
      c.email,
      (c.tags || []).join(';'),
      c.isUnsubscribed ? 'unsubscribed' : 'subscribed',
      c.createdAt ? new Date(c.createdAt).toISOString() : '',
    ])
  );

  res.status(200);
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': 'attachment; filename="contacts.csv"',
    'Cache-Control': 'no-store',
  });
  res.send(csv);
});
