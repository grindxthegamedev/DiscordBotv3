const fs = require('node:fs');
const path = require('node:path');
const { Client, Collection, GatewayIntentBits, Partials } = require('discord.js');
const dotenv = require('dotenv');
const pluginLoader = require('./src/plugins/pluginLoader'); // Import the plugin loader

dotenv.config();

// --- Load Plugins First ---
pluginLoader.loadPlugins(); 

// --- Client Setup ---
// Required Intents for current functionality:
// Guilds: Basic server information
// GuildMessages: Needed if commands are used in guilds (though primarily DM based)
// DirectMessages: Core functionality for DM sessions
// MessageContent: Needed to potentially read user replies in DMs later (for feedback/adjustments)
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds, 
        GatewayIntentBits.GuildMessages, 
        GatewayIntentBits.DirectMessages, 
        GatewayIntentBits.MessageContent
    ],
    partials: [Partials.Channel]
});

// --- Command Handling ---
client.commands = new Collection();
const commandsPath = path.join(__dirname, 'src', 'commands');
// Ensure commands directory exists
if (fs.existsSync(commandsPath)) {
    const commandFiles = fs.readdirSync(commandsPath).filter(file => file.endsWith('.js'));
    for (const file of commandFiles) {
        const filePath = path.join(commandsPath, file);
        const command = require(filePath);
        // Set a new item in the Collection with the key as the command name and the value as the exported module
        if ('data' in command && 'execute' in command) {
            client.commands.set(command.data.name, command);
            console.log(`[Commands] Loaded: ${command.data.name}`);
        } else {
            console.log(`[WARNING] The command at ${filePath} is missing a required "data" or "execute" property.`);
        }
    }
} else {
    console.warn('[WARNING] Commands directory not found at:', commandsPath);
}

// --- Event Handling ---
const eventsPath = path.join(__dirname, 'src', 'events');
if (fs.existsSync(eventsPath)) {
    const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));
    console.log(`[Events] Loading ${eventFiles.length} event files...`);
    for (const file of eventFiles) {
        const filePath = path.join(eventsPath, file);
        try {
            const event = require(filePath);
            if (event.once) {
                client.once(event.name, (...args) => event.execute(...args));
            } else {
                client.on(event.name, (...args) => event.execute(...args));
            }
            console.log(`[Events] Loaded: ${event.name}`);
        } catch (err) {
            console.error(`[Events] Error loading event file ${file}:`, err);
        }
    }
} else {
    console.warn('[WARNING] Events directory not found at:', eventsPath);
}

// --- Bot Login ---
const token = process.env.DISCORD_BOT_TOKEN;
if (!token) {
    console.error("Error: DISCORD_BOT_TOKEN not found in .env file.");
    process.exit(1); // Exit if token is missing
}

client.login(token).catch(err => {
    console.error("[Login Error] Failed to log in:", err);
    process.exit(1);
});

// Optional: Add a simple ready event here or keep it in src/events/ready.js
client.once('ready', readyClient => {
    console.log(`Ready! Logged in as ${readyClient.user.tag}`);
    console.log(`Bot serving ${readyClient.guilds.cache.size} guilds.`);
}); 