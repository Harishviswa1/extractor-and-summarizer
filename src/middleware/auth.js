const AppError = require('../utils/appError');
const logger = require('../config/logger');

const authCheck = (req, res, next) => {
    // 1) RapidAPI Gateway Authentication
    // When published on RapidAPI, we only accept requests signed with a shared secret
    // that we configure in RapidAPI dashboard ("Transformation" or header injection).
    const rapidApiSecret = req.headers['x-rapidapi-proxy-secret'];
    const backendSecret = process.env.RAPIDAPI_PROXY_SECRET;

    // --- DEBUG START (Temporary) ---
    console.log('[AUTH] Checking Credentials...');
    console.log(`[AUTH] Header (x-rapidapi-proxy-secret): ${rapidApiSecret ? 'PRESENT' : 'MISSING'}`);
    if (rapidApiSecret) console.log(`[AUTH] Header Value (First 5 chars): ${rapidApiSecret.substring(0, 5)}...`);

    console.log(`[AUTH] Env Var (RAPIDAPI_PROXY_SECRET): ${backendSecret ? 'PRESENT' : 'MISSING'}`);
    if (backendSecret) console.log(`[AUTH] Env Value (First 5 chars): ${backendSecret.substring(0, 5)}...`);

    if (rapidApiSecret && backendSecret && rapidApiSecret !== backendSecret) {
        console.log('[AUTH] MISMATCH! The values do not match.');
    }
    // --- DEBUG END ---

    if (backendSecret && rapidApiSecret === backendSecret) {
        // Request came mainly from RapidAPI
        const planHeader = req.headers['x-plan-level'];
        const plan = (planHeader && planHeader.toUpperCase() === 'PRO') ? 'PRO' : 'BASIC';

        req.user = { role: 'MEGA', apiKey: 'rapidapi-gateway', plan };
        return next();
    }

    // 2) Reject everything else
    // Since we removed Admin Key support, any request without the correct RapidAPI Secret is unauthorized.
    logger.warn(`Unauthorized access attempt without valid RapidAPI proxy secret.`);
    return next(new AppError('Unauthorized: Access allowed only via RapidAPI Gateway', 401));
};

module.exports = authCheck;
