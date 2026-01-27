
require('dotenv').config();
const scraperService = require('./src/services/scraper.service');
const logger = require('./src/config/logger');

// Force debug logging
logger.transports.forEach((t) => (t.level = 'debug'));

async function checkIpAndHeaders() {
    console.log("\n================================================");
    console.log("ADVANCED PROXY & STEALTH DIAGNOSTICS");
    console.log("================================================");

    if (!process.env.PROXY_SERVER_URL) {
        console.error("ERROR: PROXY_SERVER_URL is NOT configured!");
        process.exit(1);
    }

    try {
        console.log("Initializing Layer 3 (Proxy + Stealth Browser)...");
        const browser = await scraperService.ensureBrowser();

        // 1. Check IP
        console.log("\n[TEST 1] Verifying IP Address...");
        const ipData = await scraperService.browserParse("https://httpbin.org/ip", {
            proxy: process.env.PROXY_SERVER_URL
        });
        const ipJson = JSON.parse(ipData.textContent);
        console.log(" > Proxy IP Detected:", ipJson.origin);

        // 2. Check User-Agent (Verify Rotation & Stealth)
        console.log("\n[TEST 2] Verifying User-Agent & Headers...");
        const headerData = await scraperService.browserParse("https://httpbin.org/headers", {
            proxy: process.env.PROXY_SERVER_URL
        });
        const headerJson = JSON.parse(headerData.textContent);
        console.log(" > User-Agent Used:", headerJson.headers['User-Agent']);

        if (!headerJson.headers['User-Agent'].includes('Headless')) {
            console.log(" > SUCCESS: 'Headless' signature NOT found in User-Agent.");
        } else {
            console.log(" > WARN: 'Headless' signature FOUND. Stealth might be failing.");
        }

        console.log("\n------------------------------------------------");
        console.log("DIAGNOSTIC COMPLETE");
        console.log("If the IP above is NOT your server IP, the Proxy is working.");
        console.log("If you run this script again, the IP *should* change (if Rotating).");
        console.log("------------------------------------------------");

    } catch (err) {
        console.error("FATAL ERROR:", err);
    } finally {
        await scraperService.closeBrowser();
        process.exit();
    }
}

checkIpAndHeaders();
