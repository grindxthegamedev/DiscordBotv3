const { Events } = require('discord.js');
const SessionManager = require('../sessions/SessionManager');
// Removed LLMClient and pluginLoader imports as they are no longer used here

// Removed USER_MESSAGE_COOLDOWN_MS

module.exports = {
    name: Events.MessageCreate,
    async execute(message) {
        // Ignore messages from bots or not in DMs
        if (message.author.bot || message.guild) return;

        // Check if the user has an active session
        const session = SessionManager.getSession(message.author.id);
        if (!session || !session.isActive) {
            // Do nothing if no active session
            return; 
        }

        // --- Handle Minimal Input (Stop Command) --- 
        const userText = message.content.trim().toLowerCase();

        if (userText === 'stop') {
            console.log(`[DM Received] User ${message.author.id} requested session stop.`);
            try {
                // Optional: Send a confirmation message
                // await message.reply('Ending session as requested.'); 
                session.endSession('User Stop Command');
                SessionManager.deleteSession(message.author.id);
            } catch (error) {
                console.error(`[Session Stop Error] Failed to process stop command for session ${session.sessionId}:`, error);
            }
        } else {
             // Ignore any other message content in this model
             // console.log(`[DM Received] Ignoring message from user ${message.author.id} in active session: ${message.content}`);
        }
    },
}; 