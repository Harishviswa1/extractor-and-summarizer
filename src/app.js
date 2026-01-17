require('dotenv').config();
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const helmet = require('helmet');
const cors = require('cors');
const compression = require('compression');
const logger = require('./config/logger');
const redis = require('./config/redis');
const apiRoutes = require('./routes/api.routes');
const AppError = require('./utils/appError');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", // Configure for production
        methods: ["GET", "POST"]
    }
});

// Security & Middleware
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(express.json({ limit: '10mb' })); // Allow large text payloads

// Routes
app.use('/api/v1', apiRoutes);

// Global Error Handler
app.use((err, req, res, next) => {
    logger.error(err);
    const statusCode = err.statusCode || 500;
    const status = err.status || 'error';

    res.status(statusCode).json({
        status: status,
        message: err.message || 'Internal Server Error'
    });
});

// Socket.io & Redis Job Updates
io.on('connection', (socket) => {
    logger.info(`Socket connected: ${socket.id}`);

    socket.on('join-job', (jobId) => {
        socket.join(`job:${jobId}`);
    });
});

// Redis Subscriber for Job Updates
const subscriber = redis.duplicate();
subscriber.subscribe('job-updates', (err) => {
    if (err) logger.error('Failed to subscribe to job-updates');
});

subscriber.on('message', (channel, message) => {
    if (channel === 'job-updates') {
        const data = JSON.parse(message);
        io.to(`job:${data.jobId}`).emit('job-update', data);
    }
});

// Start Server only if run directly
const PORT = process.env.PORT || 3000;
if (require.main === module) {
    server.listen(PORT, () => {
        logger.info(`Server running on port ${PORT}`);
    });
}

// Handle graceful shutdown
process.on('SIGTERM', () => {
    logger.info('SIGTERM received. Shutting down gracefully');
    server.close(() => {
        logger.info('Process terminated');
        redis.disconnect();
        subscriber.disconnect();
        process.exit(0);
    });
});

module.exports = app;
