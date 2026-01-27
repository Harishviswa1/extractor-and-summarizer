const Redis = require('ioredis');
const logger = require('./logger');

let redis;
const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';

// Helper to determine if we should even try connecting (e.g. skip if in a test env without redis)
// For now, we assume we try, but handle failure gracefully.

if (process.env.REDIS_URL || process.env.NODE_ENV === 'production') {
    redis = new Redis(redisUrl, {
        maxRetriesPerRequest: 3,
        retryStrategy(times) {
            // Exponential backoff: 50, 100, 200, ... max 2000ms
            return Math.min(times * 50, 2000);
        },
        reconnectOnError: (err) => {
            const targetError = 'READONLY';
            if (err.message.includes(targetError)) {
                return true;
            }
            return false;
        }
    });

    redis.on('connect', () => {
        logger.info('Connected to Redis');
    });

    redis.on('error', (err) => {
        // Suppress huge stack traces for connection refused in dev
        if (err.code === 'ECONNREFUSED') {
            logger.warn('Redis connection refused. Caching disabled (Offline Mode).');
        } else {
            logger.error(`Redis Error: ${err.message}`);
        }
    });
} else {
    logger.warn('No REDIS_URL found. Using in-memory mock for development.');
    redis = new Redis({
        lazyConnect: true // Won't connect
    });
    // Mock standard methods to avoid crash
    redis.get = async () => null;
    redis.set = async () => 'OK';
    redis.del = async () => 1;
    redis.publish = async () => 0;
    redis.quit = async () => 'OK';
}

module.exports = redis;
