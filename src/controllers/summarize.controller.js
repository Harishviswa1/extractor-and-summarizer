const openaiService = require('../services/openai.service');
const scraperService = require('../services/scraper.service');
const rssService = require('../services/rss.service');
const AppError = require('../utils/appError');

exports.summarizeUrl = async (req, res, next) => {
    try {
        const { url, lang, style } = req.query;
        if (!url) return next(new AppError('URL required', 400));

        // 1. Extract
        const extracted = await scraperService.extract(url);

        // 2. Summarize
        const summary = await openaiService.summarize(extracted.content, lang || 'en', style || 'bullet');

        res.status(200).json({
            status: 'success',
            data: {
                summary,
                original_length: extracted.content.length
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

        const comparison = await openaiService.compare(r1.content, r2.content);

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
            content = r.content;
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
