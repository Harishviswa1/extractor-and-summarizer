
require('dotenv').config();
const scraperService = require('./src/services/scraper.service');
const logger = require('./src/config/logger');

// Force verbose logging
logger.transports.forEach((t) => (t.level = 'debug'));

const url = "https://httpbin.org/ip"; // Returns the IP used

async function run() {
    console.log("------------------------------------------------");
    console.log("FORCING PROXY TRAFFIC GENERATION");
    console.log("------------------------------------------------");

    if (!process.env.PROXY_SERVER_URL) {
        console.error("ERROR: PROXY_SERVER_URL is not set in .env!");
        process.exit(1);
    }

    console.log("Proxy Configured:", process.env.PROXY_SERVER_URL.replace(/:[^:]*@/, ':****@'));

    try {
        const browser = await scraperService.ensureBrowser();

        // Manual copy of Layer 3 Logic to bypass "checks"
        console.log(`Hitting ${url} via Proxy...`);
        const result = await scraperService.browserParse(url, {
            proxy: process.env.PROXY_SERVER_URL
        });

        console.log("------------------------------------------------");
        console.log("SUCCESS!");
        console.log("The IP shown below should be your PROXY IP (Residential), not your Server IP.");
        console.log("Content:", result.textContent);
        console.log("------------------------------------------------");

    } catch (error) {
        console.error("FAILURE:", error.message);
    } finally {
        await scraperService.closeBrowser();
        process.exit();
    }
}

run();
