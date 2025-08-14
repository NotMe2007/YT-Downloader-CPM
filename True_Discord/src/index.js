require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') });
const { Client, GatewayIntentBits, AttachmentBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder, Partials, MessageFlags, ChannelType } = require('discord.js');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs-extra');
const http = require('http');
const os = require('os');
const { URL } = require('url');
const ytdlp = require('./utils/ytdlp');
const crunchy = require('./utils/crunchy');

const DOWNLOAD_ROOT = path.join(__dirname, '..', 'downloads');
const ALLOWED_GUILD_ID = '1322593598075834498';
const LOG_CHANNEL_ID = process.env.LOG_CHANNEL_ID || '';
const DOWNLOAD_PORT = Number(process.env.DOWNLOAD_PORT || 5055);
const DATA_DIR = path.join(__dirname, '..', 'data');
const METRICS_PATH = path.join(DATA_DIR, 'metrics.json');
const OWNER_ID = '1260901672037908593';
const SECURE_LARGE_ROOT = path.join(DOWNLOAD_ROOT, '_secure');
const FAILED_ATTEMPTS_PATH = path.join(DATA_DIR, 'failed-attempts.json');

const sessions = new Map(); // userId -> { url, type, quality, videoFormat, audioFormat, panelMessageId, dmChannelId, status }

// Minimal privacy-safe log: hostname + quality only
async function postServerLog(client, type, payload) {
  payload = payload || {};
  const { url, quality, userId, note } = payload;
  try {
    const guild = await client.guilds.fetch(ALLOWED_GUILD_ID).catch(() => null);
    if (!guild) return;
    let channel = null;
    if (LOG_CHANNEL_ID) channel = await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (!channel) channel = guild.systemChannel || null;
    if (!channel || !channel.isTextBased?.()) return;
    const host = (() => { try { return url ? new URL(url).hostname : 'unknown'; } catch { return 'unknown'; } })();
    const safe = `event=${type} host=${host} quality=${quality || 'n/a'} user=<hidden>${note ? ` note=${note}` : ''}`;
    await channel.send({ content: safe }).catch(() => {});
  } catch (_) {}
}

// --- Logging ---
const LOG_FILE = path.join(__dirname, '../logs/bot.log');
async function logToFile(type, msg) {
  const line = `[${new Date().toISOString()}] [${type}] ${msg}\n`;
  try {
    await fs.ensureDir(path.dirname(LOG_FILE));
    await fs.appendFile(LOG_FILE, line, 'utf8');
    // Rotate if > 5000 lines
    const data = await fs.readFile(LOG_FILE, 'utf8');
    const lines = data.split(/\r?\n/);
    if (lines.length > 5000) {
      await fs.writeFile(LOG_FILE, lines.slice(-5000).join('\n'), 'utf8');
    }
  } catch (e) {}
}

// Error reporting
async function reportError(client, user, err, ctx = '') {
  const msg = `Error${ctx ? ` (${ctx})` : ''}: ${err?.message || String(err)}`;
  try { await user.send({ content: msg }); } catch (_) {}
  try { await postServerLog(client, 'error', { note: ctx }); } catch (_) {}
  try { await incMetric('errors_total'); } catch (_) {}
  try { await logToFile('ERROR', `${ctx ? ctx + ': ' : ''}${err?.stack || err}`); } catch (_) {}
}

// Info logging helper
async function logInfo(msg) {
  try { await logToFile('INFO', msg); } catch (_) {}
}

function buildVideoArgs(quality, outputDir, template, containerFmt) {
  const map = {
    '360p': 'best[height<=360]',
    '480p': 'best[height<=480]',
    '720p': 'best[height<=720]',
  '1080p': 'best[height<=1080]',
  '2160p': 'best[height<=2160]'
  };
  const q = map[quality] || 'best[height<=720]';
  const args = ['-f', `${q}/best`, '-P', outputDir, '-o', template, '--no-playlist', '--no-warnings'];
  const fmt = (containerFmt || 'mp4').toLowerCase();
  if (['mp4', 'mkv', 'webm', 'flv'].includes(fmt)) {
    args.push('--merge-output-format', fmt);
  }
  return args;
}

function buildAudioArgs(format, outputDir, template) {
  const fmt = ['mp3', 'm4a', 'opus'].includes((format || '').toLowerCase()) ? format.toLowerCase() : 'mp3';
  return ['-x', '--audio-format', fmt, '--audio-quality', '0', '-P', outputDir, '-o', template, '--no-playlist', '--no-warnings'];
}

async function ensureDirs(userId) {
  const dir = path.join(DOWNLOAD_ROOT, userId);
  await fs.ensureDir(dir);
  return dir;
}

function sizeLimitBytes() {
  // Direct send threshold (26MB)
  return 26 * 1024 * 1024;
}

// Metrics helpers
let metrics = null; // in-memory metrics
async function loadMetrics() {
  await fs.ensureDir(DATA_DIR);
  try { metrics = await fs.readJson(METRICS_PATH); } catch { metrics = null; }
  if (!metrics || typeof metrics !== 'object') {
    metrics = { started_at: Date.now(), usersSeen: [], downloads_total: 0, errors_total: 0, yt_dlp_downloads: 0, crunchy_downloads: 0 };
    await fs.writeJson(METRICS_PATH, metrics, { spaces: 2 });
  }
}
async function saveMetrics() {
  if (!metrics) return;
  try { await fs.writeJson(METRICS_PATH, metrics, { spaces: 2 }); } catch (_) {}
}
async function recordUser(userId) {
  if (!metrics) await loadMetrics();
  if (!metrics.usersSeen.includes(userId)) {
    metrics.usersSeen.push(userId);
    await saveMetrics();
  }
}
async function incMetric(key) {
  if (!metrics) await loadMetrics();
  metrics[key] = (metrics[key] || 0) + 1;
  await saveMetrics();
}
async function incDownload(kind) {
  await incMetric('downloads_total');
  if (kind === 'yt') await incMetric('yt_dlp_downloads');
  if (kind === 'crunchy') await incMetric('crunchy_downloads');
}

function buildStatsEmbed() {
  const totalUsers = (metrics?.usersSeen?.length) || 0;
  const downloads = (metrics?.downloads_total) || 0;
  const errors = (metrics?.errors_total) || 0;
  const yt = (metrics?.yt_dlp_downloads) || 0;
  const cr = (metrics?.crunchy_downloads) || 0;
  const upMs = Date.now() - ((metrics?.started_at) || Date.now());
  const upHr = Math.floor(upMs / 3600000);
  const upMin = Math.floor((upMs % 3600000) / 60000);
  return new EmbedBuilder()
    .setColor(0x2b6cb0)
    .setTitle('YT Downloader — Main Stats')
    .addFields(
      { name: 'Party Size', value: String(totalUsers), inline: true },
      { name: 'Downloads (total)', value: String(downloads), inline: true },
      { name: 'Errors (total)', value: String(errors), inline: true },
      { name: 'YT-dlp', value: String(yt), inline: true },
      { name: 'Crunchyroll', value: String(cr), inline: true },
      { name: 'Queue', value: `${activeJob ? 1 : 0} running, ${jobQueue.length} queued`, inline: false },
      { name: 'Uptime', value: `${upHr}h ${upMin}m`, inline: false }
    )
    .setTimestamp();
}

