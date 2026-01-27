const openaiService = require('../services/openai.service');
const scraperService = require('../services/scraper.service');
const rssService = require('../services/rss.service');
const AppError = require('../utils/appError');
const logger = require('../config/logger');
const redis = require('../config/redis'); // Added for summary caching

// Unused imports removed (Puppeteer, JSDOM, etc.) - delegated to scraperService

exports.summarizeUrl = async (req, res, next) => {
    try {
        const { url, lang, length, html, style } = req.query;
        if (!url) return next(new AppError('URL required', 400));

        const targetLength = length ? Math.max(1, Math.min(parseInt(length, 10), 10)) : 0;
        const wantHtml = html === 'true' || html === '1';
        const targetLang = lang || 'en';
        const targetStyle = style || 'concise';

        // 1. Check Cache (Summary Cache)
        const summaryCacheKey = `summary:v1:${url}:${targetLang}:${targetLength}:${targetStyle}`;
        const cachedSummary = await redis.get(summaryCacheKey);

        if (cachedSummary) {
            logger.info(`Summary Cache hit for ${url}`);
            return res.status(200).json(JSON.parse(cachedSummary));
        }

        logger.info(`Processing Summarize Request: ${url}`);

        // 2. Extract Content (Delegated to Optimized ScraperService)
        // This handles "Fast fetch", "Puppeteer Stealth", "Google Cache", etc. internally.
        // 2. Extract Content (Delegated to Optimized ScraperService)
        // Pass plan to scraper (might block if puppeteer needed and Basic plan)
        const extracted = await scraperService.extract(url, null, req.user?.plan);

        // 3. Null Handling & Payload Optimization
        // Only use the most lightweight yet complete content available.
        // Preference: Markdown (cleanest) > TextContent (clean) > Content (raw html)
        const contentToSummarize = extracted.markdown || extracted.textContent;

        if (!contentToSummarize || contentToSummarize.trim().length < 50) {
            throw new AppError("Extracted content is null or too short to summarize.", 422);
        }

        // Tier Check: Length Limit
        if (req.user?.plan === 'BASIC' && contentToSummarize.length > 5000) {
            throw new AppError(`Basic Plan Limit: Article too long (${contentToSummarize.length} chars). Basic plan limit is 5000 characters. Please upgrade to Pro.`, 403);
        }

        logger.info(`Summarizing ${contentToSummarize.length} chars...`);

        // 4. Summarize via OpenAI
        let summary = await openaiService.summarize(contentToSummarize, {
            lang: targetLang,
            length: targetLength,
            style: targetStyle
        });

        // 5. HTML formatting (if requested)
        if (wantHtml) {
            summary = summary
                .split('\n\n')
                .filter(p => p.trim())
                .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
                .join('');
        } else {
            // Aggressive Cleanup for ALL Styles (User request: No \n, No HTML)
            // This will turn lists into "1. Point One. 2. Point Two."
            summary = summary
                .replace(/<[^>]*>?/gm, '') // Remove HTML tags
                .replace(/\\n/g, ' ')      // Remove escaped newlines
                .replace(/\n/g, ' ')       // Remove literal newlines
                .replace(/\s+/g, ' ')      // Collapse spaces
                .trim();
        }

        const responseData = {
            status: 'success',
            data: {
                summary,
                url: url,
                title: extracted.title || '',
                author: extracted.author || '',
                published: extracted.published || '',
                ttr: extracted.ttr || 0,
                original_length: contentToSummarize.length
            }
        };

        // 6. Set Cache (Ex: 24 hours)
        await redis.set(summaryCacheKey, JSON.stringify(responseData), 'EX', 86400);

        res.status(200).json(responseData);

    } catch (err) {
        next(err);
    }
};



exports.summarizeText = async (req, res, next) => {
    try {
        const { text, lang, style } = req.body;
        if (!text) return next(new AppError('Text content required', 400));

        const [summary, headlines] = await Promise.all([
            openaiService.summarize(text, { lang: lang || 'en', style: style || 'bullet' }),
            openaiService.generateHeadlines(text)
        ]);

        // Clean up newlines for cleaner JSON
        // Clean up newlines for cleaner JSON
        let cleanSummary = summary;
        if (!style || style === 'concise' || style === 'headline') {
            cleanSummary = summary
                .replace(/<[^>]*>?/gm, '') // Remove HTML tags
                .replace(/\\n/g, ' ')      // Remove escaped newlines
                .replace(/\n/g, ' ')       // Remove literal newlines
                .replace(/\s+/g, ' ')      // Collapse spaces
                .trim();
        }

        res.status(200).json({
            status: 'success',
            data: { summary: cleanSummary, headlines }
        });
    } catch (err) {
        next(err);
    }
};

exports.compare = async (req, res, next) => {
    try {
        const { url1, url2 } = req.body;
        if (!url1 || !url2) return next(new AppError('Two URLs required', 400));

        const results = await Promise.allSettled([
            scraperService.extract(url1),
            scraperService.extract(url2)
        ]);

        const [r1, r2] = results;

        // Check for Failures
        if (r1.status === 'rejected') {
            return next(new AppError(`Failed to extract content from URL 1 (${url1}): ${r1.reason.message}`, 422));
        }
        if (r2.status === 'rejected') {
            return next(new AppError(`Failed to extract content from URL 2 (${url2}): ${r2.reason.message}`, 422));
        }

        const data1 = r1.value;
        const data2 = r2.value;

        // Use Markdown or Text
        const t1 = data1.markdown || data1.textContent || data1.content;
        const t2 = data2.markdown || data2.textContent || data2.content;

        if (!t1 || t1.length < 50) return next(new AppError('Content too short for URL 1', 422));
        if (!t2 || t2.length < 50) return next(new AppError('Content too short for URL 2', 422));

        const comparison = await openaiService.compare(t1, t2);

        res.status(200).json({
            status: 'success',
            data: comparison
        });
    } catch (err) {
        next(err);
    }
};

exports.headlines = async (req, res, next) => {
    try {
        const { text, url } = req.body;
        let content = text;

        if (url && !content) {
            const r = await scraperService.extract(url);
            // Use textContent for headlines to save tokens (faster/cheaper) and rely on truncation
            content = r.textContent || r.markdown || r.content;
        }

        if (!content) return next(new AppError('Text or URL required', 400));

        const headlines = await openaiService.generateHeadlines(content);

        res.status(200).json({
            status: 'success',
            data: headlines
        });
    } catch (err) {
        next(err);
    }
};

exports.monitorRss = async (req, res, next) => {
    try {
        const { url, webhook } = req.body;
        if (!url) return next(new AppError('RSS URL required', 400));

        const id = await rssService.addFeed(url, webhook);

        res.status(200).json({
            status: 'success',
            message: 'Feed added to monitor',
            feedId: id
        });
    } catch (err) {
        next(err);
    }
};
