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
        this.activeRequests = 0;
    }

    async initBrowser() {
        if (!this.browser || !this.browser.isConnected()) {
            logger.info('Launching Shared Puppeteer Stealth Browser...');

            // Railway/Nixpacks typically installs chromium at /usr/bin/chromium
            const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/chromium';

            const launchOptions = {
                headless: "new",
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu',
                    '--window-size=1920,1080' // Standardize viewport
                ]
            };

            // Attempt to use system chrome if available (fixes timeout issues)
            try {
                this.browser = await puppeteer.launch({
                    ...launchOptions,
                    executablePath: executablePath
                });
            } catch (e) {
                logger.warn(`Failed to launch with ${executablePath}, trying default bundled...`);
                // Fallback to bundled if local development or path invalid
                this.browser = await puppeteer.launch(launchOptions);
            }

            // Handle browser disconnects
            this.browser.on('disconnected', () => {
                logger.warn('Browser disconnected! Clearing instance.');
                this.browser = null;
            });
        }
        return this.browser;
    }

    async ensureBrowser() {
        if (!this.browser || !this.browser.isConnected()) {
            return this.initBrowser();
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
        // Concurrency Limit Check
        if (this.activeRequests >= 5) { // Limit to 5 parallel pages
            throw new AppError('Server busy: Too many parallel scraping jobs. Please try again later.', 429);
        }

        this.activeRequests++;
        let browser = null;
        let page = null;
        let isTempBrowser = false;

        try {
            // 1. Browser Selection (Shared vs Isolated Proxy)
            if (opts.proxy) {
                logger.info(`Launching Isolated Browser for Proxy Request: ${url}`);
                const proxyUrl = new URL(opts.proxy);
                browser = await puppeteer.launch({
                    headless: "new",
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        `--proxy-server=${proxyUrl.protocol}//${proxyUrl.host}`,
                        '--disable-gpu'
                    ]
                });
                isTempBrowser = true;
            } else {
                browser = await this.ensureBrowser();
            }

            page = await browser.newPage();

            // Authenticate Proxy if needed
            if (opts.proxy) {
                const proxyUrl = new URL(opts.proxy);
                if (proxyUrl.username && proxyUrl.password) {
                    await page.authenticate({
                        username: proxyUrl.username,
                        password: proxyUrl.password
                    });
                }
            }

            // Viewport & headers
            await page.setViewport({ width: 1920, height: 1080 });

            // Resource Blocking (Optimize Speed)
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                const resourceType = req.resourceType();
                if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
                    req.abort();
                } else {
                    req.continue();
                }
            });

            const timeout = opts.proxy ? 60000 : 30000; // Longer timeout for proxy
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout });

            // CSR Support: Wait for content
            try {
                await page.waitForSelector('body', { timeout: 10000 });
                // Check for fast failure (captchas/blockers)
                const bodyText = await page.evaluate(() => document.body.innerText);
                if (this.isBotCheck(await page.title(), bodyText)) {
                    throw new Error('Bot Block Detected inside Puppeteer');
                }
            } catch (e) {
                if (e.message.includes('Bot Block')) throw e;
                /* ignore selector timeout */
            }

            const html = await page.content();

            // Cleanup: Close page usually, but if temp browser we close whole browser below
            if (!isTempBrowser) await page.close();

            return this.parseHtml(html, url);

        } catch (err) {
            if (page && !page.isClosed()) await page.close().catch(() => { });
            throw err;
        } finally {
            this.activeRequests--;
            if (isTempBrowser && browser) {
                await browser.close().catch(() => { });
            }
        }
    }

    // Updated Extract Flow
    async extract(url, jobId = null, userPlan = 'PRO') {
        const cacheKey = `extract:v2:${url}`;
        const cached = await redis.get(cacheKey);
        if (cached) return JSON.parse(cached);

        let content = null;
        let lastError = null;

        // Layer 1: Axios + Readability (Fastest, Cheapest)
        try {
            logger.info(`Layer 1 (Axios): ${url}`);
            content = await this.fetchAndParse(url);
        } catch (err) {
            lastError = err;
            logger.warn(`Layer 1 failed: ${err.message}`);
        }

        // Tier Check: If BASIC, stop here if failed
        if (!content && userPlan === 'BASIC') {
            throw new AppError('Basic Plan Limit: Simple extraction failed. Advanced scraping (Puppeteer/Proxy) is only available on the Pro Plan. Please upgrade.', 403);
        }

        // Layer 2: Puppeteer Shared (No Proxy) - For JS sites / Basic Blocks
        // SKIP if Layer 1 was clearly a 403/429 Block (Go straight to Proxy)
        const isBlock = lastError && (lastError.response?.status === 403 || lastError.response?.status === 429);

        if (!content && !isBlock) {
            try {
                logger.info(`Layer 2 (Puppeteer Shared): ${url}`);
                content = await this.browserParse(url);
            } catch (err) {
                lastError = err;
                logger.warn(`Layer 2 failed: ${err.message}`);
            }
        }

        // Layer 3: Puppeteer Proxy (Isolated) - ONLY on Block or Hard Failure
        if (!content && process.env.PROXY_SERVER_URL) {
            const status = lastError?.response?.status || 500;
            const msg = lastError?.message || '';
            const needsProxy = status === 403 || status === 429 || msg.includes('Bot Block') || msg.includes('Timeout');

            if (needsProxy) {
                try {
                    logger.info(`Layer 3 (Proxy Isolated): ${url}`);
                    content = await this.browserParse(url, { proxy: process.env.PROXY_SERVER_URL });
                } catch (err) {
                    logger.error(`Layer 3 failed: ${err.message}`);
                }
            }
        }

        // Layer 4: Google Cache (Last Resort)
        if (!content) {
            // ... existing google cache logic if desired, or skip
        }

        if (!content || !content.textContent || content.textContent.length < 50) {
            throw new AppError('Detailed extraction failed after all retries.', 422);
        }

        const result = { url, ...content };
        await redis.set(cacheKey, JSON.stringify(result), 'EX', 86400);
        return result;
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
