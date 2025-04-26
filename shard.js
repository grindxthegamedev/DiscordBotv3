require('dotenv').config();
const { ShardingManager } = require('discord.js');

const manager = new ShardingManager('./index.js', {
    token: process.env.DISCORD_BOT_TOKEN, // Make sure this matches your .env variable name
    totalShards: 'auto' // Let Discord recommend the number of shards
});

manager.on('shardCreate', shard => {
    console.log(`[ShardingManager] Launched shard ${shard.id}`);
});

manager.spawn().catch(error => {
    console.error('[ShardingManager] Error spawning shards:', error);
}); 