
const { URL } = require('url');

const proxyString = "http://username:password@6.pr.thordata.net:9999";

try {
    const proxyUrl = new URL(proxyString);
    const contextOptions = {};
    contextOptions.proxy = {
        server: `${proxyUrl.protocol}//${proxyUrl.host}`,
        username: proxyUrl.username,
        password: proxyUrl.password
    };

    console.log("Original:", proxyString);
    console.log("Parsed Server:", contextOptions.proxy.server);
    console.log("Parsed Username:", contextOptions.proxy.username);
    console.log("Parsed Password:", contextOptions.proxy.password);

    if (contextOptions.proxy.server === "http://6.pr.thordata.net:9999" &&
        contextOptions.proxy.username === "username" &&
        contextOptions.proxy.password === "password") {
        console.log("SUCCESS: Proxy parsed correctly.");
    } else {
        console.log("FAILURE: Parsing mismatch.");
    }

} catch (e) {
    console.error("Error parsing:", e.message);
}
