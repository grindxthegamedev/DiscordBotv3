const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const UserData = require('../utils/userData');
const pluginLoader = require('../plugins/pluginLoader');

// --- Simple FAQ ---
const faqContent = `
**What is this bot?**
This is Goon34, an NSFW bot that provides JOI (Jerk Off Instruction) sessions featuring various characters.

**How do I start?**
Use the \`/start\` command and fill out the modal with the character name.

**How does usage time work?**
Everyone starts with 20 minutes. Time is deducted based on how long your session runs. You can check your remaining time here.

**How can I stop a session?**
Click the "End Session" button attached to the bot's messages during a session.

**How do I get Premium?**
Use \`/premium <key>\` if you have a valid premium key.
`;
// --- End FAQ ---

module.exports = {
    data: new SlashCommandBuilder()
        .setName('info')
        .setDescription('Shows bot info, your status, and available characters.'),

    async execute(interaction) {
        const userId = interaction.user.id;

        try {
            // Fetch user data and character list concurrently
            const [userData, characterList] = await Promise.all([
                UserData.getUserData(userId),
                pluginLoader.getAvailableCharacters()
            ]);

            const remainingTime = userData.remainingMinutes;
            const isPremium = userData.isPremium;
            const profileSummary = userData.llmProfileSummary;

            const charactersString = characterList.length > 0
                ? characterList.join(', ')
                : 'No characters loaded.';

            const embed = new EmbedBuilder()
                .setTitle('Goon34 Bot Info')
                .setColor(0xAA00AA)
                .addFields(
                    { name: '🕒 Your Remaining Time', value: `${remainingTime} minutes`, inline: true },
                    { name: '⭐ Premium Status', value: `${isPremium ? 'Active' : 'Inactive'}`, inline: true }
                );

            if (isPremium && profileSummary) {
                embed.addFields({ name: '📝 AI Profile Summary', value: profileSummary });
            } else if (isPremium) {
                embed.addFields({ name: '📝 AI Profile Summary', value: '_No summary generated yet. Complete a session!_' });
            }

            embed.addFields(
                { name: '🎭 Available Characters', value: charactersString },
                { name: '❓ FAQ', value: faqContent }
            );
            
            embed.setTimestamp()
                 .setFooter({ text: 'Use /start to begin a session!' });

            await interaction.reply({ embeds: [embed], ephemeral: true });

        } catch (error) {
            console.error(`[Command:Info] Error fetching info for user ${userId}:`, error);
            await interaction.reply({ content: 'Sorry, there was an error fetching your information.', ephemeral: true });
        }
    },
};