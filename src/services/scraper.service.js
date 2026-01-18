const axios = require('axios');
const cheerio = require('cheerio');
const puppeteer = require('puppeteer-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const TurndownService = require('turndown');
const redis = require('../config/redis');
const logger = require('../config/logger');
const AppError = require('../utils/appError');
const { v4: uuidv4 } = require('uuid');

puppeteer.use(StealthPlugin());

class ScraperService {
    constructor() {
        this.browser = null;
    }

    async initBrowser() {
        if (!this.browser) {
            logger.info('Launching Puppeteer Stealth Browser...');
            this.browser = await puppeteer.launch({
                headless: "new",
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu'
                ]
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
            strategy = 'puppeteer-readability';
        }

        if (!content || !content.textContent || content.textContent.length < 200 || this.isBotCheck(content.title, content.textContent)) {
            logger.info(`Content insufficient or Bot Block detected. Switching to Layer 2 (Puppeteer Stealth) for ${url}`);

            try {
                content = await this.browserParse(url);
                strategy = 'puppeteer-readability';
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
                content = await this.browserParse(cacheUrl);
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
                content = await this.browserParse(url, {
                    proxy: process.env.PROXY_SERVER_URL
                });
                strategy = 'puppeteer-proxy';
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
                'Referer': 'https://www.google.com/'
            },
            timeout: 10000,
            validateStatus: (status) => status < 400
        });
        return this.parseHtml(response.data, url);
    }

    async browserParse(url, opts = {}) {
        let browser = null;
        try {
            const launchOptions = {
                headless: "new",
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--window-size=1920,1080'
                ]
            };

            if (opts.proxy) {
                launchOptions.args.push(`--proxy-server=${opts.proxy}`);
            }

            browser = await puppeteer.launch(launchOptions);
            const page = await browser.newPage();

            // Viewport & headers handled largely by Stealth, but setting viewport is good practice
            await page.setViewport({ width: 1920, height: 1080 });

            // Resource Blocking
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                const resourceType = req.resourceType();
                if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

            // CSR Support: Wait for content
            try {
                await page.waitForSelector('body', { timeout: 10000 });
                // Try waiting for common article tags if body loads fast but content is slow
                await page.waitForSelector('article, main, h1', { timeout: 5000 }).catch(() => { });
            } catch (e) { /* ignore */ }

            const html = await page.content();
            await browser.close();
            return this.parseHtml(html, url);

        } catch (err) {
            if (browser) await browser.close();
            throw err;
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
