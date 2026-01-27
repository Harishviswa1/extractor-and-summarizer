
require('dotenv').config();
const scraperService = require('./src/services/scraper.service');
const logger = require('./src/config/logger');

// Set verbose logging
logger.transports.forEach((t) => (t.level = 'debug'));

const url = "https://www.bloomberg.com/news/articles/2026-01-26/asian-stocks-to-drift-higher-yen-gains-on-dollar-markets-wrap";

async function run() {
    console.log(`Starting Debug Scrape for: ${url}`);

    // Check Env
    console.log("Proxy Configured:", !!process.env.PROXY_SERVER_URL);
    if (process.env.PROXY_SERVER_URL) {
        console.log("Proxy URL:", process.env.PROXY_SERVER_URL.replace(/:[^:]*@/, ':****@')); // Mask password
    }

    try {
        const result = await scraperService.extract(url);
        console.log("----------------------------------------");
        console.log("SUCCESS!");
        console.log("Strategy Used:", result.strategy);
        console.log("Title:", result.title);
        console.log("Content Length:", result.textContent?.length);
        console.log("----------------------------------------");
    } catch (error) {
        console.error("----------------------------------------");
        console.error("FAILURE!");
        console.error(error);
        if (error.response) {
            console.error("Status:", error.response.status);
            console.error("Data:", error.response.data);
        }
        console.error("----------------------------------------");
    } finally {
        await scraperService.closeBrowser();
        process.exit();
    }
}

run();
