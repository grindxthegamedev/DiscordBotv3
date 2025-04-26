const fs = require('node:fs');
const path = require('node:path');

const pluginsDirectory = path.join(__dirname); // Relative to this file
const loadedPlugins = new Map(); // Key: Lowercase character name, Value: Plugin data
const aliasMap = new Map(); // Key: Lowercase alias, Value: Lowercase character name

function loadPlugins() {
    console.log('[PluginLoader] Loading character plugins...');
    loadedPlugins.clear();
    aliasMap.clear();

    try {
        if (!fs.existsSync(pluginsDirectory)) {
            console.warn(`[PluginLoader] Plugins directory does not exist: ${pluginsDirectory}`);
            fs.mkdirSync(pluginsDirectory, { recursive: true }); // Create if missing
            console.log(`[PluginLoader] Created directory: ${pluginsDirectory}`);
            return; // Nothing to load yet
        }

        const files = fs.readdirSync(pluginsDirectory);
        for (const file of files) {
            if (path.extname(file).toLowerCase() === '.json') {
                const filePath = path.join(pluginsDirectory, file);
                try {
                    const fileContent = fs.readFileSync(filePath, 'utf-8');
                    const pluginData = JSON.parse(fileContent);

                    // --- Updated Validation --- 
                    // 1. Check mandatory base fields
                    if (!pluginData.characterName || !pluginData.rolePrompt) {
                        console.warn(`[PluginLoader] Skipping invalid plugin file ${file}: Missing characterName or rolePrompt.`);
                        continue;
                    }
                    
                    // 2. Check characterType
                    const characterType = pluginData.characterType;
                    if (characterType !== 'fictional' && characterType !== 'real') {
                        console.warn(`[PluginLoader] Skipping invalid plugin file ${file}: Missing or invalid characterType (must be 'fictional' or 'real').`);
                        continue;
                    }

                    // 3. Check source list based on type
                    let sourceListValid = false;
                    if (characterType === 'fictional') {
                        sourceListValid = pluginData.tags && Array.isArray(pluginData.tags) && pluginData.tags.length > 0 && pluginData.tags.every(tag => typeof tag === 'string');
                        if (!sourceListValid) {
                             console.warn(`[PluginLoader] Skipping invalid plugin file ${file} (type: fictional): Must have a non-empty 'tags' array containing only strings.`);
                             continue;
                        }
                    } else { // characterType === 'real'
                        sourceListValid = pluginData.subreddits && Array.isArray(pluginData.subreddits) && pluginData.subreddits.length > 0 && pluginData.subreddits.every(sub => typeof sub === 'string');
                         if (!sourceListValid) {
                             console.warn(`[PluginLoader] Skipping invalid plugin file ${file} (type: real): Must have a non-empty 'subreddits' array containing only strings.`);
                             continue;
                        }
                    }
                    
                     // 4. Check avatarTags (optional, but must be string array if present)
                    if (pluginData.avatarTags && (!Array.isArray(pluginData.avatarTags) || !pluginData.avatarTags.every(tag => typeof tag === 'string'))) {
                        console.warn(`[PluginLoader] Skipping invalid plugin file ${file}: 'avatarTags' must be an array of strings if provided.`);
                        continue;
                    }
                    // --- End Updated Validation ---

                    const characterKey = pluginData.characterName.toLowerCase();
                    if (loadedPlugins.has(characterKey)) {
                        console.warn(`[PluginLoader] Duplicate character plugin found for: ${pluginData.characterName}. Overwriting previous.`);
                    }

                    // Ensure avatarTags exists (even if empty) for consistency
                    if (!pluginData.avatarTags) {
                        pluginData.avatarTags = [];
                    }

                    loadedPlugins.set(characterKey, pluginData);
                    console.log(`[PluginLoader] Loaded plugin for: ${pluginData.characterName} (Type: ${characterType})`);

                    // Add aliases
                    if (pluginData.aliases && Array.isArray(pluginData.aliases)) {
                        pluginData.aliases.forEach(alias => {
                            const aliasKey = alias.toLowerCase();
                            if (aliasMap.has(aliasKey) || loadedPlugins.has(aliasKey)) {
                                 console.warn(`[PluginLoader] Alias conflict: ${alias} for ${pluginData.characterName} already exists.`);
                            } else {
                                aliasMap.set(aliasKey, characterKey);
                            }
                        });
                    }

                } catch (parseError) {
                    console.error(`[PluginLoader] Error parsing plugin file ${file}:`, parseError);
                }
            }
        }
        console.log(`[PluginLoader] Loaded ${loadedPlugins.size} plugins.`);
    } catch (error) {
        console.error('[PluginLoader] Critical error loading plugins directory:', error);
    }
}

/**
 * Gets the plugin data for a given character name or alias.
 * @param {string} nameOrAlias - The character name or alias (case-insensitive).
 * @returns {object | undefined} The plugin data or undefined if not found.
 */
function getPlugin(nameOrAlias) {
    const key = nameOrAlias.toLowerCase();
    if (loadedPlugins.has(key)) {
        return loadedPlugins.get(key);
    }
    const characterKey = aliasMap.get(key);
    if (characterKey) {
        return loadedPlugins.get(characterKey);
    }
    return undefined;
}

/**
 * Checks if a character plugin exists.
 * @param {string} nameOrAlias 
 * @returns {boolean}
 */
function characterExists(nameOrAlias) {
    return !!getPlugin(nameOrAlias);
}

/**
 * Gets a list of all loaded character names.
 * @returns {string[]}
 */
function getAvailableCharacters() {
    // Return the original character names from the loaded plugin data
    return Array.from(loadedPlugins.values()).map(plugin => plugin.characterName);
}

module.exports = {
    loadPlugins,
    getPlugin,
    characterExists,
    getAvailableCharacters,
    // Optionally expose loadedPlugins directly if needed elsewhere
}; 