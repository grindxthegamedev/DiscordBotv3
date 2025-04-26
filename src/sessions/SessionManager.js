const { Session } = require('./Session');
const redisClient = require('../utils/redisClient'); // Import shared client
const { ShardClientUtil } = require('discord.js'); // Needed for shard utility

// --- Local Session Storage (per shard) ---
// Key: userId, Value: Session object
// This map ONLY stores sessions managed by THIS specific shard.
const localActiveSessions = new Map();
const USER_TO_SHARD_KEY_PREFIX = 'user_shard:'; // Prefix for Redis keys mapping user ID to shard ID

/**
 * Manages active user sessions across shards using Redis for coordination.
 */
class SessionManager {
    /**
     * Creates a new session for a user ON THE CURRENT SHARD.
     * Registers the user-shard mapping in Redis.
     * Assumes this is called on the shard that SHOULD manage the user.
     * @param {import('discord.js').Client} client - The Discord client instance (needed for shard ID)
     * @param {string} userId - The Discord user ID.
     * @param {object} characterPlugin - The loaded character plugin object.
     * @param {number | null | undefined} [durationMinutes] - Optional session duration in minutes.
     * @param {string} [personalization=''] - Optional personalization notes (premium).
     * @param {boolean} [useProfileSummary=false] - Whether to use the saved profile summary (premium).
     * @returns {Promise<Session | null>} The newly created Session object, or null if a session already exists anywhere.
     */
    static async createSession(client, userId, characterPlugin, durationMinutes, personalization = '', useProfileSummary = false) {
        if (!client || !client.shard) {
            console.error('[SessionManager] createSession called without a valid sharded client!');
            return null;
        }
        const currentShardId = client.shard.ids[0]; // Get ID of the current shard

        // Check Redis first to see if ANY shard has this user
        const existingShardId = await redisClient.get(`${USER_TO_SHARD_KEY_PREFIX}${userId}`);
        if (existingShardId !== null) {
            console.warn(`[SessionManager] User ${userId} already has an active session on shard ${existingShardId}. Cannot create new session on shard ${currentShardId}.`);
            return null; // User already has a session somewhere
        }

        // Create session locally
        const newSession = new Session(userId, characterPlugin, durationMinutes, personalization, useProfileSummary);
        localActiveSessions.set(userId, newSession);
        console.log(`[SessionManager] Shard ${currentShardId}: Local session ${newSession.sessionId} created for user ${userId}. Use profile summary: ${useProfileSummary}`);

        // Register in Redis
        try {
            await redisClient.set(`${USER_TO_SHARD_KEY_PREFIX}${userId}`, currentShardId.toString());
            console.log(`[SessionManager/Redis] Registered user ${userId} to shard ${currentShardId}.`);
        } catch (err) {
            console.error(`[SessionManager/Redis] Failed to register user ${userId} to shard ${currentShardId}:`, err);
            // Rollback: remove local session if Redis registration failed?
            localActiveSessions.delete(userId);
            // Optionally, clean up the Session object itself if needed
            newSession.endSession('Redis Registration Failed'); // Clean up timers etc.
            return null;
        }

        return newSession;
    }

    /**
     * Retrieves the ACTIVE LOCAL session for a given user on THIS shard.
     * Does NOT look across shards.
     * @param {string} userId - The Discord user ID.
     * @returns {Session | undefined} The Session object if found locally, otherwise undefined.
     */
    static getLocalSession(userId) {
        return localActiveSessions.get(userId);
    }

    /**
     * Checks if a user has an active session on THIS shard.
     * @param {string} userId - The Discord user ID.
     * @returns {boolean} True if the user has an active session locally, false otherwise.
     */
    static hasLocalSession(userId) {
        return localActiveSessions.has(userId);
    }

    /**
     * Checks Redis to see if ANY shard manages a session for the user.
     * @param {string} userId - The Discord user ID.
     * @returns {Promise<boolean>} True if any shard manages a session for the user.
     */
    static async hasActiveSessionAnywhere(userId) {
        try {
            const result = await redisClient.exists(`${USER_TO_SHARD_KEY_PREFIX}${userId}`);
            return result === 1;
        } catch (err) {
            console.error(`[SessionManager/Redis] Error checking existence for user ${userId}:`, err);
            return false; // Assume no session on error
        }
    }