let mainStatsTimer = null;
let mainStatsMsgRef = null; // { channelId, messageId }

async function updateMainStatsMessage(client) {
  try {
    if (!mainStatsMsgRef) return;
    if (!metrics) await loadMetrics();
    const ch = await client.channels.fetch(mainStatsMsgRef.channelId).catch(() => null);
    if (!ch || !ch.messages) return;
    const msg = await ch.messages.fetch(mainStatsMsgRef.messageId).catch(() => null);
    if (!msg) return;
    const embed = buildStatsEmbed();
    await msg.edit({ embeds: [embed] }).catch(() => {});
  } catch (_) {}
}

// Queue system
const jobQueue = [];
let activeJob = null; // { userId, run }

function nextJob(client) {
  if (activeJob || jobQueue.length === 0) return;
  const job = jobQueue.shift();
  activeJob = job;
  // After pulling next job, refresh remaining queue positions
  refreshQueueStatuses(client);
  job.run().finally(() => {
    activeJob = null;
    setImmediate(() => nextJob(client));
    // After a job finishes (success or error), update remaining queued statuses
    refreshQueueStatuses(client);
  });
}

function refreshQueueStatuses(client) {
  try {
    for (let i = 0; i < jobQueue.length; i++) {
      const { userId } = jobQueue[i];
      const state = sessions.get(userId);
      if (state && state.panelMessageId && state.dmChannelId) {
        const updated = { ...state, status: `Queued. Position: ${i + 1}` };
        sessions.set(userId, updated);
        refreshPanelMessage(client, updated).catch(()=>{});
      }
    }
  } catch (_) {}
}

// File server for large downloads (one-time codes)
// pendingDownloads value: { filePath, filename, expiresAt, userId, size, downloading, bytesSent }
const pendingDownloads = new Map();
const usedPins = new Map(); // pin -> { reason, until }
const failedAttempts = new Map(); // ip -> { count, blockedUntil }
const lastStatusPoll = new Map(); // ip -> timestamp ms (rate-limit /status)
async function loadFailedAttempts() {
  try { await fs.ensureDir(DATA_DIR); const data = await fs.readJson(FAILED_ATTEMPTS_PATH); if (data && typeof data === 'object') { for (const [k,v] of Object.entries(data)) failedAttempts.set(k, v); } } catch(_) {}
}
async function saveFailedAttempts() {
  try {
    const out = {};
    const now = Date.now();
    for (const [ip, rec] of failedAttempts.entries()) {
      if (rec.blockedUntil && rec.blockedUntil < now && rec.count < 5) continue; // prune stale minor entries
      out[ip] = rec;
    }
    await fs.writeJson(FAILED_ATTEMPTS_PATH, out, { spaces: 2 });
  } catch(_) {}
}
async function recordFailedAttempt(ip, fa) { failedAttempts.set(ip, fa); await saveFailedAttempts(); }
let fileServerStarted = false;
function startFileServer(client) {
  if (fileServerStarted) return;
  fileServerStarted = true;
  const server = http.createServer(async (req, res) => {
    try {
      const ip = (req.socket.remoteAddress || '').replace('::ffff:','');
      const fa = failedAttempts.get(ip);
      if (fa && fa.blockedUntil > Date.now()) { res.writeHead(404); res.end('notfound'); return; }
      const urlObj = new URL(req.url, `http://localhost:${DOWNLOAD_PORT}`);
      const pathname = urlObj.pathname;
      if (pathname === '/status') {
        // simple rate limit: max 1 request per 1.5s per IP
        const last = lastStatusPoll.get(ip) || 0;
        if (Date.now() - last < 1500) { res.writeHead(429); res.end('rate'); return; }
        lastStatusPoll.set(ip, Date.now());
        const pin = urlObj.searchParams.get('pin');
        const entry = pin ? pendingDownloads.get(pin) : null;
        const used = !entry ? usedPins.get(pin) : null;
        if (!entry) {
          if (used && used.until > Date.now()) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ status: used.reason === 'used' ? 'complete' : 'invalid' })); return; }
          res.writeHead(404); res.end('notfound'); return; }
        if (Date.now() > entry.expiresAt) { res.writeHead(410); res.end('expired'); return; }
        // Only allow status from bound IP (or first IP binds it silently)
        if (!entry.boundIp) entry.boundIp = ip; else if (entry.boundIp !== ip) { res.writeHead(404); res.end('notfound'); return; }
        const now = Date.now();
        let percent = entry.size ? Math.floor((entry.bytesSent / entry.size) * 100) : 0;
        if (percent > 100) percent = 100;
        let etaSeconds = null;
        if (entry.startedAt && entry.bytesSent > 0) {
          const elapsed = (now - entry.startedAt)/1000;
            const speed = entry.bytesSent / Math.max(elapsed, 0.001);
            const remaining = entry.size - entry.bytesSent;
            if (remaining > 0) etaSeconds = Math.round(remaining / Math.max(speed,1));
        }
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: entry.downloading ? 'downloading' : (entry.bytesSent>0 ? 'partial' : 'pending'), percent, bytesSent: entry.bytesSent, size: entry.size, etaSeconds }));
        return;
      }
      if (pathname === '/fileinfo') {
        const pin = urlObj.searchParams.get('pin');
        const entry = pin ? pendingDownloads.get(pin) : null;
        if (!entry) {
          const used = usedPins.get(pin);
          if (used && used.until > Date.now()) { res.writeHead(409, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'used' })); return; }
          // count failed attempt
          if (!fa || fa.blockedUntil <= Date.now()) {
            const next = fa && fa.blockedUntil <= Date.now() ? { count:0, blockedUntil:0 } : (fa || { count:0, blockedUntil:0 });
            next.count += 1;
            if (next.count >= 5) { next.blockedUntil = Date.now() + 24*60*60*1000; }
            await recordFailedAttempt(ip, next);
          }
          res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'notfound' })); return;
        }
        if (Date.now() > entry.expiresAt) { pendingDownloads.delete(pin); usedPins.set(pin, { reason: 'expired', until: Date.now() + 900000 }); res.writeHead(410, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'expired' })); return; }
        // Bind first successful /fileinfo request to IP (device lock)
        if (!entry.boundIp) {
          entry.boundIp = ip;
        } else if (entry.boundIp !== ip) {
          // treat as incorrect attempt (wrong device)
          if (!fa || fa.blockedUntil <= Date.now()) {
            const next = fa && fa.blockedUntil <= Date.now() ? { count:0, blockedUntil:0 } : (fa || { count:0, blockedUntil:0 });
            next.count += 1; if (next.count >= 5) { next.blockedUntil = Date.now() + 24*60*60*1000; }
            failedAttempts.set(ip, next);
          }
          res.writeHead(404, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: 'notfound' })); return;
        }
        const st = await fs.stat(entry.filePath).catch(() => null);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ filename: entry.filename, size: st ? st.size : 0 }));
        return;
      }
      if (pathname === '/download') {
        const pin = urlObj.searchParams.get('pin');
        const entry = pin ? pendingDownloads.get(pin) : null;
        if (!entry) { const used = usedPins.get(pin); if (used && used.until > Date.now()) { res.writeHead(409); res.end('used'); return; } // invalid attempt
          if (!fa || fa.blockedUntil <= Date.now()) {
            const next = fa && fa.blockedUntil <= Date.now() ? { count:0, blockedUntil:0 } : (fa || { count:0, blockedUntil:0 });
            next.count += 1; if (next.count >= 5) { next.blockedUntil = Date.now() + 24*60*60*1000; }
            await recordFailedAttempt(ip, next);
          }
          res.writeHead(404); res.end('notfound'); return; }
        if (Date.now() > entry.expiresAt) { pendingDownloads.delete(pin); usedPins.set(pin, { reason: 'expired', until: Date.now() + 900000 }); res.writeHead(410); res.end('expired'); return; }
        // Enforce same IP
        if (!entry.boundIp) {
            entry.boundIp = ip; // first download binds
        } else if (entry.boundIp !== ip) {
          if (!fa || fa.blockedUntil <= Date.now()) {
            const next = fa && fa.blockedUntil <= Date.now() ? { count:0, blockedUntil:0 } : (fa || { count:0, blockedUntil:0 });
            next.count += 1; if (next.count >= 5) { next.blockedUntil = Date.now() + 24*60*60*1000; }
            recordFailedAttempt(ip, next);
          }
          res.writeHead(404); res.end('notfound'); return;
        }
        const st = await fs.stat(entry.filePath).catch(() => null);
        if (!st || !st.isFile()) { pendingDownloads.delete(pin); res.writeHead(410); res.end('gone'); return; }
        res.statusCode = 200;
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Disposition', `attachment; filename="${path.basename(entry.filename)}"`);
        entry.downloading = true; entry.bytesSent = 0; entry.size = st.size;
        entry.startedAt = Date.now();
        const stream = fs.createReadStream(entry.filePath);
        stream.on('data', (chunk) => { entry.bytesSent += chunk.length; });
        stream.pipe(res);
        stream.on('close', () => {
          entry.downloading = false;
          const complete = entry.bytesSent >= entry.size;
          if (complete) {
            pendingDownloads.delete(pin);
            usedPins.set(pin, { reason: 'used', until: Date.now() + 900000 });
            fs.unlink(entry.filePath).catch(()=>{});
          } else {
            // Partial / failed download, extend window for retry (10 min)
            entry.expiresAt = Date.now() + 10*60*1000;
          }
        });
        stream.on('error', () => { try { res.end(); } catch (_) {} });
        return;
      }
      res.writeHead(404); res.end('Not found');
    } catch (e) {
      try { res.writeHead(500); res.end('error'); } catch (_) {}
    }
  });
  server.listen(DOWNLOAD_PORT, () => {});
  setInterval(() => {
    const now = Date.now();
    for (const [pin, v] of Array.from(pendingDownloads.entries())) {
      if (now > v.expiresAt && !v.downloading) { // expired and not actively downloading
        pendingDownloads.delete(pin);
        usedPins.set(pin, { reason: 'expired', until: Date.now() + 900000 });
        if (v.userId) {
          client.users.fetch(v.userId).then(u => {
            u.send({ content: `Your large download (code ${pin}) expired (not started within 25 minutes) and was deleted.` }).catch(()=>{});
          }).catch(()=>{});
        }
        fs.unlink(v.filePath).catch(()=>{});
      }
    }
    for (const [pin, v] of Array.from(usedPins.entries())) { if (v.until <= now) usedPins.delete(pin); }
  }, 60_000);
}

