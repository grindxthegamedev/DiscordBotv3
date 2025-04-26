require('dotenv').config();
const fs = require('fs').promises;
const path = require('path');
const redis = require('redis');

// --- Constants from userData.js (ensure these match!) ---
const USER_DATA_KEY_PREFIX = 'user_data:';
const PREMIUM_KEYS_SET_KEY = 'premium_keys';
const DEFAULT_STARTING_TIME = 20;
// --- End Constants ---

// --- File Paths ---
const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'userData.json');
const KEYS_FILE = path.join(DATA_DIR, 'premiumKeys.json');
// --- End File Paths ---

async function migrate() {
    // Connect to Redis
    const redisUrl = process.env.REDIS_URL || 'redis://localhost:6379';
    const redisClient = redis.createClient({ url: redisUrl });
    redisClient.on('error', err => console.error('[Migration/Redis] Redis Client Error', err));
    try {
        await redisClient.connect();
        console.log('[Migration/Redis] Connected to Redis.');
    } catch (err) {
        console.error('[Migration/Redis] Failed to connect to Redis:', err);
        process.exit(1);
    }

    let migratedUserCount = 0;
    let migratedKeyCount = 0;

    // 1. Migrate User Data from userData.json
    console.log(`Attempting to read user data from ${DATA_FILE}...`);
    try {
        await fs.access(DATA_FILE);
        const fileData = await fs.readFile(DATA_FILE, 'utf8');
        const parsedData = JSON.parse(fileData);

        for (const [userId, value] of Object.entries(parsedData)) {
            const redisKey = `${USER_DATA_KEY_PREFIX}${userId}`;

            // Check if data already exists in Redis for this user
            const exists = await redisClient.exists(redisKey);
            if (exists) {
                console.log(`- Skipping user ${userId}: Data already exists in Redis.`);
                continue;
            }

            // Prepare data with defaults (copied from new userData.js logic)
            let userData = {};
            if (typeof value === 'number') { // Oldest format (just time)
                userData = {
                    remainingMinutes: value,
                    isPremium: false,
                    personalizationNotes: '',
                    llmProfileSummary: ''
                };
            } else { // Newer format (object)
                userData = {
                    remainingMinutes: value.remainingMinutes ?? DEFAULT_STARTING_TIME,
                    isPremium: value.isPremium ?? false,
                    personalizationNotes: value.personalizationNotes ?? '',
                    llmProfileSummary: value.llmProfileSummary ?? ''
                };
            }

            // Write to Redis
            try {
                await redisClient.set(redisKey, JSON.stringify(userData));
                console.log(`+ Migrated user ${userId} to Redis.`);
                migratedUserCount++;
            } catch (err) {
                console.error(`! Failed to migrate user ${userId}:`, err);
            }
        }
        console.log(`User data migration complete. Migrated ${migratedUserCount} users.`);

    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`User data file (${DATA_FILE}) not found. Skipping user data migration.`);
        } else {
            console.error(`Error processing user data file (${DATA_FILE}):`, error);
        }
    }

    // 2. Migrate Premium Keys from premiumKeys.json
    console.log(`\nAttempting to read premium keys from ${KEYS_FILE}...`);
    try {
        await fs.access(KEYS_FILE);
        const keysData = await fs.readFile(KEYS_FILE, 'utf8');
        const keysArray = JSON.parse(keysData);

        if (Array.isArray(keysArray) && keysArray.length > 0) {
            const keysToAdd = [];
            // Check existence for each key before adding (SADD is variadic)
            for (const key of keysArray) {
                if (typeof key === 'string' && key.length > 0) {
                    const isMember = await redisClient.sIsMember(PREMIUM_KEYS_SET_KEY, key);
                    if (!isMember) {
                        keysToAdd.push(key);
                    } else {
                         console.log(`- Skipping premium key ${key}: Already exists in Redis Set.`);
                    }
                } else {
                    console.warn(`- Skipping invalid premium key entry: ${key}`);
                }
            }

            if (keysToAdd.length > 0) {
                try {
                    const addedCount = await redisClient.sAdd(PREMIUM_KEYS_SET_KEY, keysToAdd);
                    console.log(`+ Migrated ${addedCount} premium keys to Redis Set.`);
                    migratedKeyCount = addedCount;
                } catch (err) {
                    console.error(`! Failed to migrate premium keys:`, err);
                }
            } else {
                console.log(`No new premium keys found to migrate.`);
            }
        } else {
            console.log(`Premium keys file (${KEYS_FILE}) is empty or not a valid array. Skipping key migration.`);
        }
        console.log(`Premium key migration complete. Added ${migratedKeyCount} new keys.`);

    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log(`Premium keys file (${KEYS_FILE}) not found. Skipping key migration.`);
        } else {
            console.error(`Error processing premium keys file (${KEYS_FILE}):`, error);
        }
    }

    // Disconnect Redis
    await redisClient.quit();
    console.log('\nMigration finished.');
}

migrate().catch(err => {
    console.error("Migration script failed:", err);
    process.exit(1);
}); 