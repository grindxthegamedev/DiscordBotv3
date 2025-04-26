const fs = require('node:fs');
const path = require('node:path');

// Construct path correctly for cross-platform compatibility
const dataDir = path.resolve(__dirname, '..', '..', 'data'); 
const preferencesFilePath = path.join(dataDir, 'user_preferences.json');

// Ensure data directory exists
if (!fs.existsSync(dataDir)) {
    try {
        fs.mkdirSync(dataDir);
        console.log('[Memory] Created data directory.');
    } catch (err) {
        console.error('[Memory] Error creating data directory:', err);
        // Proceed without persistence if directory fails
    }
}

/**
 * Loads all user preferences from the JSON file.
 * @returns {object} An object where keys are user IDs and values are preference objects.
 */
function loadAllPreferencesSync() {
    try {
        if (fs.existsSync(preferencesFilePath)) {
            const data = fs.readFileSync(preferencesFilePath, 'utf8');
            return JSON.parse(data);
        } else {
            return {}; // Return empty object if file doesn't exist
        }
    } catch (error) {
        console.error('[Memory] Error loading preferences file:', error);
        return {}; // Return empty object on error
    }
}

// Load preferences once on startup
let allPreferences = loadAllPreferencesSync();
console.log(`[Memory] Loaded preferences for ${Object.keys(allPreferences).length} users.`);

/**
 * Saves all user preferences to the JSON file.
 */
async function saveAllPreferences() {
    try {
        const data = JSON.stringify(allPreferences, null, 2); // Pretty print JSON
        await fs.promises.writeFile(preferencesFilePath, data, 'utf8');
        // console.log('[Memory] Preferences saved.'); // Can be noisy
    } catch (error) {
        console.error('[Memory] Error saving preferences file:', error);
    }
}

/**
 * Gets the preferences for a specific user.
 * @param {string} userId - The Discord user ID.
 * @returns {object | undefined} The user's preference object or undefined.
 */
function getUserPreferences(userId) {
    return allPreferences[userId];
}

/**
 * Saves/updates preferences for a specific user and persists to file.
 * @param {string} userId - The Discord user ID.
 * @param {object} preferences - The preference data to save (e.g., { lastCharacter, lastPrefs }).
 */
async function saveUserPreferences(userId, preferences) {
    allPreferences[userId] = { ...(allPreferences[userId] || {}), ...preferences };
    await saveAllPreferences(); // Save changes immediately
}

// Optional: Save periodically or on shutdown instead of every time
// setInterval(saveAllPreferences, 5 * 60 * 1000); // Save every 5 minutes
// process.on('exit', saveAllPreferencesSync); // Sync save on exit (less safe)

module.exports = {
    getUserPreferences,
    saveUserPreferences
}; 