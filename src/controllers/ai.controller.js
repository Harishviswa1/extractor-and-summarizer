const openaiService = require('../services/openai.service');
const scraperService = require('../services/scraper.service');
const AppError = require('../utils/appError');
const { v4: uuidv4 } = require('uuid');

// Helper to get text from URL or Body
const getContent = async (req) => {
    const { url, text } = req.body;

    // Prioritize URL extraction as requested
    if (url) {
        const result = await scraperService.extract(url, uuidv4()); // generate temp job id
        // Prefer markdown for AI tasks as it's cleaner, fallback to textContent
        return result.markdown || result.textContent || result.content;
    }

    // Fallback to text if allowed (though prompt imply URL focus, flexibility is good)
    return text;
};

exports.analyze = async (req, res, next) => {
    try {
        const { url } = req.body;
        if (!url) return next(new AppError('URL is required', 400));

        const content = await getContent(req);
        if (!content) return next(new AppError('Could not extract content from URL', 400));

        const analysis = await openaiService.analyze(content);

        res.status(200).json({
            status: 'success',
            data: analysis
        });
    } catch (err) {
        next(err);
    }
};

exports.rewrite = async (req, res, next) => {
    try {
        const { url, format, tone, audience, length } = req.body;
        if (!url) return next(new AppError('URL is required', 400));

        const content = await getContent(req);
        if (!content) return next(new AppError('Could not extract content from URL', 400));

        const result = await openaiService.rewrite(content, { format, tone, audience, length });

        res.status(200).json({
            status: 'success',
            data: result
        });
    } catch (err) {
        next(err);
    }
};
