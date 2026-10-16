import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createShutdownHandler, startServer } from '../src/server.js';

describe('Server Startup and Graceful Shutdown Tests', () => {
  it('1. Server startup enforces correct sequence: awaits DB before listening', async () => {
    let dbConnected = false;
    let listeningWhenConnected = null;

    const mockConnectDB = async () => {
      // Simulate connection time
      await new Promise((resolve) => setTimeout(resolve, 10));
      dbConnected = true;
    };

    let serverInstance = null;
    try {
      serverInstance = await startServer({
        port: 0, // OS assigns an ephemeral port
        connectDB: mockConnectDB,
        exitFn: () => {},
      });

      listeningWhenConnected = dbConnected;
      assert.equal(listeningWhenConnected, true);
      assert.equal(serverInstance.listening, true);
    } finally {
      if (serverInstance && serverInstance.listening) {
        await new Promise((resolve) => serverInstance.close(resolve));
      }
    }
  });

  it('2. MongoDB connection failure prevents server from listening', async () => {
    let exitStatus = null;
    const failingConnectDB = async () => {
      throw new Error('Connection refused to MongoDB host');
    };

    await assert.rejects(
      async () => {
        await startServer({
          port: 0,
          connectDB: failingConnectDB,
          exitFn: (code) => {
            exitStatus = code;
          },
        });
      },
      {
        message: 'Connection refused to MongoDB host',
      }
    );

    assert.equal(exitStatus, 1);
  });

  it('3. Repeated startServer calls detect active server and avoid duplicate listening', async () => {
    let mockServer = null;
    try {
      mockServer = await startServer({
        port: 0,
        connectDB: async () => {},
        exitFn: () => {},
      });

      // Attempt starting again while first server is active
      const secondCallResult = await startServer({
        port: 0,
        connectDB: async () => {},
        exitFn: () => {},
      });

      // Returns existing server without throwing or opening another port
      assert.equal(secondCallResult, mockServer);
    } finally {
      if (mockServer && mockServer.listening) {
        await new Promise((resolve) => mockServer.close(resolve));
      }
    }
  });

  it('4. Graceful shutdown closes HTTP server and closes idle keep-alive connections', async () => {
    let idleClosed = false;
    let serverClosed = false;
    let exitCode = null;

    const mockServer = {
      listening: true,
      closeIdleConnections: () => {
        idleClosed = true;
      },
      close: (cb) => {
        serverClosed = true;
        mockServer.listening = false;
        cb(null);
      },
    };

    const mockMongoose = {
      connection: {
        readyState: 0,
        close: async () => {},
      },
    };

    const shutdown = createShutdownHandler({
      serverGetter: () => mockServer,
      mongooseInstance: mockMongoose,
      timeoutMs: 1000,
      exitFn: (code) => {
        exitCode = code;
      },
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });

    await shutdown('SIGTERM');

    assert.equal(idleClosed, true);
    assert.equal(serverClosed, true);
    assert.equal(exitCode, 0);
  });

  it('5. Graceful shutdown closes Mongoose database connection cleanly', async () => {
    let mongooseClosed = false;
    let forceCloseParam = null;
    let exitCode = null;

    const mockMongoose = {
      connection: {
        readyState: 1, // Connected
        close: async (force) => {
          mongooseClosed = true;
          forceCloseParam = force;
          mockMongoose.connection.readyState = 0;
        },
      },
    };

    const shutdown = createShutdownHandler({
      serverGetter: () => null,
      mongooseInstance: mockMongoose,
      timeoutMs: 1000,
      exitFn: (code) => {
        exitCode = code;
      },
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });

    await shutdown('SIGINT');

    assert.equal(mongooseClosed, true);
    assert.equal(forceCloseParam, false); // Normal non-force closure
    assert.equal(exitCode, 0);
  });

  it('6. Duplicate shutdown signals (SIGTERM + SIGINT) execute cleanup only once', async () => {
    let cleanupCalls = 0;
    let warnLogged = false;

    const mockServer = {
      listening: true,
      closeIdleConnections: () => {},
      close: (cb) => {
        cleanupCalls++;
        cb(null);
      },
    };

    const shutdown = createShutdownHandler({
      serverGetter: () => mockServer,
      mongooseInstance: { connection: { readyState: 0 } },
      timeoutMs: 1000,
      exitFn: () => {},
      logger: {
        log: () => {},
        warn: () => {
          warnLogged = true;
        },
        error: () => {},
      },
    });

    // Fire two signals concurrently
    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT')]);

    assert.equal(cleanupCalls, 1);
    assert.equal(warnLogged, true);
  });

  it('7. Shutdown timeout triggers forced termination if connections stall', async () => {
    let allConnectionsClosed = false;
    let exitCode = null;

    const hangingServer = {
      listening: true,
      closeIdleConnections: () => {},
      close: () => {
        // Deliberately stall: never call callback to simulate stuck in-flight request
      },
      closeAllConnections: () => {
        allConnectionsClosed = true;
      },
    };

    const shutdown = createShutdownHandler({
      serverGetter: () => hangingServer,
      mongooseInstance: { connection: { readyState: 0 } },
      timeoutMs: 30, // 30ms timeout for test
      exitFn: (code) => {
        exitCode = code;
      },
      logger: { log: () => {}, warn: () => {}, error: () => {} },
    });

    await shutdown('SIGTERM');

    assert.equal(allConnectionsClosed, true);
    assert.equal(exitCode, 1);
  });

  it('8. Shutdown errors are safely caught and logged without crashing the process', async () => {
    let exitCode = null;
    let errorLogged = null;

    const errorMongoose = {
      connection: {
        readyState: 1,
        close: async () => {
          throw new Error('Database connection unexpectedly dropped during flush');
        },
      },
    };

    const shutdown = createShutdownHandler({
      serverGetter: () => null,
      mongooseInstance: errorMongoose,
      timeoutMs: 1000,
      exitFn: (code) => {
        exitCode = code;
      },
      logger: {
        log: () => {},
        warn: () => {},
        error: (msg) => {
          errorLogged = msg;
        },
      },
    });

    await shutdown('SIGTERM');

    assert.equal(exitCode, 1);
    assert.ok(errorLogged);
    assert.ok(errorLogged.includes('Database connection unexpectedly dropped'));
  });
});
