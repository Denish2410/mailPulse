import { Router, raw } from 'express';
import {
  handleSendgridWebhook,
  handleMailgunWebhook,
  handleSesWebhook,
} from '../controllers/webhook.controller.js';

const router = Router();

// Signatures cover the exact bytes sent, so bodies are kept raw. SNS posts text/plain.
router.use(raw({ type: () => true, limit: '1mb' }));

router.post('/sendgrid', handleSendgridWebhook);
router.post('/mailgun', handleMailgunWebhook);
router.post('/ses', handleSesWebhook);

export default router;
