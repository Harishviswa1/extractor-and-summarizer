const express = require('express');
const extractController = require('../controllers/extract.controller');
const summarizeController = require('../controllers/summarize.controller');
const authCheck = require('../middleware/auth');
const rateLimiter = require('../middleware/rateLimiter');

const router = express.Router();

// Public health check
router.get('/health', (req, res) => res.status(200).send('OK'));

// Verify Authentication & Rate Limits for all API routes
router.use(authCheck);
router.use(rateLimiter);

const jobController = require('../controllers/job.controller');

router.get('/extract', extractController.extractUrl);
router.get('/summarize', summarizeController.summarizeUrl);
router.get('/results/:jobId', jobController.getJobResult);

router.post('/summarize-text', summarizeController.summarizeText);
router.post('/compare', summarizeController.compare);
router.post('/headline', summarizeController.headlines);
router.post('/rss-monitor', summarizeController.monitorRss);

module.exports = router;
