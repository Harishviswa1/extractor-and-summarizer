const Parser = require('rss-parser');
const redis = require('../config/redis');
const openaiService = require('./openai.service');
const scraperService = require('./scraper.service');
const logger = require('../config/logger');
const axios = require('axios');

class RSSService {
    constructor() {
        this.parser = new Parser();
        // Check feeds every 10 minutes (in production simpler to use a CronJob library or external scheduler)
        // For this demo, we'll expose a method triggerable via API or interval
    }

    async addFeed(url, webhookUrl) {
        const id = Buffer.from(url).toString('base64');
        await redis.sadd('rss_feeds', JSON.stringify({ id, url, webhookUrl }));
        return id;
    }

    async processFeeds() {
        const feeds = await redis.smembers('rss_feeds');
        logger.info(`Processing ${feeds.length} RSS feeds`);

        for (const feedStr of feeds) {
            try {
                const feed = JSON.parse(feedStr);
                const parsed = await this.parser.parseURL(feed.url);

                // Check latest item date against last checked
                // Ideally store 'lastBuildDate' or most recent guid in Redis per feed
                const lastItemGuidKey = `rss_last:${feed.id}`;
                const lastGuid = await redis.get(lastItemGuidKey);

                if (parsed.items.length > 0) {
                    const latest = parsed.items[0];
                    if (latest.guid !== lastGuid) {
                        logger.info(`New article found in ${feed.url}: ${latest.title}`);

                        // Process new article
                        // 1. Extract content
                        const content = await scraperService.extract(latest.link);

                        // 2. Summarize
                        const summary = await openaiService.summarize(content.content, 'en', 'bullet');

                        // 3. Webhook
                        if (feed.webhookUrl) {
                            await axios.post(feed.webhookUrl, {
                                title: latest.title,
                                link: latest.link,
                                summary,
                                content: content.content
                            }).catch(err => logger.error(`Webhook failed for ${feed.url}`));
                        }

                        // Update state
                        await redis.set(lastItemGuidKey, latest.guid);
                    }
                }

            } catch (err) {
                logger.error(`Error processing feed ${feedStr}:`, err);
            }
        }
    }
}

module.exports = new RSSService();
