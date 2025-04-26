const { ModalBuilder, TextInputBuilder, ActionRowBuilder, TextInputStyle, SlashCommandBuilder } = require('discord.js');
const UserData = require('../utils/userData'); // Hypothetical user data module

module.exports = {
    data: new SlashCommandBuilder()
        .setName('start')
        .setDescription('Starts a new Goon34 session.'),
    async execute(interaction) {
        const userId = interaction.user.id;

        // --- Usage Time Check --- 
        const remainingTime = await UserData.getUserTime(userId); // Assume returns minutes
        console.log(`[Command:Start] User ${userId} has ${remainingTime} minutes remaining.`);

        if (remainingTime <= 0) {
            await interaction.reply({ content: 'You have run out of session time. Please wait for it to replenish or acquire more.', ephemeral: true });
            return;
        }
        // --- End Usage Time Check ---

        // --- Check Premium Status for Personalization --- 
        const isPremium = await UserData.getUserPremiumStatus(userId);

        // --- Build Modal --- 
        const modal = new ModalBuilder()
            .setCustomId('sessionStartModal')
            .setTitle('Start New Session');

        // --- Character Input --- 
        const characterInput = new TextInputBuilder()
            .setCustomId('characterInput')
            .setLabel("Character Name")
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('E.g., Widowmaker, Tracer (Type exact name)')
            .setRequired(true);

        const firstActionRow = new ActionRowBuilder().addComponents(characterInput);
        
        modal.addComponents(firstActionRow); // Add character row

        // --- Premium Only Inputs --- 
        let premiumActionRow1, premiumActionRow2;
        if (isPremium) {
            // Personalization Notes
            const personalizationInput = new TextInputBuilder()
                .setCustomId('personalizationInput')
                .setLabel("⭐ Personalization Notes (Premium)")
                .setStyle(TextInputStyle.Paragraph)
                .setPlaceholder('Notes for AI (e.g., \'Call me puppy\', \'Focus on denial\', \'Avoid X\')')
                .setRequired(false);
            premiumActionRow1 = new ActionRowBuilder().addComponents(personalizationInput);
            
            // Remember Profile Choice (Pseudo-Checkbox)
            const rememberProfileInput = new TextInputBuilder()
                .setCustomId('rememberProfileInput')
                .setLabel("🧠 Use Saved Profile? (Premium)") // Short label
                .setStyle(TextInputStyle.Short) // Short style for Yes/No
                .setPlaceholder("Type 'Yes' to use saved info") // Short placeholder
                .setValue('Yes') // Default to Yes
                .setRequired(false); // Optional
            premiumActionRow2 = new ActionRowBuilder().addComponents(rememberProfileInput);
            
            modal.addComponents(premiumActionRow1, premiumActionRow2); // Add premium rows
        }

        await interaction.showModal(modal);
    },
}; 