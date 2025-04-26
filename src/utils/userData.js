// src/utils/userData.js
const redisClient = require('./redisClient'); // Import shared client

const USER_DATA_KEY_PREFIX = 'user_data:';
const PREMIUM_KEYS_SET_KEY = 'premium_keys';

const DEFAULT_STARTING_TIME = 20;

/**
 * Retrieves user data from Redis, creating default if it doesn't exist.
 * @param {string} userId
 * @returns {Promise<object>} The user data object { remainingMinutes, isPremium, personalizationNotes, llmProfileSummary }
 */
async function getUserDataInternal(userId) {
    const key = `${USER_DATA_KEY_PREFIX}${userId}`;
    try {
        const jsonData = await redisClient.get(key);
        if (jsonData) {
            const userData = JSON.parse(jsonData);
            // Ensure all fields exist, add defaults if missing (for backward compatibility)
            userData.remainingMinutes = userData.remainingMinutes ?? DEFAULT_STARTING_TIME;
            userData.isPremium = userData.isPremium ?? false;
            userData.personalizationNotes = userData.personalizationNotes ?? '';
            userData.llmProfileSummary = userData.llmProfileSummary ?? '';
            return userData;
        } else {
            // User doesn't exist, create default data
            console.log(`[UserData/Redis] Initializing user ${userId} with defaults.`);
            const defaultData = {
                remainingMinutes: DEFAULT_STARTING_TIME,
                isPremium: false,
                personalizationNotes: '',
                llmProfileSummary: ''
            };
            // Save the default data back to Redis
            await redisClient.set(key, JSON.stringify(defaultData));
            return defaultData;
        }
    } catch (error) {
        console.error(`[UserData/Redis] Error getting/setting data for user ${userId}:`, error);
        // Return default data on error to prevent crashes downstream
        return {
            remainingMinutes: DEFAULT_STARTING_TIME,
            isPremium: false,
            personalizationNotes: '',
            llmProfileSummary: ''
        };
    }
}

/**
 * Saves the user data object back to Redis.
 * @param {string} userId
 * @param {object} userData
 */
async function saveUserDataInternal(userId, userData) {
    const key = `${USER_DATA_KEY_PREFIX}${userId}`;
    try {
        await redisClient.set(key, JSON.stringify(userData));
    } catch (error) {
        console.error(`[UserData/Redis] Error saving data for user ${userId}:`, error);
    }
}

// --- Public API Functions ---

/**
 * Gets the complete data object for a user.
 * @param {string} userId The Discord user ID.
 * @returns {Promise<object>} The user data object { remainingMinutes, isPremium, personalizationNotes, llmProfileSummary }.
 */
async function getUserData(userId) {
    return await getUserDataInternal(userId);
}

/**
 * Gets the remaining session time for a user.
 * @param {string} userId The Discord user ID.
 * @returns {Promise<number>} The remaining time in minutes.
 */
async function getUserTime(userId) {
    const data = await getUserDataInternal(userId);
    return data.remainingMinutes;
}

/**
 * Updates a user's remaining session time by subtracting the time used.
 * @param {string} userId The Discord user ID.
 * @param {number} minutesUsed The amount of time used in minutes.
 */
async function updateUserTime(userId, minutesUsed) {
    const data = await getUserDataInternal(userId);
    const newTime = Math.max(0, data.remainingMinutes - minutesUsed);
    data.remainingMinutes = newTime;
    console.log(`[UserData] Updated user ${userId} time. Used: ${minutesUsed} min, Remaining: ${newTime} min.`);
    await saveUserDataInternal(userId, data);
}

/**
 * Directly sets a user's remaining session time.
 * @param {string} userId The Discord user ID.
 * @param {number} minutes The exact amount of time to set (in minutes).
 */
async function setUserTime(userId, minutes) {
    const data = await getUserDataInternal(userId);
    const timeToSet = Math.max(0, minutes);
    data.remainingMinutes = timeToSet;
    console.log(`[UserData] Set user ${userId} time directly to: ${timeToSet} min.`);
    await saveUserDataInternal(userId, data);
}

/**
 * Adds a specified amount of time to a user's remaining session time.
 * @param {string} userId The Discord user ID.
 * @param {number} minutesToAdd The amount of time to add in minutes.
 */
async function addUserTime(userId, minutesToAdd) {
    const data = await getUserDataInternal(userId);
    const timeToAdd = Math.max(0, minutesToAdd);
    data.remainingMinutes += timeToAdd;
    console.log(`[UserData] Added ${timeToAdd} min to user ${userId}. New Remaining: ${data.remainingMinutes} min.`);
    await saveUserDataInternal(userId, data);
}

