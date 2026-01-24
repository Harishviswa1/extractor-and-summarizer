const openaiService = require('../services/openai.service');
const scraperService = require('../services/scraper.service');
const AppError = require('../utils/appError');
const { v4: uuidv4 } = require('uuid');

// Helper to get text from URL or Body (Optimized)
const getContent = async (req) => {
    const { url, text } = req.body;

    // Prioritize URL extraction as requested
    if (url) {
        // Use ScraperService (Cached extraction)
        const result = await scraperService.extract(url, uuidv4());

        // Payload Optimization: Use Markdown (Cleanest for AI) > TextContent > Content
        const content = result.markdown || result.textContent || result.content;

        if (!content || content.length < 50) {
            throw new AppError('Extracted content is too short or empty', 422);
        }
        return content;
    }

    // Fallback to text
    return text;
};

exports.analyze = async (req, res, next) => {
    try {
        const content = await getContent(req);
        // Analyze logic remains same, extraction is now optimized
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
        // Accept dynamic params
        const { format, tone, audience, length, lang } = req.body;

        const content = await getContent(req);

        // Pass all options to service
        const result = await openaiService.rewrite(content, {
            format: format || 'concise', // Default handled in service too, but good to be explicit
            tone,
            audience,
            length,
            lang: lang || 'en' // Default language
        });

        res.status(200).json({
            status: 'success',
            data: result
        });
    } catch (err) {
        next(err);
    }
};