// Secure directory automatic cleanup (remove stale dirs > 6h or empty)
async function cleanupSecureDirs() {
  try {
    await fs.ensureDir(SECURE_LARGE_ROOT);
    const entries = await fs.readdir(SECURE_LARGE_ROOT).catch(()=>[]);
    const cutoff = Date.now() - 6*60*60*1000; // 6 hours
    for (const sub of entries) {
      const full = path.join(SECURE_LARGE_ROOT, sub);
      let st; try { st = await fs.stat(full); } catch { continue; }
      if (!st.isDirectory()) continue;
      let remove = false;
      if (st.mtimeMs < cutoff) remove = true;
      else {
        // if empty
        const files = await fs.readdir(full).catch(()=>[]);
        if (files.length === 0) remove = true;
      }
      if (remove) { await fs.remove(full).catch(()=>{}); }
    }
  } catch(_) {}
}
function scheduleSecureCleanup() { setInterval(() => cleanupSecureDirs(), 30*60*1000); } // every 30m

function getServerAddress() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const net of ifaces[name] || []) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return '127.0.0.1';
}

function generatePin() {
  return Math.floor(10_000_000 + Math.random() * 90_000_000).toString(); // 8-digit
}

function formatLocalizedDuration(ms, locale='en') {
  if (ms <= 0) return locale.startsWith('tr') ? 'süresi doldu' : 'expired';
  const sec = Math.floor(ms/1000);
  const h = Math.floor(sec/3600);
  const m = Math.floor((sec%3600)/60);
  const s = sec%60;
  const parts = [];
  const L = locale.toLowerCase();
  const words = (unit, value) => {
    if (L.startsWith('tr')) return unit==='h'?`${value}sa`:unit==='m'?`${value}dk`:`${value}sn`;
    if (L.startsWith('es')) return unit==='h'?`${value}h`:unit==='m'?`${value}m`:`${value}s`;
    if (L.startsWith('de')) return unit==='h'?`${value}Std`:unit==='m'?`${value}Min`:`${value}Sek`;
    if (L.startsWith('fr')) return unit==='h'?`${value}h`:unit==='m'?`${value}m`:`${value}s`;
    if (L.startsWith('it')) return unit==='h'?`${value}h`:unit==='m'?`${value}m`:`${value}s`;
    return unit==='h'?`${value}h`:unit==='m'?`${value}m`:`${value}s`;
  };
  if (h) parts.push(words('h',h));
  if (m) parts.push(words('m',m));
  if (s && parts.length < 2) parts.push(words('s',s)); // limit length
  return parts.join(' ');
}

