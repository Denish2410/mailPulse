import { Router } from 'express';
import {
  createContact,
  getContacts,
  updateContact,
  deleteContact,
} from '../controllers/contact.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../validators/validate.js';
import {
  createContactSchema,
  contactIdParamSchema,
  updateContactSchema,
  getContactsSchema,
} from '../validators/contact.validator.js';

const router = Router();

/**
 * All contact routes require valid authentication.
 * Verified owner identity is attached to `req.auth.userId`.
 */
router.use(authenticate);

/**
 * @route   POST /api/v1/contacts
 * @desc    Create a new contact for the authenticated user
 * @access  Protected
 */
router.post('/', validate(createContactSchema), createContact);

/**
 * @route   GET /api/v1/contacts
 * @desc    List all contacts for the authenticated user (with pagination, search & filters)
 * @access  Protected
 */
router.get('/', validate(getContactsSchema), getContacts);

/**
 * @route   PATCH /api/v1/contacts/:id
 * @desc    Update a contact belonging to the authenticated user
 * @access  Protected
 */
router.patch('/:id', validate(updateContactSchema), updateContact);

/**
 * @route   DELETE /api/v1/contacts/:id
 * @desc    Delete a contact belonging to the authenticated user
 * @access  Protected
 */
router.delete('/:id', validate(contactIdParamSchema), deleteContact);

export default router;
