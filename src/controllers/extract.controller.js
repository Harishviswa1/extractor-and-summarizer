const scraperService = require('../services/scraper.service');
const AppError = require('../utils/appError');
const { v4: uuidv4 } = require('uuid');

exports.extractUrl = async (req, res, next) => {
    try {
        const { url } = req.query;
        if (!url) return next(new AppError('URL is required', 400));

        const jobId = uuidv4();
        // Pass User Plan to enforce limits (Basic vs Pro)
        const result = await scraperService.extract(url, jobId, req.user?.plan);

        // Remove strategy and extractedAt from data object as requested by user
        // We return a flattened object in 'data' without the internal 'meta' or 'strategy' keys
        const { strategy, extractedAt, ...cleanedResult } = result;

        res.status(200).json({
            status: 'success',
            data: cleanedResult
        });
    } catch (err) {
        next(err);
    }
};