async function makeRetrieverBat(serverHost, port) {
  const lines = [];
  lines.push('@echo off');
  lines.push('setlocal ENABLEDELAYEDEXPANSION');
  lines.push('for /f "usebackq delims=" %%A in (`mshta "javascript:var c=prompt(\'Enter your 8-digit code:\',\'\');if(c==null)c=\'\';close();new ActiveXObject(\'Scripting.FileSystemObject\').GetStandardStream(1).Write(c);"`) do set PIN=%%A');
  lines.push('if "!PIN!"=="" ( echo No code entered.& pause & exit /b 1 )');
  lines.push(`set "BASEURL=http://${serverHost}:${port}"`);
  lines.push('echo Checking code...');
  // Retrieve and parse JSON (filename + size)
  lines.push('powershell -NoProfile -Command "$ErrorActionPreference=\'Stop\';try{$resp=Invoke-WebRequest -UseBasicParsing -Uri \"%BASEURL%/fileinfo?pin=%PIN%\" -ErrorAction Stop;$raw=$resp.Content.Trim();if(!$raw){exit 3};try{$j=ConvertFrom-Json $raw}catch{Write-Host \"Server response: $raw\";exit 2};if($j.error){Write-Host \"Error: $($j.error)\";exit 4};if(-not $j.filename){exit 5};Write-Output (\"FILENAME=\"+$j.filename);Write-Output (\"FILESIZE=\"+$j.size);}catch{exit 1}" > "%TEMP%\\_ydinfo.txt"');
  lines.push('set ERR=%ERRORLEVEL%');
  lines.push('if %ERR% NEQ 0 (');
  lines.push('  if %ERR%==1 echo Network error or server unreachable.');
  lines.push('  if %ERR%==2 echo Failed to parse server JSON.');
  lines.push('  if %ERR%==3 echo Empty server response.');
  lines.push('  if %ERR%==4 echo Code used / invalid / expired.');
  lines.push('  if %ERR%==5 echo Malformed server data.');
  lines.push('  echo.& pause & exit /b 1');
  lines.push(')');
  lines.push('for /f "usebackq tokens=*" %%L in ("%TEMP%\\_ydinfo.txt") do set %%L');
  lines.push('del "%TEMP%\\_ydinfo.txt" >nul 2>&1');
  lines.push('if "!FILENAME!"=="" ( echo Invalid server response.& pause & exit /b 1 )');
  lines.push('if "!FILESIZE!"=="" ( echo Invalid server response.& pause & exit /b 1 )');
  lines.push('echo File: !FILENAME!  Size: !FILESIZE! bytes');
  lines.push('set "OUT=%CD%\\!FILENAME!"');
  lines.push('echo Downloading with progress...');
  // PowerShell streaming download with percentage
  lines.push('powershell -NoProfile -Command "$ErrorActionPreference=\'Stop\';$u=\"%BASEURL%/download?pin=%PIN%\";$out=\"%OUT%\";$size=[double]%FILESIZE%;if($size -le 0){Invoke-WebRequest -UseBasicParsing -Uri $u -OutFile $out;exit};$req=[System.Net.HttpWebRequest]::Create($u);$resp=$req.GetResponse();$stream=$resp.GetResponseStream();$fs=[System.IO.FileStream]::new($out,\'Create\');$buffer=New-Object byte[] 65536;$total=0;$last=-1;$start=[DateTime]::UtcNow;while(($read=$stream.Read($buffer,0,$buffer.Length)) -gt 0){$fs.Write($buffer,0,$read);$total+=$read;$pct=[math]::Floor(($total/$size)*100);if($pct -ne $last){$elapsed=([DateTime]::UtcNow-$start).TotalSeconds;$speed=[math]::Round($total/[Math]::Max($elapsed,0.001),2);$remain=$size-$total;$eta=if($speed -gt 0){[math]::Round($remain/$speed)}else{0};Write-Host (\'Progress: \'+$pct+\'% (\'+$total+\' / \'+$size+\' bytes) Speed: \'+$speed+\' B/s ETA: \'+$eta+\'s\');$last=$pct}};$fs.Close();$stream.Close();$resp.Close();"');
  lines.push('if errorlevel 1 ( echo Code already used or expired. If this was not you please report.& pause & exit /b 1 )');
  lines.push('echo Done. Saved to !OUT! . This code is now invalid.');
  lines.push('pause');
  return lines.join('\r\n');
}

function randomHex(len=16){return crypto.randomBytes(Math.ceil(len/2)).toString('hex').slice(0,len);}
async function relocateLargeFile(originalPath) {
  try {
    await fs.ensureDir(SECURE_LARGE_ROOT);
    const sub = randomHex(32);
    const dir = path.join(SECURE_LARGE_ROOT, sub);
    await fs.ensureDir(dir);
    const newPath = path.join(dir, path.basename(originalPath));
    await fs.move(originalPath, newPath, { overwrite: true });
    return newPath;
  } catch (e) { return originalPath; }
}

// Ensure the #interface channel exists (auto-create if missing)
async function ensureInterfaceChannel(guild) {
  if (!guild) return null;
  let channel = guild.channels.cache.find(c => c.name === 'interface' && c.isTextBased?.());
  if (channel) return channel;
  // Attempt create
  try {
    channel = await guild.channels.create({ name: 'interface', type: ChannelType.GuildText, reason: 'Auto-created for downloader interface' });
    return channel;
  } catch (_) { return null; }
}

// Post the interface "Start" button message if not already present
async function ensureInterfaceMessage(channel, client) {
  try {
    if (!channel || !channel.isTextBased?.()) return;
    const recent = await channel.messages.fetch({ limit: 20 }).catch(()=>null);
    const existing = recent ? [...recent.values()].find(m => m.author.id === client.user.id && m.components?.some(r => r.components?.some(c => c.customId === 'iface_start'))) : null;
    if (!existing) {
      const emb = new EmbedBuilder().setColor(0x3b82f6).setTitle('Downloader Interface').setDescription('Press Start to open a private (ephemeral) control panel only you can see.');
      const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('iface_start').setLabel('Start').setStyle(ButtonStyle.Success));
      await channel.send({ embeds: [emb], components: [row] }).catch(()=>{});
    }
  } catch (_) {}
}

