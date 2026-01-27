const openaiService = require('../services/openai.service');
const scraperService = require('../services/scraper.service');
const AppError = require('../utils/appError');
const { v4: uuidv4 } = require('uuid');
const redis = require('../config/redis');

const getContent = async (req) => {
    const { url, text } = req.body;

    // Prioritize URL extraction as requested
    if (url) {
        // Use ScraperService (Cached extraction), pass Plan
        const result = await scraperService.extract(url, uuidv4(), req.user?.plan);

        // Payload Optimization: Use Markdown (Cleanest for AI) > TextContent > Content
        const content = result.markdown || result.textContent || result.content;

        if (!content || content.length < 50) {
            throw new AppError('Extracted content is too short or empty', 422);
        }
        return content;
    }

    return text;
};

exports.analyze = async (req, res, next) => {
    try {
        if (req.user?.plan === 'BASIC') {
            return next(new AppError('Analyze feature is only available on the Pro Plan. Please upgrade.', 403));
        }

        const { url } = req.query; // Changed from body to query

        if (!url) {
            return next(new AppError('URL is required for GET analysis.', 400));
        }

        // 1. Check Cache
        const cacheKey = `analyze:v1:${url}`;
        const cached = await redis.get(cacheKey);
        if (cached) {
            return res.status(200).json({ status: 'success', data: JSON.parse(cached) });
        }

        let content = '';
        let metadata = {};

        // Get full extraction result to assert image and original description
        const extracted = await scraperService.extract(url, uuidv4(), req.user?.plan);
        content = extracted.markdown || extracted.textContent || extracted.content;

        // Extract metadata fields
        metadata = {
            image: extracted.image || extracted.leadImageUrl || null,
            original_description: extracted.excerpt || extracted.description || null,
            title: extracted.title,
            author: extracted.author,
            published: extracted.published
        };

        if (!content || content.length < 50) {
            throw new AppError('Extracted content is too short or empty', 422);
        }


        // Perform AI Analysis
        const analysis = await openaiService.analyze(content);

        // Merge AI Analysis with Extracted Metadata
        const finalResult = { ...analysis, ...metadata };

        // 2. Set Cache
        if (url) {
            await redis.set(`analyze:v1:${url}`, JSON.stringify(finalResult), 'EX', 86400);
        }

        res.status(200).json({
            status: 'success',
            data: finalResult
        });
    } catch (err) {
        next(err);
    }
};

exports.rewrite = async (req, res, next) => {
    try {
        if (req.user?.plan === 'BASIC') {
            return next(new AppError('Rewrite feature is only available on the Pro Plan. Please upgrade.', 403));
        }

        // Accept dynamic params (Removed tone/audience)
        const { url, format, length, lang } = req.query; // Changed from body to query

        if (!url) {
            return next(new AppError('URL is required for GET rewrite.', 400));
        }

        // 1. Check Cache
        let cacheKey = null;
        if (url) {
            const safeFormat = format || 'concise';
            const safeLang = lang || 'en';
            // Cache Key updated (Tone/Audience removed)
            cacheKey = `rewrite:v2:${url}:${safeFormat}:${safeLang}:${length || 'med'}`;

            const cached = await redis.get(cacheKey);
            if (cached) {
                return res.status(200).json({ status: 'success', data: JSON.parse(cached) });
            }
        }

        // Use ScraperService directly for GET (no text fallback)
        const extracted = await scraperService.extract(url, uuidv4(), req.user?.plan);
        const content = extracted.markdown || extracted.textContent || extracted.content;

        // Pass all options to service
        const result = await openaiService.rewrite(content, {
            format: format || 'concise',
            length,
            lang: lang || 'en'
            // tone/audience defaults handled in service if not passed
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
