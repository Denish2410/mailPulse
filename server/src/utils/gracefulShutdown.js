import mongoose from 'mongoose';
import { getShutdownTimeoutMs } from '../config/shutdown.js';
import { stopAllDispatches } from '../services/campaignDispatch.service.js';
import { stopCampaignScheduler } from '../services/campaignScheduler.service.js';

/**
 * Graceful shutdown shared by the API process (src/server.js) and the worker process
 * (src/worker.js). Order: close the HTTP server (API requests, or the worker's health endpoint),
 * stop the scheduler (awaiting an in-flight poll), stop the dispatches (awaiting sweeps,
 * recoveries and in-flight sends, then releasing leases), close MongoDB, exit. A bounded timer
 * forces exit if any step stalls.
 */

/**
 * Factory creating an idempotent graceful shutdown handler
 *
 * @param {object} options
 * @param {string} [options.label='Server'] - Log prefix ('Server' for the API, 'Worker' for the worker)
 * @param {Function} [options.serverGetter] - Function returning the HTTP server to close (API server, or the worker's health server)
 * @param {typeof mongoose} [options.mongooseInstance] - Mongoose instance
 * @param {number} [options.timeoutMs] - Maximum milliseconds allowed before forced termination
 * @param {Function} [options.exitFn] - Process termination function
 * @param {object} [options.logger] - Logger interface
 * @param {Function} [options.stopDispatches] - Stops campaign dispatch workers and awaits in-flight sends
 * @param {Function} [options.stopScheduler] - Stops the scheduled-campaign poller and awaits an in-flight poll
 * @returns {Function} Graceful shutdown function accepting a signal name
 */
export const createShutdownHandler = ({
  label = 'Server',
  serverGetter = () => null,
  mongooseInstance = mongoose,
  timeoutMs = getShutdownTimeoutMs(),
  exitFn = process.exit,
  logger = console,
  stopDispatches = stopAllDispatches,
  stopScheduler = stopCampaignScheduler,
} = {}) => {
  let isShuttingDown = false;

  return async (signal = 'SIGTERM') => {
    // 1. Prevent duplicate shutdown execution if multiple signals arrive
    if (isShuttingDown) {
      logger.warn(`[${label}] ${signal} received, but shutdown is already in progress. Ignoring duplicate signal.`);
      return;
    }
    isShuttingDown = true;

    logger.log(`[${label}] ${signal} received. Initiating graceful shutdown...`);

    const currentServer = serverGetter();
    let pendingReject = null;

    // 2. Bounded shutdown timer: force termination if cleanup stalls
    const forceExitTimer = setTimeout(() => {
      logger.error(`[${label} Error] Shutdown timed out after ${timeoutMs}ms. Forcing process termination.`);
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
        logger.log(`[${label}] Closing HTTP server and stopping new connections...`);

        // Close idle keep-alive connections so they do not hold the process open
        currentServer.closeIdleConnections?.();

        await new Promise((resolve, reject) => {
          pendingReject = reject;
          currentServer.close((err) => {
            if (err) return reject(err);
            logger.log(`[${label}] HTTP server closed cleanly.`);
            resolve();
          });
        });
      }

      // 3b. Stop the scheduled-campaign poller FIRST and wait for an in-flight poll. A poll can be
      //     locking a campaign and generating its deliveries; it must finish (with MongoDB still
      //     open) and register its dispatch before the dispatches are stopped, so that dispatch is
      //     included in the set awaited below instead of being started after it.
      if (typeof stopScheduler === 'function') {
        await stopScheduler();
      }

      // 3c. Stop campaign dispatch workers: no new claims, await in-flight sends (never cancelled),
      //     release leases so peers can resume pending deliveries at once
      if (typeof stopDispatches === 'function') {
        await stopDispatches();
      }

      // 4. Close Mongoose database connection
      if (mongooseInstance?.connection?.readyState !== 0) {
        logger.log(`[${label}] Closing MongoDB connection...`);
        await mongooseInstance.connection.close(false);
        logger.log(`[${label}] MongoDB connection closed cleanly.`);
      }

      // 5. Clear timeout and exit cleanly
      clearTimeout(forceExitTimer);
      logger.log(`[${label}] Graceful shutdown completed successfully.`);
      exitFn(0);
    } catch (error) {
      clearTimeout(forceExitTimer);
      logger.error(`[${label} Error] Error during graceful shutdown: ${error.message}`);
      exitFn(1);
    }
  };
};

export default { createShutdownHandler };
