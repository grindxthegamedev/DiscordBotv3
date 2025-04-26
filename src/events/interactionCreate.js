const { Events, DiscordAPIError, ButtonBuilder, ActionRowBuilder } = require('discord.js');
const SessionManager = require('../sessions/SessionManager'); // Import SessionManager
const { triggeredButton } = require('../sessions/Session.js'); // Import the button definition
const LlmClient = require('../llm/client'); // Import the LLM Client
const pluginLoader = require('../plugins/pluginLoader'); // Import plugin loader
const memory = require('../utils/memory'); // Import memory utility
const UserData = require('../utils/userData'); // Correct casing

// Helper function to initialize DM and start session tasks
async function initializeDmAndStartSession(interaction, session) {
    try {
        const dmChannel = await interaction.user.createDM();
        session.setDmChannelId(dmChannel.id);

        // Start the session setup (fetches avatar, sends opener, starts loop)
        await session.startTimers(interaction.client); 
        // No need to call LlmClient.sendInitialPrompt here anymore

        console.log(`Session ${session.sessionId} started successfully for user ${interaction.user.id}`);
        
        // Send confirmation *after* setup attempt (ephemeral)
         await interaction.editReply({
            content: `Okay ${interaction.user.username}, I've slid into your DMs as ${session.character}. Check your messages! 😉`, 
            ephemeral: true // Ensure this is ephemeral
        });

    } catch (error) {
        console.error(`Failed to initialize DM for user ${interaction.user.id}, session ${session.sessionId}:`, error);
        // Inform user in the original interaction channel if DM fails
        await interaction.editReply({
             content: 'I couldn\'t send you a DM. Please check your privacy settings and try again.', 
             ephemeral: true 
        }).catch(e => console.error("Failed to send DM error reply:", e)); // Catch potential error editing reply
        
        // Clean up the failed session
        session.endSession('DM Initialization Failed');
    }
}

