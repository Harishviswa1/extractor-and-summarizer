const openaiService = require('../services/openai.service');
const scraperService = require('../services/scraper.service');
const rssService = require('../services/rss.service');
const AppError = require('../utils/appError');
const logger = require('../config/logger');

const { chromium } = require('playwright');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const axios = require('axios'); // Add axios

exports.summarizeUrl = async (req, res, next) => {
    let browser = null;
    try {
        const { url, lang, length, html, style } = req.query;
        if (!url) return next(new AppError('URL required', 400));

        const targetLength = length ? Math.max(1, Math.min(parseInt(length, 10), 10)) : 0;
        const wantHtml = html === 'true' || html === '1';

        logger.info(`Processing Summarize Request: ${url}`);

        let contentToSummarize = null;
        let title = '';
        let author = '';

        // --- Fast Path: Fetch + Readability ---
        try {
            logger.info('Attempting Fast Fetch...');
            const response = await axios.get(url, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Referer': 'https://www.google.com/'
                },
                timeout: 5000 // Short timeout for fast path
            });

            const doc = new JSDOM(response.data, { url });
            const reader = new Readability(doc.window.document);
            const article = reader.parse();

            if (article && article.textContent && article.textContent.trim().length > 200) {
                contentToSummarize = article.textContent;
                title = article.title;
                author = article.byline;
                logger.info('Fast Fetch Success!');
            }
        } catch (fetchErr) {
            logger.warn(`Fast fetch failed or insufficient: ${fetchErr.message}`);
        }

        // --- Fallback: Playwright (if Fast Path failed) ---
        // Helper to detect bot blocks
        const isBotCheck = (t, txt) => {
            const lowT = (t || '').toLowerCase();
            const lowTxt = (txt || '').toLowerCase();
            return lowT.includes('are you a robot') || lowT.includes('security check') || lowTxt.includes('unusual activity');
        };

        // --- Fallback: Playwright (if Fast Path failed or was blocked) ---
        if (!contentToSummarize || isBotCheck(title, contentToSummarize)) {
            logger.info('Falling back to Playwright (Regular)...');

            const runPlaywright = async (targetUrl, useProxy = false) => {
                let context = null;
                let browserInstance = null; // Renamed to avoid conflict with outer 'browser'
                try {
                    browserInstance = await chromium.launch({
                        headless: true,
                        args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
                        proxy: useProxy && process.env.PROXY_SERVER_URL ? { server: process.env.PROXY_SERVER_URL } : undefined
                    });
                    context = await browserInstance.newContext({
                        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                        extraHTTPHeaders: { 'Referer': 'https://www.google.com/', 'Accept-Language': 'en-US,en;q=0.9' }
                    });
                    const page = await context.newPage();
                    await page.addInitScript(() => Object.defineProperty(navigator, 'webdriver', { get: () => undefined }));

                    // Route blocking
                    await page.route('**/*.{png,jpg,jpeg,gif,svg,css,woff,woff2,mp4,webm,mp3,wav,ico,pdf,zip}', route => route.abort());
                    await page.route('**/*analytics*', route => route.abort());
                    await page.route('**/*ads*', route => route.abort());

                    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                    await page.evaluate(() => document.querySelectorAll('script, style, noscript, iframe, svg, nav, footer, .ad, .ads, [role="alert"]').forEach(el => el.remove()));

                    const content = await page.content();
                    await browserInstance.close();

                    const d = new JSDOM(content, { url: targetUrl });
                    const r = new Readability(d.window.document);
                    return r.parse();
                } catch (e) {
                    logger.warn(`Playwright run failed for ${targetUrl}: ${e.message}`);
                    if (browserInstance) await browserInstance.close();
                    return null;
                }
            };

            // 2. Try Direct Playwright
            let article = await runPlaywright(url);

            // 3. Try Google Cache if blocked
            if (!article || !article.textContent || isBotCheck(article.title, article.textContent)) {
                logger.info('Direct Playwright failed/blocked. Trying Google Cache...');
                const cacheUrl = `http://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
                article = await runPlaywright(cacheUrl);
            }

            // 4. Try Proxy if available and still blocked
            if ((!article || !article.textContent || isBotCheck(article.title, article.textContent)) && process.env.PROXY_SERVER_URL) {
                logger.info('Google Cache failed. Trying Proxy...');
                article = await runPlaywright(url, true);
            }

            if (article && article.textContent && article.textContent.trim().length > 50) {
                contentToSummarize = article.textContent;
                title = article.title;
                author = article.byline;
            }
        }

        if (!contentToSummarize || contentToSummarize.trim().length < 50) {
            throw new AppError("Could not extract readable content from URL", 400);
        }

        logger.info(`Summarizing ${contentToSummarize.length} chars...`);

        // Summarize
        let summary = await openaiService.summarize(contentToSummarize, {
            lang: lang || 'en',
            length: targetLength,
            style: style || 'concise'
        });

        // HTML formatting
        if (wantHtml) {
            summary = summary
                .split('\n\n')
                .filter(p => p.trim())
                .map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`)
                .join('');
        }

        res.status(200).json({
            status: 'success',
            data: {
                summary,
                url: url,
                title: title || '',
                author: author || '',
                published: '',
                ttr: Math.ceil(contentToSummarize.split(/\s+/).length / 200),
                original_length: contentToSummarize.length
            }
        });

    } catch (err) {
        if (browser) await browser.close();
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
