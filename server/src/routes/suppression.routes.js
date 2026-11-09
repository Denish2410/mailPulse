import { Router } from 'express';
import {
  getSuppressions,
  createSuppression,
  deleteSuppression,
} from '../controllers/suppression.controller.js';
import { authenticateSession as authenticate } from '../middleware/authenticate.js';
import { validate } from '../validators/validate.js';
import {
  createSuppressionSchema,
  getSuppressionsQuerySchema,
  suppressionIdParamSchema,
} from '../validators/suppression.validator.js';

const router = Router();

router.use(authenticate);

router.get('/', validate(getSuppressionsQuerySchema), getSuppressions);
router.post('/', validate(createSuppressionSchema), createSuppression);
router.delete('/:id', validate(suppressionIdParamSchema), deleteSuppression);

export default router;
