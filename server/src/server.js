import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { getErrorReporter } from './services/errorReporter.service.js';
import { getSecurityWarnings } from './config/securityWarnings.js';
import { validateShutdownConfig } from './config/shutdown.js';
import { validateTokenEncryptionConfig } from './utils/tokenCrypto.js';
import { validateGoogleOAuthConfig } from './config/googleOAuth.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// 1. Load environment variables before reading them
dotenv.config({ path: path.resolve(__dirname, '../.env') });
dotenv.config();

import app from './app.js';
import { connectDB } from './config/db.js';
import { validateAuthConfig } from './config/auth.js';
import { createShutdownHandler as createGracefulShutdownHandler } from './utils/gracefulShutdown.js';

let activeServer = null;
let isStarting = false;

/**
 * Checks whether this module was executed directly via Node CLI or imported
 */
export const isMainModule = () => {
  return Boolean(process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]);
};

/**
 * Graceful shutdown handler for the API process (see utils/gracefulShutdown.js). It closes this
 * module's HTTP server unless another server getter is given.
 *
 * @param {Parameters<typeof createGracefulShutdownHandler>[0]} [options]
 * @returns {Function} Graceful shutdown function accepting a signal name
 */
export const createShutdownHandler = (options = {}) =>
  createGracefulShutdownHandler({ serverGetter: () => activeServer, ...options });

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
 * @param {boolean} [options.validateConfig] - Validate required configuration (JWT settings)
 *   before connecting, so a missing or weak secret fails at boot instead of on the first login
 *   (defaults to true when this module is the process entry point)
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
    // 0. Fail fast on invalid configuration (throws before anything is opened)
    const shouldValidateConfig = options.validateConfig ?? isMainModule();
    if (shouldValidateConfig) {
      validateAuthConfig();
      validateShutdownConfig();
      // Invalid token encryption keys always stop startup; missing keys only when Google OAuth is
      // configured (OAuth tokens are never stored unencrypted)
      validateTokenEncryptionConfig();
      // Google OAuth (Gmail sending) is optional, but all-or-nothing and validated when set
      validateGoogleOAuthConfig();
      for (const warning of getSecurityWarnings()) {
        console.warn(`[Security] ${warning}`);
      }
    }

    // 1. Await database connection before opening port
    await dbConnector();

    // 1b. The API never sends campaigns: it does not start the dispatch runtime (resume, watchdog,
    //     scheduler). "Send now" and scheduled sends are queued in MongoDB and sent by the worker
    //     process (src/worker.js, the `worker` Compose service).

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
  // Last-resort handlers: report, then exit so the process manager (Docker restart policy,
  // systemd, ...) starts a clean instance instead of leaving a half-broken one running.
  const crash = (source) => async (reason) => {
    await Promise.race([
      getErrorReporter().reportError(reason, { source }),
      new Promise((resolve) => setTimeout(resolve, 2500)),
    ]);
    process.exit(1);
  };
  process.on('unhandledRejection', crash('unhandledRejection'));
  process.on('uncaughtException', crash('uncaughtException'));

  startServer().catch(() => {});
}

export default app;
