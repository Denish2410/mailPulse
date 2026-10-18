import mongoose from 'mongoose';
import Contact from '../models/Contact.js';
import { AppError } from '../middleware/errorHandler.js';
import { asyncHandler } from '../utils/asyncHandler.js';

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

  const { name, email } = req.body;
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
 * Retrieve all contacts belonging to the authenticated user (newest first).
 *
 * Route: GET /api/v1/contacts
 * Access: Protected (Bearer JWT)
 */
export const getContacts = asyncHandler(async (req, res) => {
  const userId = req.auth?.userId;
  if (!userId || !mongoose.isValidObjectId(userId)) {
    throw new AppError('Authentication required. Invalid user identity.', 401);
  }

  // Scoped strictly to authenticated owner, sorted newest first by createdAt descending
  const contacts = await Contact.find({ userId }).sort({ createdAt: -1 });

  res.status(200).json({
    success: true,
    message: 'Contacts retrieved successfully',
    data: {
      contacts: contacts.map(formatSafeContact),
      count: contacts.length,
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
  const { name, email } = req.body;

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
