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
                headless: true, // Always headless in prod
                args: ['--no-sandbox', '--disable-setuid-sandbox'] // Critical for Docker
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

    // Main public method
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
            // 2. Try Fetch + Readability
            logger.info(`Attempting pure fetch for ${url}`);
            content = await this.fetchAndParse(url);
        } catch (err) {
            logger.warn(`Fetch failed for ${url}: ${err.message}. Switching to Playwright.`);
            strategy = 'playwright';
        }

        // 3. If empty or failed, use Playwright
        if (!content || content.length < 200) {
            logger.info(`Content too short or failed. Using Playwright for ${url}`);
            try {
                content = await this.playwrightParse(url);
                strategy = 'playwright-readability';
            } catch (err) {
                logger.error(`Playwright failed for ${url}: ${err.message}`);

                // If it's a navigation error, don't retry proxy, it's likely a bad URL
                if (err.message.includes('ERR_NAME_NOT_RESOLVED') || err.message.includes('Invalid URL')) {
                    throw new AppError('Invalid URL or Host Unreachable', 400);
                }
                // 4. Retry with Proxy
                if (process.env.PROXY_SERVER_URL) {
                    logger.info(`Retrying ${url} with proxy...`);
                    content = await this.playwrightParse(url, { proxy: process.env.PROXY_SERVER_URL });
                    strategy = 'playwright-proxy-readability';
                } else {
                    throw err;
                }
            }
        }

        if (!content) {
            throw new AppError('Unable to extract meaningful content', 422);
        }

        const result = {
            url,
            content,
            strategy,
            extractedAt: new Date().toISOString()
        };

        // 5. Cache result (expire in 24 hours)
        await redis.set(cacheKey, JSON.stringify(result), 'EX', 86400);

        if (jobId) await this.updateJob(jobId, 'completed', result);

        return result;
    }

    async fetchAndParse(url) {
        const { data } = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36'
            },
            timeout: 5000
        });
        return this.parseHtml(data, url);
    }

    async playwrightParse(url, options = {}) {
        const browser = await this.initBrowser();
        const context = await browser.newContext(options.proxy ? { proxy: { server: options.proxy } } : {});
        const page = await context.newPage();

        try {
            await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
            // Wait for some text to appear
            await page.waitForSelector('body');

            const html = await page.content();
            await context.close();
            return this.parseHtml(html, url);
        } catch (e) {
            await context.close();
            throw e;
        }
    }

    parseHtml(html, url) { // Renamed from cleanHtml to match purpose
        const doc = new JSDOM(html, { url });
        const reader = new Readability(doc.window.document);
        const article = reader.parse();

        // Fallback or Return Content
        if (article && article.textContent && article.textContent.length > 50) {
            return article.textContent.trim();
        }

        // Cheerio Fallback if Readability fails
        const $ = cheerio.load(html);
        $('script, style, nav, footer, iframe, .ad, .ads, .social-share, .cookie-consent').remove();
        return $('body').text().replace(/\s+/g, ' ').trim();
    }

    async updateJob(jobId, status, result = null) {
        const jobKey = `job:${jobId}`;
        const data = { status, updatedAt: new Date().toISOString() };
        if (result) data.result = result;
        await redis.set(jobKey, JSON.stringify(data), 'EX', 3600); // 1 hour retention
        // Emit event via socket (will need to require io instance or send via redis pub/sub if separate process)
        // For simplicity, we assume single instance or redis pub/sub listener elsewhere
        await redis.publish('job-updates', JSON.stringify({ jobId, ...data }));
    }
}

module.exports = new ScraperService();
