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

    // 2) Direct API Key (Legacy/Dev/Direct B2B)
    const apiKey = req.headers['x-api-key'];

    if (!apiKey) {
        return next(new AppError('Unauthorized: No API Key or RapidAPI Secret provided', 401));
    }

    // START_HACK: Simulating key lookup
    let role = 'BASIC';
    if (apiKey.startsWith('pro_')) role = 'PRO';
    if (apiKey.startsWith('ultra_')) role = 'ULTRA';
    if (apiKey.startsWith('mega_')) role = 'MEGA';
    if (apiKey === process.env.ADMIN_API_KEY) role = 'ADMIN';

    req.user = {
        apiKey,
        role
    };
    // END_HACK

    logger.info(`Authenticated request with role: ${role}`);
    next();
};

module.exports = authCheck;
