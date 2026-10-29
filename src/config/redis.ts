// src/config/redis.ts
import Redis from 'ioredis';
import { env } from './env';

// Create Redis connection
export const redis = new Redis({
  host: env.REDIS_HOST,
  port: env.REDIS_PORT, // Already a number from env.ts
  password: env.REDIS_PASSWORD || undefined,
  db: env.REDIS_DB, // Already a number from env.ts
  retryStrategy: (times) => {
    const delay = Math.min(times * 50, 2000);
    return delay;
  },
  maxRetriesPerRequest: 3,
  enableReadyCheck: true,
  lazyConnect: false,
  connectTimeout: env.REDIS_CONNECT_TIMEOUT,
  commandTimeout: env.REDIS_COMMAND_TIMEOUT,
});

// Redis events
redis.on('connect', () => {
  console.log('🔴 Redis connected');
});

redis.on('ready', () => {
  console.log('🔴 Redis ready');
});

redis.on('error', (error) => {
  console.error('🔴 Redis error:', error);
});

redis.on('close', () => {
  console.warn('🔴 Redis connection closed');
});

redis.on('reconnecting', () => {
  console.warn('🔴 Redis reconnecting...');
});

// Helper functions
export class RedisService {
  private static instance: RedisService;
  private client: Redis;

  private constructor() {
    this.client = redis;
  }

  public static getInstance(): RedisService {
    if (!RedisService.instance) {
      RedisService.instance = new RedisService();
    }
    return RedisService.instance;
  }

  // Session management
  async setSession(sessionId: string, data: any, ttlSeconds: number = env.SESSION_TTL): Promise<void> {
    const key = `${env.SESSION_PREFIX}${sessionId}`;
    await this.client.setex(key, ttlSeconds, JSON.stringify(data));
  }

  async getSession(sessionId: string): Promise<any | null> {
    const key = `${env.SESSION_PREFIX}${sessionId}`;
    const data = await this.client.get(key);
    return data ? JSON.parse(data) : null;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const key = `${env.SESSION_PREFIX}${sessionId}`;
    await this.client.del(key);
  }

  async deleteAllUserSessions(userId: string): Promise<void> {
    const pattern = `${env.SESSION_PREFIX}*`;
    const keys = await this.client.keys(pattern);
    for (const key of keys) {
      const session = await this.getSession(key.replace(env.SESSION_PREFIX, ''));
      if (session?.userId === userId) {
        await this.client.del(key);
      }
    }
  }

  // Token blacklist
  async blacklistToken(token: string, ttlSeconds: number): Promise<void> {
    await this.client.setex(`blacklist:${token}`, ttlSeconds, '1');
  }

  async isTokenBlacklisted(token: string): Promise<boolean> {
    const result = await this.client.get(`blacklist:${token}`);
    return result === '1';
  }

  // Rate limiting
  async rateLimit(key: string, windowSeconds: number, maxRequests: number): Promise<{ allowed: boolean; remaining: number }> {
    const current = await this.client.incr(`ratelimit:${key}`);
    if (current === 1) {
      await this.client.expire(`ratelimit:${key}`, windowSeconds);
    }
    const remaining = Math.max(0, maxRequests - current);
    return {
      allowed: current <= maxRequests,
      remaining,
    };
  }

  // Caching
  async cacheGet<T>(key: string): Promise<T | null> {
    const data = await this.client.get(`${env.REDIS_KEY_PREFIX}cache:${key}`);
    return data ? JSON.parse(data) : null;
  }

  async cacheSet<T>(key: string, data: T, ttlSeconds: number = env.CACHE_TTL_MEDIUM): Promise<void> {
    await this.client.setex(`${env.REDIS_KEY_PREFIX}cache:${key}`, ttlSeconds, JSON.stringify(data));
  }

  async cacheDelete(key: string): Promise<void> {
    await this.client.del(`${env.REDIS_KEY_PREFIX}cache:${key}`);
  }

  async cacheDeletePattern(pattern: string): Promise<void> {
    const keys = await this.client.keys(`${env.REDIS_KEY_PREFIX}cache:${pattern}`);
    if (keys.length > 0) {
      await this.client.del(...keys);
    }
  }

  // Distributed locks
  async acquireLock(key: string, ttlSeconds: number = 10): Promise<boolean> {
    const lockKey = `${env.REDIS_KEY_PREFIX}lock:${key}`;
    const result = await this.client.set(lockKey, '1', 'EX', ttlSeconds, 'NX');
    return result === 'OK';
  }

  async releaseLock(key: string): Promise<void> {
    const lockKey = `${env.REDIS_KEY_PREFIX}lock:${key}`;
    await this.client.del(lockKey);
  }

  // Queue management
  async enqueue(queue: string, data: any): Promise<void> {
    await this.client.rpush(`${env.REDIS_KEY_PREFIX}queue:${queue}`, JSON.stringify(data));
  }

  async dequeue<T>(queue: string): Promise<T | null> {
    const data = await this.client.lpop(`${env.REDIS_KEY_PREFIX}queue:${queue}`);
    return data ? JSON.parse(data) : null;
  }

  async getQueueLength(queue: string): Promise<number> {
    return await this.client.llen(`${env.REDIS_KEY_PREFIX}queue:${queue}`);
  }

  // Bulk operations
  async mget(keys: string[]): Promise<any[]> {
    const results = await this.client.mget(keys.map(k => `${env.REDIS_KEY_PREFIX}cache:${k}`));
    return results.map(r => r ? JSON.parse(r) : null);
  }

  async mset(data: Record<string, any>, ttlSeconds: number = env.CACHE_TTL_MEDIUM): Promise<void> {
    const pipeline = this.client.pipeline();
    for (const [key, value] of Object.entries(data)) {
      pipeline.setex(`${env.REDIS_KEY_PREFIX}cache:${key}`, ttlSeconds, JSON.stringify(value));
    }
    await pipeline.exec();
  }

  // Health check
  async ping(): Promise<boolean> {
    try {
      await this.client.ping();
      return true;
    } catch {
      return false;
    }
  }

  // Get Redis info
  async getInfo(): Promise<any> {
    try {
      const info = await this.client.info();
      const lines = info.split('\n');
      const result: Record<string, any> = {};
      for (const line of lines) {
        if (line.includes(':')) {
          const [key, value] = line.split(':');
          result[key.trim()] = value.trim();
        }
      }
      return result;
    } catch {
      return null;
    }
  }

  // Close connection
  async quit(): Promise<void> {
    await this.client.quit();
  }
}

// Export singleton instance
export const redisService = RedisService.getInstance();

// Export client for direct use if needed
export default redis;