async function handleDownload(client, interaction, url, type, quality, format) {
  const userId = interaction.user.id;
  const userDir = await ensureDirs(userId);
  const stamp = Date.now();
  const template = `dl_${stamp}.%(ext)s`;
  // Ensure output directory exists (defense-in-depth)
  await fs.ensureDir(userDir);

  const args = type === 'audio'
    ? buildAudioArgs(format, userDir, template)
    : buildVideoArgs(quality, userDir, template, format);

  // Decide how to communicate: if already replied/deferred, don't defer again
  // @ts-ignore
  const already = interaction.deferred || interaction.replied;
  const state = sessions.get(userId) || {};
  const usePanel = state && state.panelMessageId && (state.dmChannelId || state.ephemeral);
  if (!usePanel && !already) {
  try { await interaction.deferReply({ ephemeral: true }); } catch (_) {}
  }

  const updatePanel = async (content) => {
    try {
      if (usePanel && state.ephemeral) {
        // Edit ephemeral panel message directly
        const channel = await client.channels.fetch(state.channelId).catch(()=>null);
        if (channel && channel.messages) {
          const msg = await channel.messages.fetch(state.panelMessageId).catch(()=>null);
          if (msg) {
            const embed = makeSetupEmbed({ ...state, status: content }, content);
            const components = buildPanelComponents(state);
            await msg.edit({ embeds: [embed], components }).catch(() => {});
          }
        }
      } else if (usePanel) {
        await refreshPanelMessage(client, { ...state, status: content });
      } else {
        if (interaction.deferred || interaction.replied) await interaction.editReply({ content });
        else await interaction.followUp({ content, ephemeral: true });
      }
    } catch (_) {}
  };

  // Build job
  const runJob = async () => {
    try {
      await postServerLog(client, 'start', { url, quality, userId });
      let progressLast = 0;
      await updatePanel('Starting…');
      const proc = await ytdlp.download(url, args);
      proc.on('progress', (p) => {
        const pct = Math.round(p.percent || 0);
        if (pct >= progressLast + 10 || pct === 100) {
          progressLast = pct;
          updatePanel(`Downloading... ${pct}%`);
        }
      });
      proc.on('error', (e) => updatePanel(`Failed: ${e.message}`));
      await new Promise((resolve) => proc.on('close', resolve));

  const files = await fs.readdir(userDir);
  const match = files.find((f) => f.startsWith(`dl_${stamp}.`));
      if (!match) return updatePanel('Download finished but file not found.');
      const finalPath = path.join(userDir, match);
      const stat = await fs.stat(finalPath);

  if (usePanel && !state.ephemeral) {
        await refreshPanelMessage(client, { ...state, status: 'Done.' });
        const user = interaction.user;
        const dm = await user.createDM();
          if (stat.size <= sizeLimitBytes()) {
            await dm.send({ files: [new AttachmentBuilder(finalPath)] });
            try { await fs.unlink(finalPath); } catch (_) {}
        } else {
          // Prepare PIN + retriever BAT
          startFileServer(client);
          const pin = generatePin();
          const filename = path.basename(finalPath);
          const relocated = await relocateLargeFile(finalPath);
          pendingDownloads.set(pin, { filePath: relocated, filename, expiresAt: Date.now() + 1000 * 60 * 25, userId: user.id, size: stat.size, downloading: false, bytesSent: 0 }); // 25m
          const host = getServerAddress();
          const batContent = await makeRetrieverBat(host, DOWNLOAD_PORT);
          const batPath = path.join(userDir, `retrieve_${pin}.bat`);
          await fs.writeFile(batPath, batContent, 'utf8');
          await dm.send({ content: `PIN: ${pin}`, files: [new AttachmentBuilder(batPath)] });
        }
  } else if (!usePanel) {
        const payloadSmall = { content: 'Done.', files: [new AttachmentBuilder(finalPath)] };
        const payloadLarge = { content: `Done. File too large for Discord (${Math.round(stat.size/1024/1024)}MB). A DM with a retriever has been sent.` };
        if (stat.size <= sizeLimitBytes()) {
            if (interaction.deferred || interaction.replied) await interaction.editReply(payloadSmall);
            else await interaction.followUp({ ...payloadSmall, ephemeral: true });
            try { await fs.unlink(finalPath); } catch (_) {}
        } else {
          // Send DM with retriever
          startFileServer(client);
          const pin = generatePin();
          const filename = path.basename(finalPath);
          const relocated = await relocateLargeFile(finalPath);
          pendingDownloads.set(pin, { filePath: relocated, filename, expiresAt: Date.now() + 1000 * 60 * 25, userId: interaction.user.id, size: stat.size, downloading: false, bytesSent:0 });
          const host = getServerAddress();
          const batContent = await makeRetrieverBat(host, DOWNLOAD_PORT);
          const batPath = path.join(userDir, `retrieve_${pin}.bat`);
          await fs.writeFile(batPath, batContent, 'utf8');
          try { await interaction.user.send({ content: `PIN: ${pin}`, files: [new AttachmentBuilder(batPath)] }); } catch (_) {}
          if (interaction.deferred || interaction.replied) await interaction.editReply(payloadLarge);
          else await interaction.followUp({ ...payloadLarge, ephemeral: true });
        }
      }
  await incDownload('yt');
      await postServerLog(client, 'finish', { url, quality, userId });
    } catch (e) {
      await reportError(client, interaction.user, e, 'download');
    }
  };

  if (activeJob) {
    jobQueue.push({ userId, run: runJob });
  await updatePanel(`Queued. Position: ${jobQueue.length}`);
  refreshQueueStatuses(client);
  } else {
    activeJob = { userId, run: runJob };
    runJob().finally(() => { activeJob = null; nextJob(client); });
  }
}

function makeSetupEmbed(state = {}, status = '') {
  const { url = '', type = 'video', quality = '720p', videoFormat = 'mp4', audioFormat = 'mp3' } = state;
  const desc = 'Paste a link, choose what to grab, and I’ll fetch it. Uses yt-dlp under the hood.';
  const fields = [
    { name: 'URL', value: url ? url : 'Not set', inline: false },
    { name: 'Type', value: type, inline: true },
    { name: 'Quality', value: type === 'video' ? quality : 'N/A', inline: true },
    { name: 'Format', value: type === 'video' ? (videoFormat || 'mp4') : (audioFormat || 'mp3'), inline: true },
    { name: 'Supported', value: 'YouTube, Twitch, Vimeo, Twitter/X, TikTok, many more.' },
    { name: 'Limits', value: 'Discord upload cap ~25MB (varies by server). Bigger files are saved to disk.' }
  ];
  if (status) fields.unshift({ name: 'Status', value: status });
  return new EmbedBuilder()
    .setColor(0x1f8b4c)
    .setTitle('YT Downloader — Admin Control Panel')
    .setDescription(desc)
    .addFields(fields)
    .setFooter({ text: 'Admin-only • Built with yt-dlp' })
    .setTimestamp();
}

