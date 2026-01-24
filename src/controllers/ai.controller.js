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
        const { url } = req.body;

        // 1. Check Cache
        if (url) {
            const cacheKey = `analyze:v1:${url}`;
            const cached = await redis.get(cacheKey);
            if (cached) {
                return res.status(200).json({ status: 'success', data: JSON.parse(cached) });
            }
        }

        const content = await getContent(req);
        const analysis = await openaiService.analyze(content);

        // 2. Set Cache
        if (url) {
            await redis.set(`analyze:v1:${url}`, JSON.stringify(analysis), 'EX', 86400);
        }

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
        const { url, format, tone, audience, length, lang } = req.body;

        // 1. Check Cache
        let cacheKey = null;
        if (url) {
            // Key includes all parameters affecting output
            const safeFormat = format || 'concise';
            const safeLang = lang || 'en';
            // Include other params to avoid collisions
            cacheKey = `rewrite:v1:${url}:${safeFormat}:${safeLang}:${length || 'med'}`;

            const cached = await redis.get(cacheKey);
            if (cached) {
                return res.status(200).json({ status: 'success', data: JSON.parse(cached) });
            }
        }

        const content = await getContent(req);

        // Pass all options to service
        const result = await openaiService.rewrite(content, {
            format: format || 'concise', // Default handled in service too, but good to be explicit
            tone,
            audience,
            length,
            lang: lang || 'en' // Default language
        });

        // Optimization: Clean up excess newlines if they are just artifacts
        if (result.rewritten_text && typeof result.rewritten_text === 'string') {
            // If format clearly implies blocks (like linkedin/blog), we might WANT newlines. 
            // But user explicitly complained about \n artifacts. 
            // We'll normalize multiple newlines to single, or space if concise.
            if (format === 'concise' || format === 'one-sentence' || !format) {
                result.rewritten_text = result.rewritten_text.replace(/\s+/g, ' ').trim();
            } else {
                // For others, just ensure we don't have excessive gaps (e.g. \n\n\n)
                result.rewritten_text = result.rewritten_text.replace(/\n{3,}/g, '\n\n').trim();
            }
        }

        // 2. Set Cache
        if (cacheKey) {
            await redis.set(cacheKey, JSON.stringify(result), 'EX', 86400);
        }

        res.status(200).json({
            status: 'success',
            data: result
        });
    } catch (err) {
        next(err);
    }
};
