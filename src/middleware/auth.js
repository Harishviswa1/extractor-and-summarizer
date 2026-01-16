const AppError = require('../utils/appError');
const logger = require('../config/logger');

const authCheck = (req, res, next) => {
    // 1) RapidAPI Gateway Authentication
    // When published on RapidAPI, we only accept requests signed with a shared secret
    // that we configure in RapidAPI dashboard ("Transformation" or header injection).
    const rapidApiSecret = req.headers['x-rapidapi-proxy-secret'];
    const backendSecret = process.env.RAPIDAPI_PROXY_SECRET;

    if (backendSecret && rapidApiSecret === backendSecret) {
        // Request came mainly from RapidAPI
        // RapidAPI doesn't forward the original user's plan by default unless we use proper headers.
        // For simplicity, we assume generic "PRO" access for RapidAPI requests to allow high throughput
        // OR we can trust RapidAPI's own rate limiting.
        req.user = { role: 'MEGA', apiKey: 'rapidapi-gateway' };
        return next();
    }

    // 2) Direct API Key (Admin / Internal Service)
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) {
        return next(new AppError('Unauthorized: No API Key or RapidAPI Secret provided', 401));
    }

    // STRICT CHECK: Only allow Admin Key for direct access
    // This prevents random strings like '1234' from working freely.
    if (apiKey === process.env.ADMIN_API_KEY) {
        req.user = { apiKey, role: 'ADMIN' };
        logger.info('Authenticated request with role: ADMIN');
        return next();
    }

    // If you want to support manual Keys for friends/clients outside RapidAPI, add them here:
    // if (apiKey === 'some-client-key') { ... }

    // If we get here, the key is invalid
    logger.warn(`Invalid API Key attempt: ${apiKey}`);
    return next(new AppError('Unauthorized: Invalid API Key', 401));
};

module.exports = authCheck;
