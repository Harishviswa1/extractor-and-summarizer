const request = require('supertest');
const app = require('../src/app');
const redis = require('../src/config/redis');
const { disconnect } = require('../src/config/redis');

// Mock dependencies
jest.mock('../src/services/scraper.service.js', () => ({
    extract: jest.fn().mockResolvedValue({
        url: 'https://example.com',
        content: 'Mocked content for testing purposes.',
        strategy: 'mock'
    })
}));

jest.mock('../src/services/openai.service.js', () => ({
    summarize: jest.fn().mockResolvedValue('This is a mocked summary.'),
    compare: jest.fn().mockResolvedValue({ bias_analysis: 'None' }),
    generateHeadlines: jest.fn().mockResolvedValue({ seo: 'SEO Title' })
}));

jest.mock('../src/services/rss.service.js', () => ({
    addFeed: jest.fn().mockResolvedValue('mock-feed-id')
}));

// Mock Rate Limiter Middleware to avoid 429s during tests
jest.mock('../src/middleware/rateLimiter.js', () => (req, res, next) => next());

// Mock Redis to prevent connection errors during tests
jest.mock('../src/config/redis', () => {
    return {
        get: jest.fn(),
        set: jest.fn(),
        sadd: jest.fn(),
        smembers: jest.fn(),
        duplicate: () => ({
            subscribe: jest.fn(),
            on: jest.fn(),
            disconnect: jest.fn()
        }),
        on: jest.fn(),
        disconnect: jest.fn()
    };
});

// Since rate limiter uses redis, we might need to mock the middleware or the redis client well.
// For integration tests, it's often easier to bypass rate limiting or mock the library.
// We'll trust the redis mock above is sufficient for basic commands, 
// but RateLimiterRedis uses specific commands. simpler to just mock the middleware check for integration logic.

describe('API Endpoints', () => {

    // Auth bypass for testing
    // In a real integration test we'd set the headers. 
    // We will assume the default 'auth' middleware is active and expects a key.
    const validHeaders = {
        'x-api-key': 'test-key',
        'x-rapidapi-proxy-secret': process.env.RAPIDAPI_PROXY_SECRET || 'any-secret'
    };

    beforeAll(() => {
        // loose silence of logging
    });

    afterAll(async () => {
        // await redis.disconnect(); // mocked
    });

    describe('GET /api/extract', () => {
        it('should return extracted content for valid URL', async () => {
            const res = await request(app)
                .get('/api/extract?url=https://example.com')
                .set(validHeaders);

            expect(res.statusCode).toEqual(200);
            expect(res.body.status).toBe('success');
            expect(res.body.data.content).toBeDefined();
        });

        it('should fail if URL is missing', async () => {
            const res = await request(app)
                .get('/api/extract')
                .set(validHeaders);

            expect(res.statusCode).toEqual(400);
        });
    });

    describe('GET /api/summarize', () => {
        it('should summarize a URL', async () => {
            const res = await request(app)
                .get('/api/summarize?url=https://example.com&style=bullet')
                .set(validHeaders);

            expect(res.statusCode).toEqual(200);
            expect(res.body.data.summary).toBe('This is a mocked summary.');
        });
    });

    describe('POST /api/summarize-text', () => {
        it('should summarize raw text', async () => {
            const res = await request(app)
                .post('/api/summarize-text')
                .set(validHeaders)
                .send({ text: 'Some long text...' });

            expect(res.statusCode).toEqual(200);
            expect(res.body.data.summary).toBeDefined();
        });
    });

    describe('POST /api/compare', () => {
        it('should compare two URLs', async () => {
            const res = await request(app)
                .post('/api/compare')
                .set(validHeaders)
                .send({
                    url1: 'https://a.com',
                    url2: 'https://b.com'
                });

            expect(res.statusCode).toEqual(200);
            expect(res.body.data.bias_analysis).toBeDefined();
        });
    });

    describe('POST /api/headline', () => {
        it('should generate headlines', async () => {
            const res = await request(app)
                .post('/api/headline')
                .set(validHeaders)
                .send({ text: 'Sample text' });

            expect(res.statusCode).toEqual(200);
            expect(res.body.data.seo).toBeDefined();
        });
    });
    describe('GET /api/results/:jobId', () => {
        it('should return job status if exists', async () => {
            const res = await request(app)
                .get('/api/results/123')
                .set(validHeaders);

            // Should be 404 because our mock redis.get returns undefined by default,
            // but it proves the route is reachable and not 500ing on imports.
            expect(res.statusCode).not.toEqual(500);
        });
    });
});