    /**
     * Ends the active session for a given user, coordinating across shards.
     * It finds the shard managing the session via Redis and tells that shard to end it.
     * @param {import('discord.js').Client} client - The Discord client instance (needed for IPC).
     * @param {string} userId - The Discord user ID.
     * @returns {Promise<boolean>} True if a session was found and termination was initiated, false otherwise.
     */
    static async endSession(client, userId) {
        if (!client || !client.shard) {
            console.error('[SessionManager] endSession called without a valid sharded client!');
            return false;
        }

        const managingShardIdStr = await redisClient.get(`${USER_TO_SHARD_KEY_PREFIX}${userId}`);
        if (managingShardIdStr === null) {
            console.log(`[SessionManager] No active session found in Redis for user ${userId} to end.`);
            return false; // No session found
        }

        const managingShardId = parseInt(managingShardIdStr, 10);
        const currentShardId = client.shard.ids[0];

        if (managingShardId === currentShardId) {
            // Session is on the current shard, end it locally
            console.log(`[SessionManager] Shard ${currentShardId}: Ending local session for user ${userId}.`);
            const session = this.getLocalSession(userId);
            if (session) {
                session.endSession('Requested by Manager');
                // `endSession` inside Session class should call `SessionManager.deleteSession`
                return true;
            } else {
                // Discrepancy: Redis says we have it, but map doesn't. Clean up Redis.
                console.warn(`[SessionManager] Discrepancy: Redis indicated session for ${userId} on shard ${currentShardId}, but not found locally. Cleaning Redis.`);
                await this.deleteSession(userId); // Clean up Redis entry
                return false;
            }
        } else {
            // Session is on a different shard, send message via broadcastEval
            console.log(`[SessionManager] Shard ${currentShardId}: Requesting shard ${managingShardId} to end session for user ${userId}.`);
            try {
                // Send a request to the specific shard to end the session
                const results = await client.shard.broadcastEval(
                    (c, { targetUserId, reason }) => {
                        // This code runs on EACH shard
                        if (c.shard.ids[0] === managingShardId) { // Check if this is the target shard
                            const SessionManager = require('./SessionManager'); // Required locally on the target shard
                            const localSession = SessionManager.getLocalSession(targetUserId);
                            if (localSession) {
                                localSession.endSession(reason);
                                return true; // Indicate success on the target shard
                            }
                            return false; // Session not found on target shard
                        }
                        return null; // Not the target shard
                    },
                    {
                        context: { targetUserId: userId, reason: 'Remote End Request' },
                        shard: managingShardId // Target the specific shard
                    }
                );
                // Check if the target shard reported success (results will be an array) 
                const success = results.some(res => res === true);
                if (success) {
                    console.log(`[SessionManager] Shard ${managingShardId} confirmed session end for ${userId}.`);
                    // The target shard's local endSession should trigger deleteSession from Redis
                    return true;
                }
                else {
                     console.warn(`[SessionManager] Shard ${managingShardId} did not find or end session for ${userId}. Cleaning Redis.`);
                     await this.deleteSession(userId); // Clean up Redis if target failed
                     return false;
                }
            } catch (err) {
                console.error(`[SessionManager] Error during broadcastEval to end session for user ${userId} on shard ${managingShardId}:`, err);
                // Attempt to clean up Redis even on broadcast error
                await this.deleteSession(userId);
                return false;
            }
        }
    }

    /**
     * Deletes a user's session entry from Redis and the local map (if applicable).
     * This should be called by the Session object itself when it truly ends (e.g., in its endSession method).
     * @param {string} userId
     * @param {number} [shardId] - Optional: The shard ID expected to own the session.
     */
    static async deleteSession(userId, shardId) {
         // Always remove from local map if present
         if (localActiveSessions.has(userId)) {
            localActiveSessions.delete(userId);
            console.log(`[SessionManager] Shard ${shardId ?? 'unknown'}: Local session reference removed for user ${userId}.`);
         }

        // Remove from Redis
        try {
            const deletedCount = await redisClient.del(`${USER_TO_SHARD_KEY_PREFIX}${userId}`);
            if (deletedCount > 0) {
                console.log(`[SessionManager/Redis] Deleted user ${userId} session mapping.`);
            } else {
                 // This might happen if endSession was called twice or if there was a discrepancy
                console.log(`[SessionManager/Redis] No session mapping found in Redis for user ${userId} to delete.`);
            }
        } catch (err) {
            console.error(`[SessionManager/Redis] Error deleting user ${userId} session mapping:`, err);
        }
    }

    /**
     * Ends all active sessions managed BY THIS SHARD.
     * Also attempts to clean up associated Redis entries.
     */
    static async endAllLocalSessions() {
        console.log(`[SessionManager] Ending all ${localActiveSessions.size} sessions local to this shard...`);
        const promises = [];
        localActiveSessions.forEach((session, userId) => {
            session.endSession('Shard Shutdown'); // This should internally call deleteSession for Redis
        });
        localActiveSessions.clear(); // Clear local map
        console.log(`[SessionManager] All local sessions ended on this shard.`);
        // Note: Redis cleanup is handled by individual session.endSession calls triggering deleteSession
    }

    /**
     * Ends all active sessions across ALL shards (called from master or specific shard).
     * Use with caution - typically called on bot shutdown.
     * @param {import('discord.js').Client} client - The Discord client instance (needed for IPC).
     */
    static async endAllSessionsGlobally(client) {
        if (!client || !client.shard) {
            console.error('[SessionManager] endAllSessionsGlobally called without a valid sharded client!');
            return;
        }
        console.log('[SessionManager] Broadcasting request to end all sessions globally...');
        try {
            await client.shard.broadcastEval(() => {
                // This code runs on EACH shard
                const SessionManager = require('./SessionManager');
                SessionManager.endAllLocalSessions(); // Call the local cleanup function
                return true;
            });
            console.log('[SessionManager] Broadcast complete. All shards instructed to end local sessions.');
            // Optionally, clear all session keys from Redis as a final measure,
            // but individual shards *should* have handled it.
            // await clearAllRedisSessionKeys();
        } catch (err) {
            console.error('[SessionManager] Error broadcasting global session end request:', err);
        }
    }
}

// Graceful shutdown handler for THIS SHARD
// Use process.once to avoid multiple bindings if file is reloaded
process.once('SIGINT', async () => {
    console.log(`[SessionManager] Received SIGINT on shard. Ending local sessions...`);
    await SessionManager.endAllLocalSessions();
    // Redis client quit might be handled globally or not needed per-shard depending on setup
    process.exit(0);
});
process.once('SIGTERM', async () => {
    console.log(`[SessionManager] Received SIGTERM on shard. Ending local sessions...`);
    await SessionManager.endAllLocalSessions();
    // Redis client quit might be handled globally or not needed per-shard depending on setup
    process.exit(0);
});

module.exports = SessionManager; 