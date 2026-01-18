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
        if (!url) return next(new AppError('URL is required', 400));

        // Use cached jobId or create new one (logic inside service)
        // For the simple /extract endpoint we might not need to expose jobId unless requested,
        // but the service handles it.

        const jobId = uuidv4();
        const start = Date.now();
        const result = await scraperService.extract(url, jobId);

        res.status(200).json({
            status: 'success',
            meta: {
                url: result.url,
                strategy: result.strategy || 'unknown',
                extracted_at: new Date().toISOString()
            },
            data: {
                title: result.title,
                author: result.author,
                published_date: result.published,
                site_name: result.source,
                description: result.description,
                image: result.image,
                favicon: result.favicon,
                stats: {
                    word_count: result.textContent ? result.textContent.split(/\s+/).length : 0,
                    minutes_to_read: result.ttr
                },
                content: {
                    text: result.textContent,
                    html: result.content,
                    markdown: result.markdown
                },
                links: result.links
            }
        });
    } catch (err) {
        next(err);
    }
};
