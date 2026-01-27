
require('dotenv').config();
const scraperService = require('./src/services/scraper.service');
const logger = require('./src/config/logger');

// Set verbose logging
logger.transports.forEach((t) => (t.level = 'debug'));

const url = "https://www.espncricinfo.com/series/new-zealand-in-india-2025-26-1490228/india-vs-new-zealand-3rd-t20i-1490236/match-report";

async function run() {
    console.log(`Testing ESPN Access...`);

    try {
        const result = await scraperService.extract(url);
        console.log("----------------------------------------");
        console.log("SUCCESS!");
        console.log("Strategy:", result.strategy);
        console.log("Title:", result.title);
        console.log("Content Length:", result.textContent?.length);
        console.log("Snippet:", result.textContent?.substring(0, 200));
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