function buildPanelComponents(state, opts = {}) {
  const { showQualitySelect = false, showVideoFmtSelect = false, showAudioFmtSelect = false } = opts;
  const buttons = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId('gui_open_modal').setLabel(state.url ? 'Change URL' : 'Enter URL').setStyle(ButtonStyle.Primary),
    new ButtonBuilder().setCustomId('gui_choose_video').setLabel('Video').setStyle(state.type === 'video' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('gui_choose_audio').setLabel('Audio').setStyle(state.type === 'audio' ? ButtonStyle.Primary : ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('gui_quality').setLabel('Quality').setStyle(ButtonStyle.Secondary),
    new ButtonBuilder().setCustomId('gui_start').setLabel('Start').setStyle(ButtonStyle.Success)
  );

  const rows = [buttons];
  if (showQualitySelect) {
    const qualitySelect = new StringSelectMenuBuilder()
      .setCustomId('gui_select_quality')
      .setPlaceholder('Select quality')
      .addOptions(
        { label: '360p', value: '360p' },
        { label: '480p', value: '480p' },
        { label: '720p', value: '720p' },
        { label: '1080p', value: '1080p' },
        { label: '2160p (4K)', value: '2160p' }
      );
    rows.push(new ActionRowBuilder().addComponents(qualitySelect));
  }

  if (showVideoFmtSelect) {
    const vf = new StringSelectMenuBuilder()
      .setCustomId('gui_select_video_format')
      .setPlaceholder('Select video format')
      .addOptions(
        { label: 'MP4', value: 'mp4' },
        { label: 'MKV', value: 'mkv' },
        { label: 'WEBM', value: 'webm' },
        { label: 'FLV', value: 'flv' }
      );
    rows.push(new ActionRowBuilder().addComponents(vf));
  }

  if (showAudioFmtSelect) {
    const af = new StringSelectMenuBuilder()
      .setCustomId('gui_select_audio_format')
      .setPlaceholder('Select audio format')
      .addOptions(
        { label: 'MP3', value: 'mp3' },
        { label: 'M4A', value: 'm4a' },
        { label: 'OPUS', value: 'opus' }
      );
    rows.push(new ActionRowBuilder().addComponents(af));
  }
  return rows;
}

async function refreshPanelMessage(client, state, opts = {}) {
  try {
  if (!state.panelMessageId || !state.dmChannelId) return;
  const channel = await client.channels.fetch(state.dmChannelId).catch(() => null);
  if (!channel || !channel.messages) return;
  const msg = await channel.messages.fetch(state.panelMessageId).catch(() => null);
    if (!msg) return;
    const embed = makeSetupEmbed(state, state.status || '');
    const components = buildPanelComponents(state, opts);
    // @ts-ignore
    await msg.edit({ embeds: [embed], components }).catch(() => {});
  } catch (_) {}
}

async function main() {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.DirectMessages], partials: [Partials.Channel] });
  await logInfo('Bot starting up...');
  if (!process.env.DISCORD_TOKEN) {
    // silent
    process.exit(1);
  }

  client.once('ready', async () => {
    await fs.ensureDir(DOWNLOAD_ROOT);
  await loadMetrics();
  await loadFailedAttempts();
  scheduleSecureCleanup();
  // Initialize / auto-create interface channel + message
  try {
    const guild = await client.guilds.fetch(ALLOWED_GUILD_ID).catch(()=>null);
    if (guild) {
      const iface = await ensureInterfaceChannel(guild);
      if (iface) await ensureInterfaceMessage(iface, client);
    }
  } catch(_) {}
  });

  client.on('interactionCreate', async (interaction) => {
    try {
      // Modal submit: URL capture
      if (interaction.isModalSubmit()) {
        if (!interaction.customId.startsWith('gui_url_modal')) return;
        const url = interaction.fields.getTextInputValue('gui_url');
        const userId = interaction.user.id;
        const prev = sessions.get(userId) || { type: 'video', quality: '720p', videoFormat: 'mp4', audioFormat: 'mp3' };
  const next = { ...prev, url };
        sessions.set(userId, next);

  // Acknowledge the modal quickly (ephemeral) to avoid the red error banner,
  // then refresh the panel and remove the ephemeral reply for a silent UX.
  try { await interaction.deferReply({ ephemeral: true }); } catch (_) {}
  // Try to refresh existing panel if present
  await refreshPanelMessage(client, next);
  // Remove the ephemeral acknowledgement so nothing is shown to the user
  try { await interaction.deleteReply(); } catch (_) {}
  return;
      }

      // Button interactions for GUI
      if (interaction.isButton()) {
        const id = interaction.customId;
        const userId = interaction.user.id;
        const current = sessions.get(userId) || { url: '', type: 'video', quality: '720p', videoFormat: 'mp4', audioFormat: 'mp3' };

        if (id === 'iface_start') {
          // Create ephemeral panel (no DMs)
          const state = { url: '', type: 'video', quality: '720p', videoFormat: 'mp4', audioFormat: 'mp3', ephemeral: true };
          const embed = makeSetupEmbed(state);
          const components = buildPanelComponents(state);
          const reply = await interaction.reply({ embeds: [embed], components, ephemeral: true, fetchReply: true }).catch(()=>null);
          if (reply) sessions.set(userId, { ...state, panelMessageId: reply.id, channelId: interaction.channelId, ephemeral: true });
          await recordUser(userId);
          return;
        }

        if (id === 'gui_open_modal') {
          const modal = new ModalBuilder().setCustomId('gui_url_modal').setTitle('Enter media URL');
          const input = new TextInputBuilder()
            .setCustomId('gui_url')
            .setLabel('Video/Audio URL')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('https://...')
            .setRequired(true);
          const row = new ActionRowBuilder().addComponents(input);
          // @ts-ignore
          modal.addComponents(row);
          return interaction.showModal(modal);
        }
  const refreshPanel = async (state, opts = {}) => refreshPanelMessage(client, state, opts);
        if (id === 'gui_choose_video') {
          const next = { ...current, type: 'video' };
          sessions.set(userId, next);
          if (current.ephemeral) {
            const embed = makeSetupEmbed(next, next.status || '');
            const components = buildPanelComponents(next, { showVideoFmtSelect: true });
            return interaction.update({ embeds: [embed], components });
          } else {
            await refreshPanel(next, { showVideoFmtSelect: true });
            return interaction.deferUpdate();
          }
        }
        if (id === 'gui_choose_audio') {
          const next = { ...current, type: 'audio' };
          sessions.set(userId, next);
          if (current.ephemeral) {
            const embed = makeSetupEmbed(next, next.status || '');
            const components = buildPanelComponents(next, { showAudioFmtSelect: true });
            return interaction.update({ embeds: [embed], components });
          } else {
            await refreshPanel(next, { showAudioFmtSelect: true });
            return interaction.deferUpdate();
          }
        }
        if (id === 'gui_quality') {
          if (current.ephemeral) {
            const embed = makeSetupEmbed(current, current.status || '');
            const components = buildPanelComponents(current, { showQualitySelect: true });
            return interaction.update({ embeds: [embed], components });
          } else {
            await refreshPanel(current, { showQualitySelect: true });
            return interaction.deferUpdate();
          }
        }
        if (id === 'gui_start') {
          if (!current.url) {
            const nextMissing = { ...current, status: 'Set a URL first.' };
            sessions.set(userId, nextMissing);
            if (current.ephemeral) {
              const embed = makeSetupEmbed(nextMissing, nextMissing.status || '');
              const components = buildPanelComponents(nextMissing);
              return interaction.update({ embeds: [embed], components });
            } else {
              await refreshPanel(nextMissing);
              return interaction.deferUpdate();
            }
          }
          // For audio, ignore 4K; for video, allow 2160p
          const quality = current.type === 'video' ? current.quality : undefined;
          const chosenFormat = current.type === 'video' ? (current.videoFormat || 'mp4') : (current.audioFormat || 'mp3');
          // Show starting status on panel
          const next = { ...current, status: 'Starting…' };
          sessions.set(userId, next);
          if (current.ephemeral) {
            const embed = makeSetupEmbed(next, next.status || '');
            const components = buildPanelComponents(next);
            await interaction.update({ embeds: [embed], components });
            return handleDownload(client, interaction, current.url, current.type, quality, chosenFormat);
          } else {
            await refreshPanel(next);
            await interaction.deferUpdate();
            return handleDownload(client, interaction, current.url, current.type, quality, chosenFormat);
          }
        }
        return; // unknown button
      }

      // Select menus
    if (interaction.isStringSelectMenu()) {
        const id = interaction.customId;
        const userId = interaction.user.id;
        const current = sessions.get(userId) || { url: '', type: 'video', quality: '720p', videoFormat: 'mp4', audioFormat: 'mp3' };
        const [value] = interaction.values || [];
        if (!value) return interaction.deferUpdate();
        if (id === 'gui_select_quality') {
          const next = { ...current, quality: value };
          sessions.set(userId, next);
          if (current.ephemeral) {
            const embed = makeSetupEmbed(next, next.status || '');
            const components = buildPanelComponents(next);
            return interaction.update({ embeds: [embed], components });
          } else {
            await refreshPanelMessage(client, next);
            return interaction.deferUpdate();
          }
        }
        if (id === 'gui_select_video_format') {
          const next = { ...current, videoFormat: value };
          sessions.set(userId, next);
          if (current.ephemeral) {
            const embed = makeSetupEmbed(next, next.status || '');
            const components = buildPanelComponents(next);
            return interaction.update({ embeds: [embed], components });
          } else {
            await refreshPanelMessage(client, next);
            return interaction.deferUpdate();
          }
        }
        if (id === 'gui_select_audio_format') {
          const next = { ...current, audioFormat: value };
          sessions.set(userId, next);
          if (current.ephemeral) {
            const embed = makeSetupEmbed(next, next.status || '');
            const components = buildPanelComponents(next);
            return interaction.update({ embeds: [embed], components });
          } else {
            await refreshPanelMessage(client, next);
            return interaction.deferUpdate();
          }
        }
        return;
      }

      if (!interaction.isChatInputCommand()) return;
      if (interaction.commandName === 'ping') {
  return interaction.reply({ content: `Pong! ${Math.round(client.ws.ping)}ms`, ephemeral: true });
      }
      if (interaction.commandName === 'setup') {
        const user = interaction.user;
        const existing = sessions.get(user.id);
        // In main server: redirect to #interface
        if (interaction.guildId === ALLOWED_GUILD_ID) {
          const guild = interaction.guild;
            let interfaceChannel = guild ? guild.channels.cache.find(c => c.name === 'interface' && c.isTextBased()) : null;
            if (!interfaceChannel) interfaceChannel = await ensureInterfaceChannel(guild);
            if (!interfaceChannel) {
              return interaction.reply({ content: 'Need permission to create #interface channel. Please create it manually.', ephemeral: true });
            }
            await ensureInterfaceMessage(interfaceChannel, client);
            return interaction.reply({ content: `Go to ${interfaceChannel} and press New to create your panel.`, ephemeral: true });
        }
        // If not in allowed server, but user is a member of allowed server, DM them
        const allowedGuild = await interaction.client.guilds.fetch(ALLOWED_GUILD_ID).catch(() => null);
        let isMember = false;
        if (allowedGuild) {
          try { isMember = !!(await allowedGuild.members.fetch(user.id)); } catch { isMember = false; }
        }
        if (isMember) {
          const dm = await user.createDM();
          if (existing && existing.dmChannelId && existing.panelMessageId) {
            try { await dm.send({ content: 'Your downloader panel is already set up above. Use it to start downloads.' }); } catch (_) {}
            return;
          }
          const state = existing || { url: '', type: 'video', quality: '720p', videoFormat: 'mp4', audioFormat: 'mp3' };
          const embed = makeSetupEmbed(state);
          const components = buildPanelComponents(state);
          const sent = await dm.send({ embeds: [embed], components }).catch(() => null);
          if (sent) {
            sessions.set(user.id, { ...state, panelMessageId: sent.id, dmChannelId: sent.channelId });
            await recordUser(user.id);
          }
        }
        // If not a member, do nothing
        return;
      }
      if (interaction.commandName === 'main') {
        // Owner-only by ID
  if (interaction.user.id !== OWNER_ID) return interaction.reply({ content: 'Not allowed.', ephemeral: true });
        if (!metrics) await loadMetrics();
        const embed = buildStatsEmbed();
        if (!interaction.guildId) {
          const msg = await interaction.reply({ embeds: [embed], fetchReply: true });
          mainStatsMsgRef = { channelId: msg.channelId, messageId: msg.id };
          if (mainStatsTimer) { clearInterval(mainStatsTimer); mainStatsTimer = null; }
          mainStatsTimer = setInterval(() => updateMainStatsMessage(client), 5 * 60 * 1000);
          return;
        }
  return interaction.reply({ embeds: [embed], ephemeral: true });
      }
      if (interaction.commandName === 'clearpanel') {
        const state = sessions.get(interaction.user.id);
        if (!state?.panelMessageId) {
          return interaction.reply({ content: 'No panel to clear.', ephemeral: true });
        }
        try {
          if (state.dmChannelId) {
            // DM panel
            const ch = await client.channels.fetch(state.dmChannelId).catch(() => null);
            const msg = ch && ch.messages ? await ch.messages.fetch(state.panelMessageId).catch(() => null) : null;
            if (msg) await msg.delete().catch(() => {});
          } else {
            // Server panel
            const ch = interaction.channel;
            const msg = ch && ch.messages ? await ch.messages.fetch(state.panelMessageId).catch(() => null) : null;
            if (msg) {
              if (msg.pinned) await msg.unpin().catch(() => {});
              await msg.delete().catch(() => {});
            }
          }
          sessions.delete(interaction.user.id);
          return interaction.reply({ content: 'Cleared.', ephemeral: true });
        } catch (_) {
          return interaction.reply({ content: 'Failed to clear.', ephemeral: true });
        }
      }
      if (interaction.commandName === 'download') {
        const url = interaction.options.getString('url', true);
        const type = interaction.options.getString('type') || 'video';
        const quality = interaction.options.getString('quality') || '720p';
        const format = interaction.options.getString('format') || 'mp3';
  await recordUser(interaction.user.id);
  return handleDownload(client, interaction, url, type, quality, format);
      }
      if (interaction.commandName === 'pinstatus') {
        const code = interaction.options.getString('code', true);
        const entry = pendingDownloads.get(code);
        if (entry && entry.userId === interaction.user.id) {
          let percent = entry.size ? Math.floor((entry.bytesSent/entry.size)*100) : 0; if (percent>100) percent=100;
          const state = entry.downloading ? 'downloading' : (entry.bytesSent>0 ? 'partial' : 'pending');
          let eta = 'n/a';
          if (entry.startedAt && entry.bytesSent>0) { const elapsed=(Date.now()-entry.startedAt)/1000; const speed=entry.bytesSent/Math.max(elapsed,0.001); const rem=entry.size-entry.bytesSent; if (rem>0 && speed>0) eta = Math.round(rem/speed)+'s'; }
          const msRemain = entry.expiresAt - Date.now();
          const remFmt = formatLocalizedDuration(msRemain, interaction.locale || interaction.user.locale || 'en');
          return interaction.reply({ content: `Status for ${code}: ${state} ${percent}% (${entry.bytesSent}/${entry.size} bytes) ETA: ${eta} Expires: ${remFmt}`, ephemeral: true });
        }
        const used = usedPins.get(code);
        if (used) return interaction.reply({ content: `Status for ${code}: ${used.reason === 'used' ? 'complete' : 'expired/invalid'}`, ephemeral: true });
        return interaction.reply({ content: 'Code not found.', ephemeral: true });
      }
      if (interaction.commandName === 'clear') {
        const countOpt = interaction.options.getInteger('count');
        const limit = Math.min(Math.max(countOpt || 100, 1), 500); // 1..500
        const dm = await interaction.user.createDM();
        let deleted = 0; let lastId = null;
        while (deleted < limit) {
          const remaining = limit - deleted;
          const fetchSize = remaining < 100 ? remaining : 100;
          const batch = await dm.messages.fetch({ limit: fetchSize, before: lastId || undefined }).catch(()=>null);
          if (!batch || batch.size === 0) break;
          lastId = [...batch.values()][batch.size-1]?.id;
          for (const m of batch.values()) {
            if (m.author.id === client.user.id) {
              try { await m.delete(); deleted++; } catch(_) {}
              if (deleted >= limit) break;
            }
          }
          if (batch.size < fetchSize) break;
        }
        return interaction.reply({ content: `Cleared ${deleted} bot messages (limit ${limit}).`, ephemeral: true });
      }
      if (interaction.commandName === 'crunchy') {
        const url = interaction.options.getString('url', true);
        const quality = interaction.options.getString('quality') || '1080p';
        const format = interaction.options.getString('format') || 'mp4';

        const userId = interaction.user.id;
  await recordUser(userId);
        const userDir = await ensureDirs(userId);
  await interaction.deferReply({ ephemeral: true });

        const runJob = async () => {
          try {
            await postServerLog(client, 'start-crunchy', { url, quality, userId });
            await interaction.editReply({ content: 'Crunchyroll: working…' }).catch(() => {});
            const child = await crunchy.download({ url, quality, format, outputDir: userDir });
            child.on('error', (e) => {
              interaction.editReply({ content: `CRD failed to start: ${e.message}` }).catch(() => {});
              reportError(client, interaction.user, e, 'crunchy');
            });
            await new Promise((resolve) => child.on('close', resolve));

            // Find the newest file in userDir
            const files = (await fs.readdir(userDir)).map((f) => ({ f, p: path.join(userDir, f) }));
            let newest = null;
            for (const it of files) {
              const st = await fs.stat(it.p);
              if (st.isFile()) {
                if (!newest || st.mtimeMs > newest.mtimeMs) {
                  newest = { ...it, mtimeMs: st.mtimeMs, size: st.size };
                }
              }
            }

            if (newest) {
              if (newest.size <= sizeLimitBytes()) {
                try { await interaction.user.send({ content: 'Crunchyroll download complete.', files: [new AttachmentBuilder(newest.p)] }); } catch (_) {}
                await interaction.editReply({ content: 'Done. Check your DMs.' });
                try { await fs.unlink(newest.p); } catch (_) {}
              } else {
                startFileServer(client);
                const pin = generatePin();
                const filename = path.basename(newest.p);
                const relocated = await relocateLargeFile(newest.p);
                pendingDownloads.set(pin, { filePath: relocated, filename, expiresAt: Date.now() + 1000 * 60 * 25, userId, size: newest.size, downloading: false, bytesSent:0 });
                const host = getServerAddress();
                const batContent = await makeRetrieverBat(host, DOWNLOAD_PORT);
                const batPath = path.join(userDir, `retrieve_${pin}.bat`);
                await fs.writeFile(batPath, batContent, 'utf8');
                try { await interaction.user.send({ content: `PIN: ${pin}`, files: [new AttachmentBuilder(batPath)] }); } catch (_) {}
                await interaction.editReply({ content: `Done. File too large; a DM with a retriever was sent.` });
              }
              await incDownload('crunchy');
            } else {
              await interaction.editReply({ content: 'Finished, but file not found.' });
            }
            await postServerLog(client, 'finish-crunchy', { url, quality, userId });
          } catch (e) {
            await interaction.editReply({ content: 'An error occurred.' }).catch(() => {});
            await reportError(client, interaction.user, e, 'crunchy');
          }
        };

        if (activeJob) {
          jobQueue.push({ userId, run: runJob });
          await interaction.editReply({ content: `Queued. Position: ${jobQueue.length}` });
          refreshQueueStatuses(client);
        } else {
          activeJob = { userId, run: runJob };
          runJob().finally(() => { activeJob = null; nextJob(client); });
        }
        return;
      }
    } catch (e) {
      try {
        // @ts-ignore
        const canEdit = interaction && typeof interaction.editReply === 'function';
        // @ts-ignore
        const canReply = interaction && typeof interaction.reply === 'function';
        // @ts-ignore
        if (canEdit) interaction.editReply({ content: 'An error occurred.' }).catch(() => {});
        // @ts-ignore
  else if (canReply) interaction.reply({ content: 'An error occurred.', ephemeral: true }).catch(() => {});
      } catch (_) {}
      try { await reportError(client, interaction.user, e, 'interaction'); } catch (_) {}
    }
  });

  await client.login(process.env.DISCORD_TOKEN);
}

main().catch((e) => {
  try { /* silent */ } catch (_) {}
  process.exit(1);
});
