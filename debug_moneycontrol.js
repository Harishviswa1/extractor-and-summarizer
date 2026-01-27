
require('dotenv').config();
const scraperService = require('./src/services/scraper.service');
const logger = require('./src/config/logger');

// Set verbose logging
logger.transports.forEach((t) => (t.level = 'debug'));

const url = "https://www.moneycontrol.com/news/business/markets/stock-market-live-updates-gift-nifty-suggests-a-firm-opening-us-asian-markets-gain-liveblog-13790950.html";

async function run() {
    console.log(`Testing Moneycontrol Access...`);

    try {
        const result = await scraperService.extract(url);
        console.log("----------------------------------------");
        console.log("SUCCESS!");
        console.log("Strategy:", result.strategy);
        console.log("Title:", result.title);
        console.log("Snippet:", result.textContent?.substring(0, 100));
        console.log("----------------------------------------");
    } catch (error) {
        console.error("----------------------------------------");
        console.error("FAILURE!");
        console.error(error.message);
        if (error.response) {
            console.error("Status:", error.response.status);
        }
        console.error("----------------------------------------");
    } finally {
        await scraperService.closeBrowser();
        process.exit();
    }
}

run();
