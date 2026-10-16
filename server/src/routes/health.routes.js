import { Router } from 'express';
import mongoose from 'mongoose';

const router = Router();

const DB_STATUS_MAP = {
  0: 'disconnected',
  1: 'connected',
  2: 'connecting',
  3: 'disconnecting',
};

/**
 * @route   GET /api/v1/health
 * @desc    Liveness check: verifies process is alive and able to accept traffic
 *          (does NOT require a live database query)
 * @access  Public
 */
router.get('/', (req, res) => {
  const uptimeSeconds = Math.floor(process.uptime());
  const mem = process.memoryUsage();
  const dbState = mongoose.connection.readyState;

  res.status(200).json({
    success: true,
    service: 'MailPulse API',
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: `${uptimeSeconds}s`,
    uptimeSeconds,
    database: {
      status: DB_STATUS_MAP[dbState] || 'unknown',
      connected: dbState === 1,
    },
    diagnostics: {
      nodeVersion: process.version,
      memoryUsageMB: {
        rss: Math.round(mem.rss / 1024 / 1024),
        heapUsed: Math.round(mem.heapUsed / 1024 / 1024),
      },
    },
    version: '1.0.0',
  });
});

/**
 * @route   GET /api/v1/health/ready
 * @desc    Readiness check: verifies API is ready to serve database-backed requests
 *          by pinging MongoDB with a strict timeout
 * @access  Public
 */
router.get('/ready', async (req, res) => {
  const dbState = mongoose.connection.readyState;

  // 1. Check if Mongoose connection is established
  if (dbState !== 1 || !mongoose.connection.db) {
    return res.status(503).json({
      success: false,
      service: 'MailPulse API',
      status: 'not_ready',
      timestamp: new Date().toISOString(),
      database: {
        status: DB_STATUS_MAP[dbState] || 'disconnected',
        connected: false,
      },
    });
  }

  // 2. Perform a lightweight ping command with timeout
  try {
    const timeoutMs = 2000;
    const startTime = Date.now();

    const pingPromise = mongoose.connection.db.command({ ping: 1 });
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('MongoDB ping timed out')), timeoutMs)
    );

    await Promise.race([pingPromise, timeoutPromise]);
    const responseTimeMs = Date.now() - startTime;

    return res.status(200).json({
      success: true,
      service: 'MailPulse API',
      status: 'ready',
      timestamp: new Date().toISOString(),
      database: {
        status: 'connected',
        connected: true,
        responseTimeMs,
      },
    });
  } catch (err) {
    const isTimeout = err.message && err.message.includes('timed out');
    return res.status(503).json({
      success: false,
      service: 'MailPulse API',
      status: 'not_ready',
      timestamp: new Date().toISOString(),
      database: {
        status: isTimeout ? 'timeout' : 'error',
        connected: false,
      },
    });
  }
});

export default router;
