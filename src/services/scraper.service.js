const axios = require('axios');
const cheerio = require('cheerio');
// Use playwright-extra + stealth for better evasion
const { chromium } = require('playwright-extra');
const StealthPlugin = require('puppeteer-extra-plugin-stealth');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
const TurndownService = require('turndown');
const redis = require('../config/redis');
const logger = require('../config/logger');
const AppError = require('../utils/appError');
const { v4: uuidv4 } = require('uuid');

// Enable Stealth Plugin
chromium.use(StealthPlugin());

class ScraperService {
    constructor() {
        this.browser = null;
        this.activeRequests = 0;
    }

    async initBrowser() {
        if (!this.browser || !this.browser.isConnected()) {
            logger.info('Launching Shared Playwright Stealth Browser...');

            const launchOptions = {
                headless: true,
                args: [
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-gpu',
                    // '--disable-blink-features=AutomationControlled' // StealthPlugin handles this better
                ]
            };

            try {
                this.browser = await chromium.launch(launchOptions);
            } catch (e) {
                logger.error(`Failed to launch Playwright browser: ${e.message}`);
                throw e;
            }

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

    // Updated Extract Flow
    async extract(url, jobId = null, userPlan = 'PRO') {
        const cacheKey = `extract:v3:${url}`;
        const cached = await redis.get(cacheKey);
        if (cached) {
            logger.info(`Cache hit for ${url}`);
            if (jobId) await this.updateJob(jobId, 'completed', JSON.parse(cached));
            return JSON.parse(cached);
        }

        if (jobId) await this.updateJob(jobId, 'fetching');

        let content = null;
        let lastError = null;
        let strategy = 'fetch-readability';

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
            throw new AppError('Basic Plan Limit: Simple extraction failed. Advanced scraping (Puppeteer/Playwright) is only available on the Pro Plan. Please upgrade.', 403);
        }

        // Layer 2: Playwright Shared (No Proxy) - For JS sites / Basic Blocks
        // SKIP if Layer 1 was clearly a 403/429 Block (Go straight to Proxy)
        const isBlock = lastError && (lastError.response?.status === 403 || lastError.response?.status === 429);

        if (!content && !isBlock) {
            try {
                logger.info(`Layer 2 (Playwright Stealth Shared): ${url}`);
                content = await this.browserParse(url);
                strategy = 'playwright-readability';
            } catch (err) {
                lastError = err;
                logger.warn(`Layer 2 failed: ${err.message}`);
            }
        }

        // Layer 3: Playwright Proxy (Isolated Context) - ONLY on Block or Hard Failure
        if (!content && process.env.PROXY_SERVER_URL) {
            const status = lastError?.response?.status || 500;
            const msg = lastError?.message || '';
            // Robust Check: If explicitly blocked OR if we simply failed to get content (Layer 2 failed silently)
            const needsProxy = status === 403 || status === 429 || msg.includes('Bot Block') || msg.includes('Timeout') || isBlock || !content;

            if (needsProxy) {
                try {
                    logger.info(`Layer 3 (Playwright Stealth Proxy): ${url}`);
                    content = await this.browserParse(url, { proxy: process.env.PROXY_SERVER_URL });
                    strategy = 'playwright-proxy';
                } catch (err) {
                    logger.error(`Layer 3 failed: ${err.message}`);
                }
            }
        }

        // Layer 4: Google Cache (Last Resort)
        if (!content) {
            logger.info(`Layer 3 failed/blocked. Attempting Layer 4 (Google Cache) for ${url}`);
            try {
                const cacheUrl = `http://webcache.googleusercontent.com/search?q=cache:${encodeURIComponent(url)}`;
                // CRITICAL: Google aggressively blocks DC IPs from cache, so we MUST use the proxy if available.
                const opts = process.env.PROXY_SERVER_URL ? { proxy: process.env.PROXY_SERVER_URL } : {};

                content = await this.browserParse(cacheUrl, opts);

                // Clean up Google Header artifacts
                if (content && content.textContent) {
                    content.title = content.title.replace(' - Google Search', '').replace('cache:', '');
                    strategy = 'google-cache';
                }
            } catch (err) {
                logger.warn(`Layer 4 (Google Cache) failed: ${err.message}`);
            }
        }

        if (!content || !content.textContent || content.textContent.length < 50) {
            throw new AppError('Detailed extraction failed after all retries.', 422);
        }

        const result = {
            url,
            strategy,
            ...content,
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
        if (this.activeRequests >= 5) {
            throw new AppError('Server busy: Too many parallel scraping jobs. Please try again later.', 429);
        }

        this.activeRequests++;
        let context = null;
        let page = null;

        try {
            const browser = await this.ensureBrowser();

            // Randomize User-Agent to match Rotating Proxy (avoid "Botnet" signature)
            const userAgents = [
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
                'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
                'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36'
            ];
            const ua = userAgents[Math.floor(Math.random() * userAgents.length)];

            // Prepare Context Options
            const contextOptions = {
                viewport: { width: 1920, height: 1080 },
                userAgent: ua,
                javaScriptEnabled: true,
                ignoreHTTPSErrors: true,
            };

            // Configure Proxy if provided
            if (opts.proxy) {
                try {
                    const proxyUrl = new URL(opts.proxy);
                    contextOptions.proxy = {
                        server: `${proxyUrl.protocol}//${proxyUrl.host}`,
                        username: proxyUrl.username,
                        password: proxyUrl.password
                    };
                } catch (e) {
                    logger.warn(`Invalid proxy URL: ${opts.proxy} - proceeding without proxy`);
                }
            }

            // Create Context (Isolated from other requests)
            context = await browser.newContext(contextOptions);
            page = await context.newPage();

            // Resource Blocking (Optimize Speed vs Stealth)
            // If using Proxy (Layer 3), we want to look 100% human, so we load EVERYTHING (slower but safer).
            // If NOT using Proxy (Layer 2), we block bloat for speed.
            if (!opts.proxy) {
                await page.route('**/*', (route) => {
                    const type = route.request().resourceType();
                    if (['image', 'media', 'font', 'stylesheet'].includes(type)) {
                        route.abort();
                    } else {
                        route.continue();
                    }
                });
            }

            const timeout = opts.proxy ? 60000 : 30000;
            // For Proxy, wait for network idle (heavier check) to ensure full render
            const waitStrategy = opts.proxy ? 'networkidle' : 'domcontentloaded';

            // Navigate
            await page.goto(url, {
                waitUntil: waitStrategy,
                timeout: timeout
            });

            // 3. Attempt to dismiss Cookie Banners (common issue with "short content")
            if (opts.proxy) {
                try {
                    const buttons = await page.getByRole('button').all();
                    for (const button of buttons) {
                        const text = (await button.innerText()).toLowerCase();
                        if (text.includes('accept') || text.includes('agree') || text.includes('allow') || text.includes('consent')) {
                            // Click providing it's visible
                            if (await button.isVisible()) {
                                await button.click({ timeout: 2000 }).catch(() => { });
                                break; // Click one is usually enough
                            }
                        }
                    }
                    await page.waitForTimeout(1000); // Wait for banner to clear
                } catch (e) {
                    // Ignore cookie click errors
                }
            }

            // Wait for Body to ensure render
            try {
                await page.waitForSelector('body', { timeout: 10000 });
                // Bot Check
                const title = await page.title();
                const bodyText = await page.evaluate(() => document.body.innerText);
                if (this.isBotCheck(title, bodyText)) {
                    throw new Error('Bot Block Detected inside Playwright');
                }
            } catch (e) {
                if (e.message.includes('Bot Block')) throw e;
                // Ignore timeout waiting for selector, might allow partial content
            }

            // 4. Site-Specific Handlers (for known tough sites)
            let pageContent = '';

            if (url.includes('espncricinfo.com')) {
                try {
                    logger.info('Running ESPN Custom Handler...');
                    // Wait for hydration
                    await page.waitForTimeout(2000);

                    // Try multiple possible content containers
                    const selectors = [
                        'div.ds-text-typo-mid1', // Standard Article
                        'div.match-report-container',
                        'article',
                        'main'
                    ];

                    let found = false;
                    for (const sel of selectors) {
                        const locator = page.locator(sel);
                        if (await locator.count() > 0) {
                            logger.info(`ESPN Handler: Found content in ${sel}`);
                            pageContent = await locator.first().innerHTML();
                            found = true;
                            break; // Stop at first valid match
                        }
                    }

                    if (!found) {
                        logger.warn('ESPN Handler: No specific selector found, dumping full body.');
                        pageContent = await page.content();
                    }
                } catch (e) {
                    logger.error(`ESPN Handler Error: ${e.message}`);
                    pageContent = await page.content();
                }
            } else {
                pageContent = await page.content();
            }

            await context.close(); // Clean up context and page
            return this.parseHtml(pageContent, url);

        } catch (err) {
            if (context) await context.close().catch(() => { });
            throw err;
        } finally {
            this.activeRequests--;
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
        const cleanedRaw = cleanText(rawBody);

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
            t.includes('unusual traffic') ||
            b.includes('pardon our interruption') ||
            b.includes('detected unusual activity') ||
            b.includes('our systems have detected unusual traffic') ||
            b.includes('this page checks to see if it\'s really you');
    }
}

module.exports = new ScraperService();
