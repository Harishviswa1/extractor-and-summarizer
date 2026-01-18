const axios = require('axios');
const cheerio = require('cheerio');
const { chromium } = require('playwright');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const TurndownService = require('turndown');
const redis = require('../config/redis');
const logger = require('../config/logger');
const AppError = require('../utils/appError');
const { v4: uuidv4 } = require('uuid');

class ScraperService {
    constructor() {
        this.browser = null;
    }

    async initBrowser() {
        if (!this.browser) {
            logger.info('Launching Playwright Browser...');
            this.browser = await chromium.launch({
                headless: true,
                args: ['--no-sandbox', '--disable-setuid-sandbox']
            });
        }
        return this.browser;
    }

    async closeBrowser() {
        if (this.browser) {
            await this.browser.close();
            this.browser = null;
        }
    }

    async extract(url, jobId = null) {
        // Cache Busting: Changed to v2 to invalidate old nested structures
        const cacheKey = `extract:v2:${url}`;
        const cached = await redis.get(cacheKey);

        if (cached) {
            logger.info(`Cache hit for ${url}`);
            if (jobId) await this.updateJob(jobId, 'completed', JSON.parse(cached));
            return JSON.parse(cached);
        }

        if (jobId) await this.updateJob(jobId, 'fetching');

        let content = null;
        let strategy = 'fetch-readability';

        try {
            logger.info(`Attempting Layer 1 (Fetch) for ${url}`);
            content = await this.fetchAndParse(url);
        } catch (err) {
            logger.warn(`Layer 1 failed for ${url}: ${err.message}. Switching to Layer 2.`);
            strategy = 'playwright-readability';
        }

        if (!content || !content.textContent || content.textContent.length < 200 || this.isBotCheck(content.title, content.textContent)) {
            logger.info(`Content insufficient or Bot Block detected. Switching to Layer 2 (Playwright) for ${url}`);

            try {
                content = await this.playwrightParse(url);
                strategy = 'playwright-readability';
            } catch (err) {
                logger.error(`Layer 2 failed for ${url}: ${err.message}`);
                // Proceed to next fallback
            }
        }

        // Layer 3: Google Cache Fallback (New)
        if (!content || !content.textContent || content.textContent.length < 200 || this.isBotCheck(content.title, content.textContent)) {
            logger.info(`Layer 2 failed/blocked. Attempting Layer 3 (Google Cache) for ${url}`);
            try {
                const cacheUrl = `http://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
                content = await this.playwrightParse(cacheUrl);
                // Clean up Google Header artifacts if successful
                if (content && content.textContent) {
                    content.title = content.title.replace(' - Google Search', '').replace('cache:', '');
                    strategy = 'google-cache';
                }
            } catch (err) {
                logger.warn(`Layer 3 (Google Cache) failed: ${err.message}`);
            }
        }

        // Layer 4: Proxy Fallback (Existing)
        if (!content || !content.textContent || content.textContent.length < 200 || this.isBotCheck(content.title, content.textContent)) {
            if (process.env.PROXY_SERVER_URL) {
                logger.info(`Retrying ${url} with proxy...`);
                content = await this.playwrightParse(url, {
                    proxy: process.env.PROXY_SERVER_URL
                });
                strategy = 'playwright-proxy';
            }
        }

        if (!content || !content.textContent || content.textContent.length === 0) {
            throw new AppError('Unable to extract meaningful content', 422);
        }

        const result = {
            url,
            ...content,   // title, author, content, stats etc (UNCHANGED)
        };

        await redis.set(cacheKey, JSON.stringify(result), 'EX', 86400);

        if (jobId) await this.updateJob(jobId, 'completed', result);

        return result;
    }

    async fetchAndParse(url) {
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
                'Accept-Language': 'en-US,en;q=0.9',
                'Accept-Encoding': 'gzip, deflate, br',
                'Connection': 'keep-alive',
                'Upgrade-Insecure-Requests': '1',
                'Sec-Fetch-Dest': 'document',
                'Sec-Fetch-Mode': 'navigate',
                'Sec-Fetch-Site': 'none',
                'Sec-Fetch-User': '?1',
                'Cache-Control': 'max-age=0',
                'Referer': 'https://www.google.com/' // Bypass some soft paywalls
            },
            timeout: 10000,
            validateStatus: (status) => status < 400
        });
        return this.parseHtml(response.data, url);
    }

    async playwrightParse(url, opts = {}) {
        const browser = await chromium.launch({
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-blink-features=AutomationControlled'],
            proxy: opts.proxy ? { server: opts.proxy } : undefined
        });

        const context = await browser.newContext({
            userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36",
            locale: 'en-US',
            extraHTTPHeaders: {
                'Referer': 'https://www.google.com/',
                'Accept-Language': 'en-US,en;q=0.9'
            },
            viewport: { width: 1920, height: 1080 }
        });

        const page = await context.newPage();

        try {
            // Evasion
            await page.addInitScript(() => {
                Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
            });

            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });

            // Try waiting for main content selector (improves NYT success)
            try {
                await page.waitForSelector('article, main, [role="main"], h1', { timeout: 5000 });
            } catch (e) { /* ignore and proceed with what we have */ }

            // Scroll to load lazy content
            await page.evaluate(() => {
                window.scrollTo(0, document.body.scrollHeight);
            });
            await page.waitForTimeout(1000); // Short grace period

            const html = await page.content();
            await browser.close();
            return this.parseHtml(html, url);
        } catch (e) {
            await browser.close();
            throw e;
        }
    }


    parseHtml(html, url) {
        // 1. Basic Setup
        const $ = cheerio.load(html);
        const turndownService = new TurndownService();

        // 2. Extract Metadata (BEFORE cleaning)
        const jsonLd = this.extractJsonLd($);
        const metadata = {
            title: $('meta[property="og:title"]').attr('content') || $('title').text() || jsonLd.headline || '',
            description: $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || jsonLd.description || '',
            author: $('meta[name="author"]').attr('content') || $('meta[property="article:author"]').attr('content') || jsonLd.author || '',
            image: $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content') || jsonLd.image || '',
            published: $('meta[property="article:published_time"]').attr('content') || $('time').attr('datetime') || $('meta[name="date"]').attr('content') || jsonLd.datePublished || '',
            source: new URL(url).hostname.replace('www.', ''),
            favicon: `https://www.google.com/s2/favicons?domain=${new URL(url).hostname}`
        };

        // 3. Clean for Readability
        $('script, style, noscript, iframe, svg, nav, footer, .ad, .ads, .social-share, .cookie-consent, [role="alert"]').remove();
        const cleanHtml = $.html();

        // 4. Readability Parse
        const doc = new JSDOM(cleanHtml, { url });
        const reader = new Readability(doc.window.document);
        const article = reader.parse();

        // Helper: Collapse Internal Whitespace
        const cleanText = (txt) => txt.replace(/\s+/g, ' ').trim();

        // 5. Construct Result
        if (article) {
            const markdown = turndownService.turndown(article.content);
            const wordCount = article.textContent.split(/\s+/).length;

            return {
                ...metadata,
                title: article.title || metadata.title,
                textContent: cleanText(article.textContent),
                content: article.content,
                markdown: markdown,
                ttr: Math.ceil(wordCount / 200),
                links: this.extractLinks(cleanHtml, url)
            };
        }

        // Fallback (Layer 3)
        logger.warn(`Readability failed for ${url}. Using Raw Fallback.`);
        // Improve Raw Text Cleaning: Decode entities & collapse spaces
        const rawBody = $('body').text();
        const cleanedRaw = cleanText(rawBody); // simple replace is usually enough for basic entities via cheerio .text()

        if (cleanedRaw.length > 50) {
            return {
                ...metadata,
                content: $('body').html(),
                textContent: cleanedRaw,
                markdown: turndownService.turndown($('body').html()),
                ttr: Math.ceil(cleanedRaw.split(/\s+/).length / 200),
                links: []
            };
        }

        return null;
    }

    extractLinks(html, baseUrl) {
        const $ = cheerio.load(html);
        const links = [];
        $('a').each((i, el) => {
            const href = $(el).attr('href');
            if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
                try {
                    links.push(new URL(href, baseUrl).href);
                } catch (e) { /* ignore invalid */ }
            }
        });
        return [...new Set(links)]; // Unique links
    }

