const axios = require('axios');
const cheerio = require('cheerio');
const { chromium } = require('playwright');
const { JSDOM } = require('jsdom');
const { Readability } = require('@mozilla/readability');
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
        // 1. Check Cache
        const cacheKey = `extract:${url}`;
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
            // LAYER 1: Fast Fetch + Readability
            logger.info(`Attempting Layer 1 (Fetch) for ${url}`);
            content = await this.fetchAndParse(url);
        } catch (err) {
            logger.warn(`Layer 1 failed for ${url}: ${err.message}. Switching to Layer 2.`);
            strategy = 'playwright-readability';
        }

        // LAYER 2: Playwright + Readability (If Layer 1 empty/short)
        // We use a loose threshold (200 chars) to detect "JavaScript Required" or empty pages
        if (!content || content.length < 200) {
            logger.info(`Content insufficient (${content ? content.length : 0} chars). Switching to Layer 2 (Playwright) for ${url}`);
            try {
                content = await this.playwrightParse(url);
                strategy = 'playwright-readability';
            } catch (err) {
                logger.error(`Layer 2 failed for ${url}: ${err.message}`);

                if (err.message.includes('ERR_NAME_NOT_RESOLVED') || err.message.includes('Invalid URL')) {
                    throw new AppError('Invalid URL or Host Unreachable', 400);
                }

                // LAYER 2.5: Proxy Retry
                if (process.env.PROXY_SERVER_URL) {
                    logger.info(`Retrying ${url} with proxy...`);
                    content = await this.playwrightParse(url, { proxy: process.env.PROXY_SERVER_URL });
                    strategy = 'playwright-proxy';
                } else {
                    // Start Layer 3 (Raw Fallback) logic happens inside parseHtml's failure path usually,
                    // but if Playwright crashes entirely, we might re-throw.
                    // However, we want to fail gracefully.
                    throw err;
                }
            }
        }

        // Final Check
        if (!content || content.length === 0) {
            throw new AppError('Unable to extract meaningful content', 422);
        }

        const result = {
            url,
            content,
            strategy,
            extractedAt: new Date().toISOString()
        };

        // Cache result (24h)
        await redis.set(cacheKey, JSON.stringify(result), 'EX', 86400);
        if (jobId) await this.updateJob(jobId, 'completed', result);

        return result;
    }

    async fetchAndParse(url) {
        const { data } = await axios.get(url, {
            headers: {
                // Real-user alias to avoid simple blocking
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 8000
        });
        return this.parseHtml(data, url);
    }

    async playwrightParse(url, options = {}) {
        const browser = await this.initBrowser();
        const context = await browser.newContext(options.proxy ? { proxy: { server: options.proxy } } : {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
        });
        const page = await context.newPage();

        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            // Wait for body to be non-empty
            await page.waitForSelector('body', { timeout: 5000 }).catch(() => { });

            // Optional: aggressive wait for lazy loaded text
            await page.waitForTimeout(2000);

            const html = await page.content();
            await context.close();
            return this.parseHtml(html, url);
        } catch (e) {
            await context.close();
            throw e;
        }
    }

    parseHtml(html, url) {
        // Pre-clean noisy elements before Readability runs
        // This helps Readability focus on the actual article
        const $ = cheerio.load(html);
        $('script, style, noscript, iframe, svg, nav, footer, .ad, .ads, .social-share, .cookie-consent, [role="alert"]').remove();

        // Update HTML for JSDOM
        const cleanHtml = $.html();

        const doc = new JSDOM(cleanHtml, { url });
        const reader = new Readability(doc.window.document);
        const article = reader.parse();

        // Strategy A: Mozilla Readability (High Quality)
        if (article && article.textContent && article.textContent.trim().length > 100) {
            logger.info(`Readability success for ${url}`);
            return article.textContent.trim();
        }

        // Strategy B: Raw Text Fallback (Layer 3)
        // If Readability fails to find a structured article, dump the body text.
        logger.warn(`Readability returned null/empty for ${url}. Using Raw Body fallback.`);

        let rawText = $('body').text().replace(/\s+/g, ' ').trim();

        // If raw extraction is also tiny, return null to trigger Playwright (if not already tried) or error
        return rawText.length > 50 ? rawText : null;
    }

    async updateJob(jobId, status, result = null) {
        const jobKey = `job:${jobId}`;
        const data = { status, updatedAt: new Date().toISOString() };
        if (result) data.result = result;
        await redis.set(jobKey, JSON.stringify(data), 'EX', 3600);
        await redis.publish('job-updates', JSON.stringify({ jobId, ...data }));
    }
}

module.exports = new ScraperService();
