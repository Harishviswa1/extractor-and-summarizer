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

    async extract(url) {
        try {
            const res = await axios.get(url, {
                headers: {
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
                },
                timeout: 15000
            });

            const dom = new JSDOM(res.data, { url });
            const reader = new Readability(dom.window.document);
            const article = reader.parse();

            if (!article || !article.textContent) {
                throw new Error("No readable content found");
            }

            return {
                url,
                title: article.title,
                content: article.textContent,
                markdown: article.textContent, // User requested textContent as markdown
                author: null,
                published: null,
                original_length: article.textContent.length
            };
        } catch (err) {
            logger.error("Scraper error:", err.message);
            throw new Error("Failed to extract article content");
        }
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
        // 1. Basic Setup
        const $ = cheerio.load(html);
        const turndownService = new TurndownService();

        // 2. Extract Metadata (BEFORE cleaning)
        const metadata = {
            title: $('meta[property="og:title"]').attr('content') || $('title').text() || '',
            description: $('meta[property="og:description"]').attr('content') || $('meta[name="description"]').attr('content') || '',
            author: $('meta[name="author"]').attr('content') || $('meta[property="article:author"]').attr('content') || '',
            image: $('meta[property="og:image"]').attr('content') || $('meta[name="twitter:image"]').attr('content') || '',
            published: $('meta[property="article:published_time"]').attr('content') || $('time').attr('datetime') || '',
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

        // 5. Construct Result
        if (article) {
            const markdown = turndownService.turndown(article.content);
            const wordCount = article.textContent.split(/\s+/).length;

            return {
                ...metadata,
                title: article.title || metadata.title, // Readability title often better
                content: article.content, // Clean HTML
                textContent: article.textContent.trim(), // Clean Text
                markdown: markdown,
                ttr: Math.ceil(wordCount / 200), // Time to Read (mins)
                links: this.extractLinks(cleanHtml, url)
            };
        }

        // Fallback (Layer 3)
        logger.warn(`Readability failed for ${url}. Using Raw Fallback.`);
        const rawText = $('body').text().replace(/\s+/g, ' ').trim();

        if (rawText.length > 50) {
            return {
                ...metadata,
                content: $('body').html(),
                textContent: rawText,
                markdown: turndownService.turndown($('body').html()),
                ttr: Math.ceil(rawText.split(/\s+/).length / 200),
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

    async updateJob(jobId, status, result = null) {
        const jobKey = `job:${jobId}`;
        const data = { status, updatedAt: new Date().toISOString() };
        if (result) data.result = result;
        await redis.set(jobKey, JSON.stringify(data), 'EX', 3600);
        await redis.publish('job-updates', JSON.stringify({ jobId, ...data }));
    }
}

module.exports = new ScraperService();
