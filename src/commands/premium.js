const { SlashCommandBuilder } = require('discord.js');
const UserData = require('../utils/userData'); // Import UserData utilities

module.exports = {
    data: new SlashCommandBuilder()
        .setName('premium')
        .setDescription('Unlock premium features with a valid key.')
        .addStringOption(option =>
            option.setName('key')
                .setDescription('Your premium access key.')
                .setRequired(true)),
    async execute(interaction) {
        const userId = interaction.user.id;
        const key = interaction.options.getString('key');

        try {
            // 1. Check if already premium
            const isAlreadyPremium = await UserData.getUserPremiumStatus(userId);
            if (isAlreadyPremium) {
                await interaction.reply({ content: 'You already have premium access!', ephemeral: true });
                return;
            }

            // 2. Check if the key is valid
            const isValid = await UserData.isValidPremiumKey(key);
            if (!isValid) {
                await interaction.reply({ content: 'Invalid or expired premium key.', ephemeral: true });
                return;
            }

            // 3. Grant premium and invalidate key
            await UserData.setPremiumStatus(userId, true);
            await UserData.invalidatePremiumKey(key);

            await interaction.reply({ content: '🎉 Congratulations! Premium features unlocked. Enjoy!', ephemeral: true });
            console.log(`[Premium] User ${userId} successfully activated premium with key: ${key}`);

        } catch (error) {
            console.error(`[Premium] Error processing premium command for user ${userId}:`, error);
            await interaction.reply({ content: 'An error occurred while trying to activate premium. Please try again later.', ephemeral: true });
        }
    },
}; 