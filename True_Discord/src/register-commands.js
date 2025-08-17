require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { REST, Routes } = require('discord.js');

const commands = [
  {
    name: 'ping',
    description: 'Check bot latency'
  },
  {
    name: 'setup',
    description: 'DM me a private panale (Note you need to be in the Everything Server)'
  },
  {
    name: 'clearpanel',
    description: 'Clear your private download panel'
  },
  {
    name: 'download',
    description: 'Download media via URL',
    options: [
      {
        name: 'url',
        description: 'Video or audio URL',
        type: 3,
        required: true
      },
      {
        name: 'type',
        description: 'video or audio',
        type: 3,
        required: false,
        choices: [
          { name: 'video', value: 'video' },
          { name: 'audio', value: 'audio' }
        ]
      },
      {
        name: 'quality',
        description: 'video quality',
        type: 3,
        required: false,
        choices: [
          { name: '360p', value: '360p' },
          { name: '480p', value: '480p' },
          { name: '720p', value: '720p' },
          { name: '1080p', value: '1080p' },
          { name: '2160p (4K)', value: '2160p' }
        ]
      },
      {
        name: 'format',
        description: 'audio format',
        type: 3,
        required: false,
        choices: [
          { name: 'mp3', value: 'mp3' },
          { name: 'm4a', value: 'm4a' },
          { name: 'opus', value: 'opus' }
        ]
      }
    ]
  },
  {
    name: 'crunchy',
    description: 'Download a Crunchyroll video using CRD',
    options: [
      {
        name: 'url',
        description: 'Crunchyroll episode/movie URL',
        type: 3,
        required: true
      },
      {
        name: 'quality',
        description: 'Preferred quality',
        type: 3,
        required: false,
        choices: [
          { name: '1080p', value: '1080p' },
          { name: '720p', value: '720p' },
          { name: '480p', value: '480p' },
          { name: '360p', value: '360p' }
        ]
      },
      {
        name: 'format',
        description: 'Container format',
        type: 3,
        required: false,
        choices: [
          { name: 'mp4', value: 'mp4' },
          { name: 'mkv', value: 'mkv' }
        ]
      }
    ]
  }
  ,
  {
    name: 'main',
    description: 'Owner-only stats overview'
  }
];

async function main() {
  const token = process.env.DISCORD_TOKEN;
  const clientId = process.env.CLIENT_ID;
  const guildId = process.env.GUILD_ID; // optional

  if (!token || !clientId) {
    console.error('Missing DISCORD_TOKEN or CLIENT_ID in .env.');
    process.exit(1);
  }

  const rest = new REST({ version: '10' }).setToken(token);
  if (guildId) {
    await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: commands });
    console.log('Guild commands registered.');
  } else {
    await rest.put(Routes.applicationCommands(clientId), { body: commands });
    console.log('Global commands registered.');
  }
}

main().catch((e) => {
  console.error('Command registration failed:', e);
  process.exit(1);
});
