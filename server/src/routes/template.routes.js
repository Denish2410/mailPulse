import { Router } from 'express';
import {
  createTemplate,
  getTemplates,
  getTemplateById,
  updateTemplate,
  deleteTemplate,
} from '../controllers/template.controller.js';
import { authenticate } from '../middleware/authenticate.js';
import { validate } from '../validators/validate.js';
import {
  createTemplateSchema,
  updateTemplateSchema,
  getTemplatesQuerySchema,
  templateIdParamSchema,
} from '../validators/template.validator.js';

const router = Router();

router.use(authenticate);

router.post('/', validate(createTemplateSchema), createTemplate);
router.get('/', validate(getTemplatesQuerySchema), getTemplates);
router.get('/:id', validate(templateIdParamSchema), getTemplateById);
router.patch('/:id', validate(updateTemplateSchema), updateTemplate);
router.delete('/:id', validate(templateIdParamSchema), deleteTemplate);

export default router;
