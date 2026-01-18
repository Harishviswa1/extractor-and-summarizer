const openaiService = require('../services/openai.service');
const scraperService = require('../services/scraper.service');
const rssService = require('../services/rss.service');
const AppError = require('../utils/appError');
const logger = require('../config/logger');

exports.summarizeUrl = async (req, res, next) => {
    try {
        const { url, lang, style } = req.query;
        if (!url) return next(new AppError('URL required', 400));

        // 1. Extract (Returns flat object: { url, markdown, title, author, ... })
        const extracted = await scraperService.extract(url);

        // 2. Prepare Content (Priority: Markdown > Text > HTML)
        const contentToSummarize = extracted.markdown || extracted.textContent || extracted.content?.text || extracted.content ||
            "";

        if (!contentToSummarize.trim()) {
            return next(new AppError("Could not extract readable content from URL", 400));
        }

        logger.info(`Summarizing content length: ${contentToSummarize.length} chars`);

        // 3. Parallel Execution: Summarize + Headlines
        const [summary, headlines] = await Promise.all([
            openaiService.summarize(contentToSummarize, lang || 'en', style || 'bullet'),
            openaiService.generateHeadlines(contentToSummarize)
        ]);

        // 4. Return Clean Response
        res.status(200).json({
            status: 'success',
            data: {
                summary,
                headlines,
                url: extracted.url,
                title: extracted.title,
                author: extracted.author,
                published: extracted.published,
                ttr: extracted.ttr,
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

        const summary = await openaiService.summarize(text, lang || 'en', style || 'bullet');

        res.status(200).json({
            status: 'success',
            data: { summary }
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
