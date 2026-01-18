const openaiService = require('../services/openai.service');
const scraperService = require('../services/scraper.service');
const rssService = require('../services/rss.service');
const AppError = require('../utils/appError');
const logger = require('../config/logger');

exports.summarizeUrl = async (req, res, next) => {
    try {
        const { url, lang, length, html, style } = req.query;
        if (!url) return next(new AppError('URL required', 400));

        const targetLength = length
            ? Math.max(1, Math.min(parseInt(length, 10), 10))
            : 0;

        const wantHtml = html === 'true' || html === '1';

        logger.info(`Processing Summarize Request: ${url}`);

        // 1. Extract
        const extracted = await scraperService.extract(url);

        // 2. Get text WITHOUT changing structure
        let contentToSummarize =
            extracted.data.data.content.text
        extracted.markdown ||
            extracted.textContent ||
            extracted.content?.text ||
            extracted.content ||
            extracted.html ||
            extracted.rawHtml;

        if (!contentToSummarize) {
            throw new AppError("No content extracted", 400);
        }

        // 3. Clean HTML safely
        contentToSummarize = contentToSummarize
            .replace(/<script[\s\S]*?<\/script>/gi, '')
            .replace(/<style[\s\S]*?<\/style>/gi, '')
            .replace(/<[^>]+>/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

        if (contentToSummarize.length < 20) {
            throw new AppError("Content too short to summarize", 422);
        }

        logger.info(`Summarizing ${contentToSummarize.length} chars...`);

        // 4. Summarize
        let summary = await openaiService.summarize(contentToSummarize, {
            lang: lang || 'en',
            length: targetLength,
            style: style || 'concise'
        });

        // 5. HTML formatting
        if (wantHtml) {
            summary = summary
                .split('\n\n')
                .filter(p => p.trim())
                .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
                .join('');
        }

        // 6. Response (NO structure changes)
        res.status(200).json({
            status: 'success',
            data: {
                summary,
                url: extracted.url || url,
                title: extracted.title || '',
                author: extracted.author || '',
                published: extracted.published || '',
                ttr: extracted.ttr || 0,
                image: extracted.image,
                favicon: extracted.favicon,
                source: extracted.source,
                original_length: contentToSummarize.length
            }
        });

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

        res.status(200).json({
            status: 'success',
            data: { summary, headlines }
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
            // Use Markdown or Text for headlines to save tokens
            content = r.markdown || r.textContent || r.content;
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
