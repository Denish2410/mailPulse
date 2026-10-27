import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import mongoose from 'mongoose';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. Load environment variables before reading them
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import app from './app.js';
import { connectDB } from './config/db.js';
import { getDefaultEmailService } from './services/email.service.js';
import {
  resumeInterruptedDispatches,
  stopAllDispatches,
} from './services/campaignDispatch.service.js';

let activeServer = null;
let isStarting = false;

/**
 * Checks whether this module was executed directly via Node CLI or imported
 */
export const isMainModule = () => {
  return Boolean(process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]);
};

/**
 * Factory creating an idempotent graceful shutdown handler
 *
 * @param {object} options
 * @param {Function} [options.serverGetter] - Function returning current HTTP server instance
 * @param {typeof mongoose} [options.mongooseInstance] - Mongoose instance
 * @param {number} [options.timeoutMs] - Maximum milliseconds allowed before forced termination
 * @param {Function} [options.exitFn] - Process termination function
 * @param {object} [options.logger] - Logger interface
 * @param {Function} [options.stopDispatches] - Stops campaign dispatch workers and awaits in-flight sends
 * @returns {Function} Graceful shutdown function accepting a signal name
 */
export const createShutdownHandler = ({
  serverGetter = () => activeServer,
  mongooseInstance = mongoose,
  timeoutMs = Number(process.env.SHUTDOWN_TIMEOUT_MS) || 10000,
  exitFn = process.exit,
  logger = console,
  stopDispatches = stopAllDispatches,
} = {}) => {
  let isShuttingDown = false;

  return async (signal = 'SIGTERM') => {
    // 1. Prevent duplicate shutdown execution if multiple signals arrive
    if (isShuttingDown) {
      logger.warn(`[Server] ${signal} received, but shutdown is already in progress. Ignoring duplicate signal.`);
      return;
    }
    isShuttingDown = true;

    logger.log(`[Server] ${signal} received. Initiating graceful shutdown...`);

    const currentServer = serverGetter();
    let pendingReject = null;

    // 2. Bounded shutdown timer: force termination if cleanup stalls
    const forceExitTimer = setTimeout(() => {
      logger.error(`[Server Error] Shutdown timed out after ${timeoutMs}ms. Forcing process termination.`);
      if (currentServer) {
        currentServer.closeAllConnections?.();
      }
      if (mongooseInstance?.connection?.readyState !== 0) {
        mongooseInstance.connection.close(true).catch(() => {});
      }
      if (pendingReject) {
        pendingReject(new Error(`Shutdown timed out after ${timeoutMs}ms`));
      }
      exitFn(1);
    }, timeoutMs);

    try {
      // 3. Stop accepting new HTTP connections and drain in-flight requests
      if (currentServer && currentServer.listening) {
        logger.log('[Server] Closing HTTP server and stopping new connections...');

        // Close idle keep-alive connections so they do not hold the process open
        currentServer.closeIdleConnections?.();

        await new Promise((resolve, reject) => {
          pendingReject = reject;
          currentServer.close((err) => {
            if (err) return reject(err);
            logger.log('[Server] HTTP server closed cleanly.');
            resolve();
          });
        });
      }

      // 3b. Stop campaign dispatch workers (pending deliveries resume on next start)
      if (typeof stopDispatches === 'function') {
        await stopDispatches();
      }

      // 4. Close Mongoose database connection
      if (mongooseInstance?.connection?.readyState !== 0) {
        logger.log('[Server] Closing MongoDB connection...');
        await mongooseInstance.connection.close(false);
        logger.log('[Server] MongoDB connection closed cleanly.');
      }

      // 5. Clear timeout and exit cleanly
      clearTimeout(forceExitTimer);
      logger.log('[Server] Graceful shutdown completed successfully.');
      exitFn(0);
    } catch (error) {
      clearTimeout(forceExitTimer);
      logger.error(`[Server Error] Error during graceful shutdown: ${error.message}`);
      exitFn(1);
    }
  };
};

/**
 * Bootstrap function ensuring correct startup order:
 * 1. Validates startup state and prevents duplicate listening
 * 2. Awaits database connection
 * 3. Starts Express HTTP server only after database succeeds
 * 4. Logs error cleanly without credentials and exits with non-zero code on failure
 *
 * @param {object} [options]
 * @param {number} [options.port] - Port number to bind to
 * @param {Function} [options.connectDB] - Database connection function
 * @param {Function} [options.exitFn] - Exit function on fatal failure
 * @param {boolean} [options.resumeDispatches] - Resume campaigns interrupted mid-send
 *   (defaults to true outside the test environment)
 * @returns {Promise<import('node:http').Server>}
 */
export const startServer = async (options = {}) => {
  if (activeServer && activeServer.listening) {
    console.warn('[Server] Server is already running and listening.');
    return activeServer;
  }
  if (isStarting) {
    console.warn('[Server] Server startup is already in progress.');
    return null;
  }
  isStarting = true;

  // Use port from options if explicitly specified (e.g. 0 for ephemeral test ports)
  const port = options.port !== undefined ? options.port : (Number(process.env.PORT) || 5000);
  const dbConnector = options.connectDB || connectDB;
  const exitHandler = options.exitFn || process.exit;

  try {
    // 1. Await database connection before opening port
    await dbConnector();

    // 1b. Resume campaign sends interrupted by a previous shutdown or crash (non-blocking)
    const shouldResume = options.resumeDispatches ?? process.env.NODE_ENV !== 'test';
    if (shouldResume) {
      resumeInterruptedDispatches({ emailService: getDefaultEmailService() }).catch((err) => {
        console.error(`[Dispatcher] Failed to resume interrupted dispatches: ${err.name || 'Error'}`);
      });
    }

    // 2. Start HTTP server only after database connection succeeds
    return await new Promise((resolve, reject) => {
      const server = app.listen(port, () => {
        activeServer = server;
        isStarting = false;
        console.log(`[Server] MailPulse server running in ${process.env.NODE_ENV || 'development'} mode on port ${port}`);
        console.log(`[Server] Health check endpoint: http://localhost:${port}/api/v1/health`);
        resolve(server);
      });

      server.once('error', (err) => {
        isStarting = false;
        reject(err);
      });
    });
  } catch (error) {
    isStarting = false;
    // Log startup error cleanly without exposing credentials
    console.error(`[Server Error] Startup failed: ${error.message}`);
    exitHandler(1);
    throw error;
  }
};

// Default shutdown handler attached to process signals
export const handleShutdown = createShutdownHandler();

process.on('SIGTERM', () => handleShutdown('SIGTERM'));
process.on('SIGINT', () => handleShutdown('SIGINT'));

// Automatically start when executed directly as entry point
if (isMainModule()) {
  startServer().catch(() => {});
}

export default app;
