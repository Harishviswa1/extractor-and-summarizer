const redis = require('../config/redis');
const AppError = require('../utils/appError');

exports.getJobResult = async (req, res, next) => {
    try {
        const { jobId } = req.params;
        if (!jobId) {
            return next(new AppError('Job ID is required', 400));
        }

        const jobKey = `job:${jobId}`;
        const jobData = await redis.get(jobKey);

        if (!jobData) {
            return next(new AppError('Job not found or expired', 404));
        }

        const job = JSON.parse(jobData);

        res.status(200).json({
            status: 'success',
            data: job
        });
    } catch (err) {
        next(err);
    }
};
