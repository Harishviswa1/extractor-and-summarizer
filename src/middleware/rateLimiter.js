const { RateLimiterRedis } = require('rate-limiter-flexible');
const redis = require('../config/redis');
const AppError = require('../utils/appError');
const logger = require('../config/logger');

// Define rate limits per role (monthly request count is harder to track strictly with sliding window in this simple lib without persistent counters, 
// so we will implement the "req/sec" constraints strictly here, and assume monthly is a separate check or handled by billing service)
// Structure: [points, duration_in_seconds]
const RATE_LIMITS = {
    'BASIC': { points: 1, duration: 1 },    // 1 req/sec
    'PRO': { points: 3, duration: 1 },    // 3 req/sec
    'ULTRA': { points: 10, duration: 1 },   // 10 req/sec
    'MEGA': { points: 50, duration: 1 },   // 50 req/sec
    'ADMIN': { points: 1000, duration: 1 }
};

const rateLimiters = {};

// Initialize limiters for each role to avoid re-creating them
Object.keys(RATE_LIMITS).forEach(role => {
    rateLimiters[role] = new RateLimiterRedis({
        storeClient: redis,
        keyPrefix: `rl_${role}`,
        points: RATE_LIMITS[role].points,
        duration: RATE_LIMITS[role].duration,
    });
});

const rateLimiterMiddleware = (req, res, next) => {
    const role = req.user?.role || 'BASIC'; // Default to BASIC if not set
    const key = req.user?.apiKey || req.ip; // Fallback to IP if auth failed but middleware is placed before auth (shouldn't happen)

    if (!rateLimiters[role]) {
        logger.warn(`Unknown role ${role}, falling back to BASIC`);
        // Fallback to BASIC
        return rateLimiters['BASIC'].consume(key)
            .then(() => next())
            .catch(() => next(new AppError('Too many requests. Upgrade your plan.', 429)));
    }

    rateLimiters[role].consume(key)
        .then(() => {
            next();
        })
        .catch((err) => {
            // If it's a RateLimiterRes object, it means they are blocked
            if (err.msBeforeNext) {
                return next(new AppError('Too many requests. Upgrade your plan.', 429));
            }

            // If it's not a RateLimiterRes, it's likely a Redis/Network error.
            // "Fail Open": Allow the user to proceed so infrastructure issues don't block them.
            logger.error('Rate Limiter Error (Failing Open):', err);
            next();
        });
};

module.exports = rateLimiterMiddleware;
