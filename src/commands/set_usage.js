const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const { setUserTime, addUserTime, updateUserTime } = require('../utils/userData');

// --- Configuration ---
// IMPORTANT: Replace this with a more secure method like environment variables
const ADMIN_PASSWORD = 'Test'; 
// --- End Configuration ---

module.exports = {
    data: new SlashCommandBuilder()
        .setName('set_usage')
        .setDescription('Sets, adds, or subtracts session time for a user (Admin Only).')
        .addStringOption(option => 
            option.setName('action')
                .setDescription('The action to perform on the user\'s time.')
                .setRequired(true)
                .addChoices(
                    { name: 'Set Time', value: 'set' },
                    { name: 'Add Time', value: 'add' },
                    { name: 'Subtract Time', value: 'subtract' }
                ))
        .addUserOption(option => 
            option.setName('user')
                .setDescription('The user whose time is being modified.')
                .setRequired(true))
        .addIntegerOption(option =>
            option.setName('time')
                .setDescription('The amount of time in minutes (to set, add, or subtract).')
                .setRequired(true)
                .setMinValue(0)) // Prevent negative values for add/subtract/set amount
        .addStringOption(option => 
            option.setName('password')
                .setDescription('The admin password required to use this command.')
                .setRequired(true))
        // Optional: Restrict command visibility/usage further via permissions
        // .setDefaultMemberPermissions(PermissionsBitField.Flags.Administrator) 
        .setDMPermission(false), // Likely only makes sense in a guild context
        
    async execute(interaction) {
        const action = interaction.options.getString('action');
        const targetUser = interaction.options.getUser('user');
        const timeAmount = interaction.options.getInteger('time');
        const providedPassword = interaction.options.getString('password');

        // --- Password Check ---
        if (providedPassword !== ADMIN_PASSWORD) {
            await interaction.reply({ content: 'Incorrect password.', ephemeral: true });
            console.log(`[Command:SetUsage] Failed attempt by ${interaction.user.tag} (Incorrect Password)`);
            return;
        }
        // --- End Password Check ---

        // --- Perform Action ---
        try {
            let successMessage = '';
            switch (action) {
                case 'set':
                    await setUserTime(targetUser.id, timeAmount);
                    successMessage = `Successfully set remaining time for ${targetUser.tag} to ${timeAmount} minutes.`;
                    console.log(`[Command:SetUsage] User ${interaction.user.tag} SET ${targetUser.tag}'s time to ${timeAmount} minutes.`);
                    break;
                case 'add':
                    await addUserTime(targetUser.id, timeAmount);
                    // We might want to fetch the new time to display it, but let's keep it simple for now
                    successMessage = `Successfully added ${timeAmount} minutes to ${targetUser.tag}.`; 
                    console.log(`[Command:SetUsage] User ${interaction.user.tag} ADDED ${timeAmount} minutes to ${targetUser.tag}.`);
                    break;
                case 'subtract':
                    await updateUserTime(targetUser.id, timeAmount); // updateUserTime handles subtraction
                    successMessage = `Successfully subtracted ${timeAmount} minutes from ${targetUser.tag}.`;
                    console.log(`[Command:SetUsage] User ${interaction.user.tag} SUBTRACTED ${timeAmount} minutes from ${targetUser.tag}.`);
                    break;
                default:
                    // Should not happen due to choices, but good practice
                    await interaction.reply({ content: 'Invalid action specified.', ephemeral: true });
                    return;
            }

            await interaction.reply({ 
                content: successMessage, 
                ephemeral: true 
            });

        } catch (error) {
            console.error(`[Command:SetUsage] Error performing action '${action}' for ${targetUser.id}:`, error);
            await interaction.reply({ content: 'An error occurred while trying to modify the user\'s time.', ephemeral: true });
        }
        // --- End Perform Action ---
    },
}; 