import { Router } from 'express';
import {
  createSegment,
  getSegments,
  getSegmentById,
  updateSegment,
  deleteSegment,
  previewSegment,
  previewCriteria,
} from '../controllers/segment.controller.js';
import { authenticateSession as authenticate } from '../middleware/authenticate.js';
import { validate } from '../validators/validate.js';
import {
  createSegmentSchema,
  updateSegmentSchema,
  getSegmentsQuerySchema,
  segmentIdParamSchema,
  previewCriteriaSchema,
} from '../validators/segment.validator.js';

const router = Router();

router.use(authenticate);

router.post('/', validate(createSegmentSchema), createSegment);
router.get('/', validate(getSegmentsQuerySchema), getSegments);
// Declared before '/:id' so "preview" is never parsed as an id
router.post('/preview', validate(previewCriteriaSchema), previewCriteria);
router.get('/:id', validate(segmentIdParamSchema), getSegmentById);
router.get('/:id/preview', validate(segmentIdParamSchema), previewSegment);
router.patch('/:id', validate(updateSegmentSchema), updateSegment);
router.delete('/:id', validate(segmentIdParamSchema), deleteSegment);

export default router;
