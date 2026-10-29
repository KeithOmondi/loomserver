// src/server.ts
import app from './app';
import { env } from './config/env';
import { connectDB, closeDB } from './config/db';
import { deleteExpiredRefreshTokens } from './services/token.service';
import { redisService } from './config/redis';

const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // once a day

const start = async (): Promise<void> => {
  // Verify the DB is actually reachable before accepting any traffic —
  // every auth operation (login, register, refresh, logout) depends on
  // it, so there's no safe reason to start listening first.
  await connectDB();

  // Initialize Redis connection (non-blocking - will log if fails)
  try {
    const redisHealthy = await redisService.ping();
    if (redisHealthy) {
      console.log('🔴 Redis connected successfully');
      
      // Get Redis info for monitoring
      const redisInfo = await redisService.getInfo();
      if (redisInfo) {
        console.log(`🔴 Redis version: ${redisInfo.redis_version}`);
        console.log(`🔴 Redis memory: ${redisInfo.used_memory_human}`);
        console.log(`🔴 Redis uptime: ${Math.floor(parseInt(redisInfo.uptime_in_seconds) / 3600)} hours`);
      }
    } else {
      console.warn('⚠️ Redis connection failed - running without cache');
    }
  } catch (error) {
    console.warn('⚠️ Redis not available:', error instanceof Error ? error.message : 'Unknown error');
    console.warn('⚠️ Running without Redis cache. Some features may be degraded.');
  }

  const server = app.listen(env.PORT, () => {
    console.log(`🚀 Server running in ${env.NODE_ENV} mode on port ${env.PORT}`);
    console.log(`📚 API: http://localhost:${env.PORT}/api/v1`);
    console.log(`💚 Health: http://localhost:${env.PORT}/health`);
  });

  // Runs once a day, only after the server is up — no reason to fire
  // this before connectDB has already confirmed the pool is healthy.
  const cleanupInterval = setInterval(async () => {
    try {
      const deleted = await deleteExpiredRefreshTokens();
      if (deleted > 0) {
        console.log(`🧹 Cleaned up ${deleted} expired refresh token(s)`);
      }
    } catch (err) {
      console.error('⚠️ Refresh token cleanup failed:', err);
    }
  }, CLEANUP_INTERVAL_MS);

  const shutdown = async (signal: string): Promise<void> => {
    console.log(`\n${signal} received. Shutting down gracefully...`);
    clearInterval(cleanupInterval);

    // Close Redis connection first
    try {
      console.log('🔴 Closing Redis connection...');
      await redisService.quit();
      console.log('🔴 Redis connection closed.');
    } catch (err) {
      console.error('⚠️ Error closing Redis connection:', err);
    }

    server.close(async () => {
      // Closes the pool only after the HTTP server has stopped accepting
      // new connections and finished in-flight requests — so an
      // in-progress rotateRefreshToken transaction isn't severed mid-way.
      await closeDB();
      console.log('👋 Server shutdown complete.');
      process.exit(0);
    });

    // Failsafe: if server.close() hangs (e.g. a stuck connection that
    // never ends), force-exit after 10s rather than hanging forever.
    setTimeout(() => {
      console.error('⚠️ Forced shutdown after timeout.');
      process.exit(1);
    }, 10_000);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM')); // sent by process managers/containers on deploy/restart
  process.on('SIGINT', () => shutdown('SIGINT'));   // Ctrl+C in dev

  // Handle unhandled promise rejections
  process.on('unhandledRejection', (err: Error) => {
    console.error(`❌ Unhandled rejection: ${err.message}`);
    console.error(err.stack);
    server.close(() => process.exit(1));
  });

  // Handle uncaught exceptions
  process.on('uncaughtException', (err: Error) => {
    console.error(`❌ Uncaught exception: ${err.message}`);
    console.error(err.stack);
    server.close(() => process.exit(1));
  });
};

start().catch((err) => {
  console.error('❌ Failed to start server:', err);
  process.exit(1);
});