
# True_Discord Bot

A clean rebuild of the Discord bot focused on reliability and simplicity. Includes yt-dlp integration for downloading and sending media within Discord limits.

## Features

- Slash commands: /ping, /setup, /download, /crunchy
- Per-user temp folders in `True_Discord/downloads`
- Uses yt-dlp (auto-download if not found)
- Ephemeral interactions and error handling

## Setup

1. Create a copy of `.env.example` named `.env` and fill:
   - DISCORD_TOKEN, CLIENT_ID, (optional GUILD_ID for guild-only registration)
2. Install dependencies.
3. Register commands.
4. Start the bot.

### Crunchyroll (CRD) setup

This bot can call the included Crunchy-Downloader (CRD.exe) to download Crunchyroll links.

- Place your Crunchyroll credentials in `Crunchy-Downloader-master/CRD/credentials.json` (or `Crunchy-Downloader-master/credentials.json` if CRD reads root).
- Ensure `Crunchy-Downloader-master/CRD.exe` exists (it's included in the repo but is ignored by Git).
- Known limitation: DRM-protected titles cannot be downloaded; the command will report this.
- Working on DRM-Bypass Fix using `https://github.com/Crunchy-DL/Crunchy-Downloader`

## Commands (PowerShell)

```powershell
# 1) Install deps
npm install

# 2) Register slash commands (guild recommended for faster updates)
node src/register-commands.js

# 3) Start bot
npm start
```

If you use global commands, they may take up to 1 hour to appear.

## Notes

- On first run, yt-dlp will be fetched to %USERPROFILE%\.ytdownloader-bot\yt-dlp.exe if not found on PATH.
- Max upload size is 25MB unless your server has higher limits; large files will be saved to disk and linked instead.

### Crunchyroll command

Use `/crunchy url:<cr_link> quality:[1080p|720p|480p|360p] format:[mp4|mkv]`.
Downloads are saved under `True_Discord/downloads/<yourUserId>/` and the newest file is attached if small enough.
