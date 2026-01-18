const scraperService = require('../services/scraper.service');
const AppError = require('../utils/appError');
const { v4: uuidv4 } = require('uuid');

exports.extractUrl = async (req, res, next) => {
    try {
        const { url } = req.query;
        if (!url) {
            return next(new AppError('URL is required', 400));
        }

        // Job ID for tracking progress if we were async, currently we await
        // In a real 'job' system we'd return 202 Accepted and a Job ID immediately.
        // But the requirement implies GET /extract returns result directly or sync?
        // Requirement 1) says "GET /extract?url= - Extract main article body". Usually GET is sync.
        // However, Requirement 7) says "GET /results/:jobId Public result viewer".
        // Let's support both. If ?async=true, return jobID. Else wait.

        const jobId = uuidv4();

        // This might take time (Playwright), so we should use timeouts carefully or default to async.
        // For this implementation, we await but also update job status for sockets.

        const result = await scraperService.extract(url, jobId);

        // Remove internal system fields as requested by user
        delete result.strategy;
        delete result.extractedAt;

        res.status(200).json({
            status: 'success',
            data: { ...result, jobId }
        });
    } catch (err) {
        next(err);
    }
};