// --- NEW: Premium Functions (Redis based) ---

/**
 * Gets the premium status for a user.
 * @param {string} userId The Discord user ID.
 * @returns {Promise<boolean>} True if the user is premium, false otherwise.
 */
async function getUserPremiumStatus(userId) {
    const data = await getUserDataInternal(userId);
    return data.isPremium;
}

/**
 * Sets the premium status for a user.
 * @param {string} userId The Discord user ID.
 * @param {boolean} status The premium status to set.
 */
async function setPremiumStatus(userId, status) {
    const data = await getUserDataInternal(userId);
    if (data.isPremium !== status) {
        data.isPremium = status;
        console.log(`[UserData] Set premium status for user ${userId} to: ${status}.`);
        await saveUserDataInternal(userId, data);
    }
}

/**
 * Checks if a given key is a valid, unused premium key (stored in Redis Set).
 * @param {string} key The key to validate.
 * @returns {Promise<boolean>} True if the key is valid, false otherwise.
 */
async function isValidPremiumKey(key) {
    try {
        return await redisClient.sIsMember(PREMIUM_KEYS_SET_KEY, key);
    } catch (error) {
        console.error(`[UserData/Redis] Error checking premium key ${key}:`, error);
        return false;
    }
}

/**
 * Removes a key from the Redis Set of valid premium keys.
 * @param {string} key The key to invalidate.
 * @returns {Promise<boolean>} True if the key was removed, false otherwise.
 */
async function invalidatePremiumKey(key) {
    try {
        const removed = await redisClient.sRem(PREMIUM_KEYS_SET_KEY, key);
        if (removed > 0) {
            console.log(`[UserData/Redis] Invalidated premium key: ${key}`);
            return true;
        }
        return false;
    } catch (error) {
        console.error(`[UserData/Redis] Error invalidating premium key ${key}:`, error);
        return false;
    }
}

/**
 * Adds a premium key to the Redis Set.
 * NOTE: This is for admin/management purposes, not typically user-facing.
 * @param {string} key The key to add.
 * @returns {Promise<boolean>} True if the key was added, false otherwise.
 */
async function addPremiumKey(key) {
    try {
        const added = await redisClient.sAdd(PREMIUM_KEYS_SET_KEY, key);
        if (added > 0) {
            console.log(`[UserData/Redis] Added premium key: ${key}`);
            return true;
        }
        return false; // Key likely already existed
    } catch (error) {
        console.error(`[UserData/Redis] Error adding premium key ${key}:`, error);
        return false;
    }
}

/**
 * Gets the personalization notes for a user.
 * @param {string} userId The Discord user ID.
 * @returns {Promise<string>} The personalization notes.
 */
async function getUserPersonalizationNotes(userId) {
    const data = await getUserDataInternal(userId);
    return data.personalizationNotes;
}

/**
 * Sets the personalization notes for a user.
 * @param {string} userId The Discord user ID.
 * @param {string} notes The notes to set.
 */
async function setUserPersonalizationNotes(userId, notes) {
    const data = await getUserDataInternal(userId);
    if (data.personalizationNotes !== notes) {
        data.personalizationNotes = notes || ''; // Ensure it's a string
        console.log(`[UserData] Set personalization notes for user ${userId}.`);
        await saveUserDataInternal(userId, data);
    }
}

/**
 * Gets the LLM-generated profile summary for a user.
 * @param {string} userId The Discord user ID.
 * @returns {Promise<string>} The profile summary.
 */
async function getLlmProfileSummary(userId) {
    const data = await getUserDataInternal(userId);
    return data.llmProfileSummary;
}

/**
 * Sets the LLM-generated profile summary for a user.
 * @param {string} userId The Discord user ID.
 * @param {string} summary The summary to set.
 */
async function setLlmProfileSummary(userId, summary) {
    const data = await getUserDataInternal(userId);
    if (data.llmProfileSummary !== summary) {
        data.llmProfileSummary = summary || ''; // Ensure it's a string
        console.log(`[UserData] Set LLM profile summary for user ${userId}.`);
        await saveUserDataInternal(userId, data);
    }
}

module.exports = {
    getUserData,
    getUserTime,
    updateUserTime,
    setUserTime,
    addUserTime,
    getUserPremiumStatus,
    setPremiumStatus,
    isValidPremiumKey,
    invalidatePremiumKey,
    addPremiumKey, // Export add key function if needed for admin
    getUserPersonalizationNotes,
    setUserPersonalizationNotes,
    getLlmProfileSummary,
    setLlmProfileSummary
}; 