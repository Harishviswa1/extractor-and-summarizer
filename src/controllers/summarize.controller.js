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
        const extracted = await scraperService.extract(url);

        // 3. Null Handling & Payload Optimization
        // Only use the most lightweight yet complete content available.
        // Preference: Markdown (cleanest) > TextContent (clean) > Content (raw html)
        const contentToSummarize = extracted.markdown || extracted.textContent;

        if (!contentToSummarize || contentToSummarize.trim().length < 50) {
            throw new AppError("Extracted content is null or too short to summarize.", 422);
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
            // Clean up excess newlines for JSON output if not HTML
            // e.g. "Line 1\n\nLine 2" -> "Line 1 Line 2"
            // Using space or keeping single newline depends on user preference. 
            // "Including \ns in the summary" usually implies they want a single block.
            // We will normalize to single spaces if concise, or preserve paragraphs if it looks like a list?
            // Safest for "data" is probably removing newlines if style is 'concise'.
            if (!style || style === 'concise' || style === 'headline') {
                summary = summary.replace(/\s+/g, ' ').trim();
            }
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
        let cleanSummary = summary;
        if (!style || style === 'concise' || style === 'headline') {
            cleanSummary = summary.replace(/\s+/g, ' ').trim();
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

        const [r1, r2] = await Promise.all([
            scraperService.extract(url1),
            scraperService.extract(url2)
        ]);

        // Use Markdown or Text for comparison to save tokens and improve quality
        const t1 = r1.markdown || r1.textContent || r1.content;
        const t2 = r2.markdown || r2.textContent || r2.content;

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