module.exports = {
    name: Events.InteractionCreate,
    async execute(interaction) {
        if (interaction.isChatInputCommand()) {
            // --- Slash Command Handling ---
            const command = interaction.client.commands.get(interaction.commandName);

            if (!command) {
                console.error(`No command matching ${interaction.commandName} was found.`);
                await interaction.reply({ content: 'Error: Command not found!', ephemeral: true });
                return;
            }

            try {
                await command.execute(interaction);
            } catch (error) {
                console.error(`Error executing ${interaction.commandName}`);
                console.error(error);
                // Use followUp for modals if interaction was already shown
                if (interaction.deferred || interaction.replied) {
                    await interaction.followUp({ content: 'There was an error while executing this command!', ephemeral: true });
                } else {
                    await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
                }
            }
        } else if (interaction.isModalSubmit()) {
            // --- Modal Submission Handling ---
            if (interaction.customId === 'sessionStartModal') {
                // Defer reply for potentially long-running checks
                await interaction.deferReply({ ephemeral: true });

                // Check if user already has a session ANYWHERE
                if (await SessionManager.hasActiveSessionAnywhere(interaction.user.id)) {
                    await interaction.editReply({ content: 'You already have an active session! Use /stop to end it first.', ephemeral: true });
                    return;
                }

                const characterInput = interaction.fields.getTextInputValue('characterInput');

                // Validate Character Name
                if (!pluginLoader.characterExists(characterInput)) {
                    await interaction.reply({ content: `Sorry, I don't have a character profile loaded for \"${characterInput}\". Please check the spelling or try another character.`, ephemeral: true });
                    return;
                }
                const plugin = pluginLoader.getPlugin(characterInput);
                const characterName = plugin.characterName;

                // --- Get Premium Status --- 
                const isPremium = await UserData.getUserPremiumStatus(interaction.user.id);

                // --- Get Personalization (Premium Only) --- 
                let personalizationInput = '';
                if (isPremium) {
                    try {
                        personalizationInput = interaction.fields.getTextInputValue('personalizationInput');
                    } catch (e) {
                         console.log(`[SessionStart] Personalization field not found or not submitted for premium user ${interaction.user.id} (Optional field).`);
                         personalizationInput = '';
                    }
                }
                // --- End Personalization Handling ---

                // --- Get Remember Profile Choice (Premium Only) --- 
                let useProfileSummary = false; // Default to false
                if (isPremium) {
                    try {
                        const rememberProfileValue = interaction.fields.getTextInputValue('rememberProfileInput')?.toLowerCase();
                        if (rememberProfileValue === 'yes' || rememberProfileValue === 'y') {
                            useProfileSummary = true;
                        }
                    } catch (e) {
                        console.log(`[SessionStart] Remember Profile field not found or not submitted for premium user ${interaction.user.id}. Defaulting to not using profile.`);
                        // Keep useProfileSummary as false
                    }
                    console.log(`[SessionStart] User ${interaction.user.id} chose ${useProfileSummary ? '' : 'NOT ' }to use saved profile summary.`);
                }
                // --- End Remember Profile Handling ---

                // --- Check User Time --- 
                const availableTime = await UserData.getUserTime(interaction.user.id);
                if (availableTime <= 0) {
                     await interaction.editReply({ content: 'You have no time remaining! Please use /premium or wait for a refill.', ephemeral: true });
                    return;
                }
                console.log(`[Command:Start] User ${interaction.user.id} has ${availableTime} minutes remaining.`);
                // --- End Check User Time ---

                // Pass the entire loaded plugin object and personalization to createSession
                const newSession = await SessionManager.createSession(
                    interaction.client, // Pass the client
                    interaction.user.id,
                    plugin,
                    null, // Pass null for durationMinutes (not set here)
                    personalizationInput,
                    useProfileSummary // <<< Pass the user's choice
                );

                if (!newSession) {
                    // Use editReply since we deferred earlier
                    await interaction.editReply({ content: 'Failed to start session. This might be because you already have one active somewhere.', ephemeral: true });
                    return;
                }
                
                // --- Save Latest Personalization Notes (Premium Only) --- 
                if (isPremium) {
                    // Use .then() for fire-and-forget, don't await save here
                    UserData.setUserPersonalizationNotes(interaction.user.id, personalizationInput)
                        .then(() => console.log(`[UserData] Updated personalization notes for premium user ${interaction.user.id} (async).`))
                        .catch(err => console.error(`[UserData] Failed to save personalization notes for user ${interaction.user.id}:`, err));
                }
                // --- End Save --- 

                console.log(`Modal submitted: User=${interaction.user.id}, Session=${newSession.sessionId}`);

                // Use editReply since we deferred earlier
                await interaction.editReply({ 
                    content: `Session request received for **${characterName}**. Attempting to start...`,
                    ephemeral: true
                });

                initializeDmAndStartSession(interaction, newSession); 

            } else if (interaction.customId === 'sessionSettingsModal') {
                // Defer the update immediately
                await interaction.deferReply({ ephemeral: true });

                const character = interaction.fields.getTextInputValue('characterInput');
                const duration = parseInt(interaction.fields.getTextInputValue('durationInput'), 10);
                const preferences = interaction.fields.getTextInputValue('preferencesInput');

                // Validate duration
                 if (isNaN(duration) || duration < 5 || duration > 120) { // Example limits
                     await interaction.editReply({ content: 'Invalid duration. Please enter a number between 5 and 120 minutes.', ephemeral: true });
                    return;
                }
                 // Check if character exists via plugin loader
                if (!pluginLoader.characterExists(character)) {
                    await interaction.editReply({ content: `Character \"${character}\" not found. Use /list-characters to see available options.`, ephemeral: true });
                    return;
                }
                 // Check if user already has a session
                if (SessionManager.hasSession(interaction.user.id)) {
                     await interaction.editReply({ content: 'You already have an active session. Use /stop-session first.', ephemeral: true });
                    return;
                }

                // Create and store the new session
                const session = SessionManager.createSession(interaction.user.id, character, duration, preferences);
                console.log(`Session ${session.sessionId} created for user ${interaction.user.id}.`);
                
                 // Save preferences (potentially update this logic if preferences are no longer used)
                // Memory.saveUserPreferences(interaction.user.id, { lastCharacter: character, lastDuration: duration, customPrefs: preferences });

                // Try to initialize DM and start tasks
                await initializeDmAndStartSession(interaction, session); 

            }
        } else if (interaction.isButton()) { 
            const userId = interaction.user.id;
            // --- Get session locally if possible ---
            const localSession = SessionManager.getLocalSession(userId);
            const hasSessionAnywhere = await SessionManager.hasActiveSessionAnywhere(userId);

            // --- End Session Button Handling ---
            if (interaction.customId === 'end_session_button') {
                if (hasSessionAnywhere) {
                    console.log(`User ${userId} clicked end session button.`);

                    // Defer the update as ending might take time
                    await interaction.deferUpdate();

                    // Placeholder for your custom message
                    const promoMessage = `**Session Ended!**\n\nThanks for using Goon34! Stay connected:\nDiscord: https://discord.gg/2PvbSyBRQj\nWebsite: https://goon34.itch.io/\n\n*(Placeholder: Add your custom closing message here!)*`;

                    let dmSent = false;
                    // Try sending DM only if session is local, otherwise skip (can't get DM channel easily)
                    if (localSession) {
                        try {
                            const dmChannel = await localSession.getDmChannel(interaction.client);
                            if (dmChannel) {
                                await dmChannel.send(promoMessage);
                                dmSent = true;
                                console.log(`[Session ${localSession.sessionId}] Sent closing promo message to user ${userId}.`);
                            } else {
                                console.warn(`[Session ${localSession.sessionId}] Could not fetch DM channel to send closing promo for user ${userId}.`);
                            }
                        } catch (dmError) {
                            console.error(`[Session ${localSession.sessionId}] Error sending closing promo message to user ${userId}:`, dmError);
                        }
                    } else {
                        console.log(`[Interaction] Skipping closing DM for user ${userId} as session is not local to shard ${interaction.client.shard.ids[0]}.`);
                    }

                    // End the session - SessionManager handles finding the right shard
                    const ended = await SessionManager.endSession(interaction.client, userId); 

                    // --- Get Updated Remaining Time ---
                    const remainingTime = await UserData.getUserTime(userId);
                    // --- End Get Time ---

                    try {
                        // Update the original message to disable the button and confirm
                        await interaction.update({ 
                            content: `Session ended. You have ${remainingTime} minutes remaining. ${dmSent ? 'Check your DMs for a final message!' : 'Could not send final DM.'}`, 
                            components: [] // Remove buttons
                        });
                    } catch (updateError) {
                         console.error(`[Session ${ended.sessionId}] Failed to update end session button interaction:`, updateError);
                         // Attempt to send a new ephemeral reply as a fallback
                         try {
                            await interaction.followUp({ 
                                content: `Session ended. You have ${remainingTime} minutes remaining.`, 
                                ephemeral: true 
                            });
                         } catch (fallbackError) {
                            console.error(`[Session ${ended.sessionId}] Failed to send fallback confirmation for end session:`, fallbackError);
                         }
                    }
                } else {
                    // User has no active session, just acknowledge ephemerally
                    // Fetch time even if no session was found (to initialize if needed)
                    const remainingTime = await UserData.getUserTime(userId);
                    await interaction.reply({ content: `You don't seem to have an active session. You have ${remainingTime} minutes remaining.`, ephemeral: true });
                }
                return; // Stop further processing for this interaction
            }

            // --- Activity Check Button Handling (Task 7b) ---
            // NOTE: Activity checks are currently disabled in Session.js
            if (interaction.customId === 'activity_check_button') {
                if (localSession) { // Only act if session is local
                    // Reset the inactivity timeout for this session
                    localSession.resetActivityTimeout(); 
                    try {
                        // Acknowledge the button press
                         await interaction.reply({ content: 'Activity confirmed!', ephemeral: true });
                    } catch (e) { console.error("Failed to reply to activity check:", e); }
                } else {
                    // User might be clicking an old button after session ended elsewhere
                     await interaction.reply({ content: 'You don\'t seem to have an active session on this shard.', ephemeral: true });
                }
                 return; // Stop further processing
            }

            // --- Trigger Button Handling (Premium Only) ---
            if (interaction.customId === 'triggered_button') {
                if (localSession) { // Can only record trigger if session is local
                    console.log(`[Session ${localSession.sessionId}] User ${userId} clicked TRIGGERED button.`);
                    localSession.recordTrigger(); // Call the method in Session.js
                    // Acknowledge ephemerally
                    try {
                        await interaction.reply({ content: 'Trigger noted... enjoy the feeling 🥴', ephemeral: true });
                    } catch (e) { console.error("Failed to reply to trigger button:", e); }
                } else {
                    // User might be clicking an old button after session ended elsewhere
                    await interaction.reply({ content: 'Cannot record trigger: No active session found on this shard.', ephemeral: true });
                }
                return; // Stop further processing
            }

            // --- Default Button Handling (Unknown) ---
             console.log(`[Interaction] Unhandled button interaction: ${interaction.customId}`);
             try {
                 await interaction.reply({ content: 'This button seems to be inactive.', ephemeral: true });
             } catch (e) { console.error("Failed to reply to unknown button:", e); }
        } else {
            // Handle other interaction types if needed
            return;
        }
    },
}; 