    extractJsonLd($) {
        let data = {};
        $('script[type="application/ld+json"]').each((i, el) => {
            try {
                const json = JSON.parse($(el).html());
                // Handle array or object
                const items = Array.isArray(json) ? json : [json];

                for (const item of items) {
                    if (item['@type'] === 'Article' || item['@type'] === 'NewsArticle' || item['@type'] === 'BlogPosting') {
                        data.headline = item.headline;
                        data.description = item.description;
                        data.image = item.image ? (typeof item.image === 'string' ? item.image : item.image.url) : null;
                        data.datePublished = item.datePublished || item.dateCreated;
                        data.author = item.author ? (typeof item.author === 'string' ? item.author : item.author.name) : null;
                    }
                }
            } catch (e) { /* ignore parse error */ }
        });
        return data;
    }

    async updateJob(jobId, status, result = null) {
        const jobKey = `job:${jobId}`;
        const data = { status, updatedAt: new Date().toISOString() };
        if (result) data.result = result;
        await redis.set(jobKey, JSON.stringify(data), 'EX', 3600);
        await redis.publish('job-updates', JSON.stringify({ jobId, ...data }));
    }
}

isBotCheck(title, text) {
    const t = (title || '').toLowerCase();
    const b = (text || '').toLowerCase();
    return t.includes('are you a robot') ||
        t.includes('attention required') ||
        t.includes('access denied') ||
        t.includes('security check') ||
        b.includes('pardon our interruption') ||
        b.includes('detected unusual activity');
}
}

module.exports = new ScraperService();
