const path = require('path');
const fs = require('fs-extra');
const { spawn } = require('child_process');

// Paths inside the repo to the CRD binary and its working directory
const ROOT = path.join(__dirname, '..', '..');
const CRD_ROOT = path.join(ROOT, '..', 'Crunchy-Downloader-master');
const CRD_SUBDIR = path.join(CRD_ROOT, 'CRD');
const CRD_EXE = path.join(CRD_ROOT, 'CRD.exe');

async function ensureExists() {
  const exists = await fs.pathExists(CRD_EXE);
  if (!exists) {
    throw new Error('CRD.exe not found. Expected at: ' + CRD_EXE);
  }
}

async function ensureCredentials() {
  const rootCreds = path.join(CRD_ROOT, 'credentials.json');
  const subCreds = path.join(CRD_SUBDIR, 'credentials.json');
  if (!(await fs.pathExists(rootCreds)) && (await fs.pathExists(subCreds))) {
    await fs.copy(subCreds, rootCreds);
  }
}

function spawnCRD(args, options = {}) {
  // Run from CRD_ROOT so relative files (credentials.json) resolve
  const cwd = CRD_ROOT;
  const child = spawn(CRD_EXE, args, {
    cwd,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  return child;
}

async function download({ url, quality = '1080p', format = 'mp4', outputDir }) {
  await ensureExists();

  const args = [
    'download',
    '--url', url,
    '--quality', quality,
    '--format', format,
  ];

  if (outputDir) {
    await fs.ensureDir(outputDir);
    args.push('--output', outputDir);
  }

  await ensureCredentials();
  const child = spawnCRD(args);
  return child; // caller can listen to stdout/stderr/close
}

async function info({ url }) {
  await ensureExists();
  const args = ['info', '--url', url];
  await ensureCredentials();
  return spawnCRD(args);
}

module.exports = {
  download,
  info,
  CRD_EXE,
  CRD_ROOT,
};
