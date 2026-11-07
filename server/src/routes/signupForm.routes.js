import { Router } from 'express';
import {
  createSignupForm,
  getSignupForms,
  updateSignupForm,
  deleteSignupForm,
} from '../controllers/signupForm.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../validators/validate.js';
import {
  createSignupFormSchema,
  updateSignupFormSchema,
  signupFormIdParamSchema,
} from '../validators/signupForm.validator.js';

const router = Router();

router.use(authenticate);

router.post('/', validate(createSignupFormSchema), createSignupForm);
router.get('/', getSignupForms);
router.patch('/:id', validate(updateSignupFormSchema), updateSignupForm);
router.delete('/:id', validate(signupFormIdParamSchema), deleteSignupForm);

export default router;
