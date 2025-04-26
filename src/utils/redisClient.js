const redis = require('redis');

const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
const redisClient = redis.createClient({ url: redisUrl });

redisClient.on('error', err => console.error('[RedisClient] Redis Client Error', err));

// Connect client (async function wrapper)
(async () => {
    try {
        await redisClient.connect();
        console.log('[RedisClient] Connected to Redis.');
    } catch (err) {
        console.error('[RedisClient] Failed to connect to Redis:', err);
        // Exit if Redis connection fails, as it's critical now
        process.exit(1);
    }
})();

module.exports = redisClient; 