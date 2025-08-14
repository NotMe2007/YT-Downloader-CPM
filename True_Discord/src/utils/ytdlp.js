const { default: YTDlpWrap } = require('yt-dlp-wrap-plus');
const fs = require('fs-extra');
const os = require('os');
const path = require('path');

class YTDLPHelper {
  constructor() {
    this.ytdlp = null;
    this.ytdlpPath = null;
    this.setupPromise = this.setup();
  }

  async setup() {
    try {
      const { execSync } = require('child_process');
      let found;
      try {
        found = execSync(process.platform === 'win32' ? 'where yt-dlp' : 'which yt-dlp', { encoding: 'utf8' })
          .trim()
          .split(/\r?\n/)[0];
      } catch (_) {}

      if (found) {
        this.ytdlpPath = found;
      } else {
        const dir = path.join(os.homedir(), '.ytdownloader-bot');
        await fs.ensureDir(dir);
        const bin = path.join(dir, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
        if (!(await fs.pathExists(bin))) {
          await YTDlpWrap.downloadFromGithub(bin);
        }
        this.ytdlpPath = bin;
      }
      this.ytdlp = new YTDlpWrap(this.ytdlpPath);
    } catch (e) {
      console.error('yt-dlp setup failed:', e);
      throw e;
    }
  }

  async getInfo(url) {
    await this.setupPromise;
    return this.ytdlp.getVideoInfo(url);
  }

  async download(url, args = []) {
    await this.setupPromise;
    return this.ytdlp.exec([url, ...args]);
  }
}

module.exports = new YTDLPHelper();
