const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn } = require('child_process');
const ftp = require('basic-ftp');

const FTP_HOST     = process.env.FTP_HOST     || '10.100.1.22';
const FTP_PORT     = parseInt(process.env.FTP_PORT || '2121', 10);
const FTP_USER     = process.env.FTP_USER     || 'admin';
const FTP_PASS     = process.env.FTP_PASS     || '';
const FTP_DIR      = process.env.FTP_DIR      || '/';
const ROUTER_AET   = process.env.ROUTER_AET   || 'DCMROUTER';
const ROUTER_HOST  = process.env.ROUTER_HOST  || 'dicom-router';
const ROUTER_PORT  = process.env.ROUTER_PORT  || '11112';
const MAX_RETRIES  = parseInt(process.env.MAX_RETRIES  || '3',     10);
const SCAN_INTERVAL = parseInt(process.env.SCAN_INTERVAL || '30000', 10);
const STATE_DIR    = '/state';
const LOG_FILE     = path.join(STATE_DIR, 'forwarder.log');

if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

// ---------- LOGGING ----------
function log(...args) {
  const msg = `${new Date().toISOString()} ${args.join(' ')}\n`;
  process.stdout.write(msg);
  fs.appendFileSync(LOG_FILE, msg);
}

// ---------- MARKER SYSTEM ----------
function markerPath(ftpPath) {
  const hash = crypto.createHash('md5').update(ftpPath).digest('hex');
  return path.join(STATE_DIR, `${hash}.sent`);
}

function alreadySent(ftpPath) {
  return fs.existsSync(markerPath(ftpPath));
}

function markSent(ftpPath) {
  try {
    fs.writeFileSync(markerPath(ftpPath), `${new Date().toISOString()} ${ftpPath}\n`);
  } catch (err) {
    log('Marker error:', err.message);
  }
}

// ---------- SEND FUNCTION ----------
function sendDicom(localFile) {
  return new Promise((resolve, reject) => {
    const args = ['-v', '-aec', ROUTER_AET, ROUTER_HOST, ROUTER_PORT, localFile];
    log('➡️  Running storescu', args.join(' '));
    const proc = spawn('storescu', args);
    let stderr = '';
    proc.stdout.on('data', d => log('[storescu]', d.toString().trim()));
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`storescu exit ${code}: ${stderr}`));
    });
  });
}

// ---------- FTP LIST RECURSIVE ----------
async function listFtpRecursive(client, dir, results = []) {
  let items;
  try {
    items = await client.list(dir);
  } catch (err) {
    log('FTP list error at', dir, ':', err.message);
    return results;
  }
  for (const item of items) {
    const fullPath = (dir === '/' ? '' : dir) + '/' + item.name;
    if (item.type === 2) {
      await listFtpRecursive(client, fullPath, results);
    } else if (item.type === 1 && item.size >= 128) {
      results.push(fullPath);
    }
  }
  return results;
}

// ---------- DATE PATHS ----------
// Scan hari ini, kemarin, 2 hari lalu
function getRecentDatePaths(baseDir) {
  const paths = [];
  const now = new Date();
  for (let d = 0; d <= 2; d++) {
    const dt = new Date(now);
    dt.setDate(dt.getDate() - d);
    const y = dt.getFullYear();
    const m = dt.getMonth() + 1;
    const day = dt.getDate();
    paths.push(`${baseDir}/${y}/${m}/${day}`);
  }
  return paths;
}

// Flag: apakah ini pertama kali start
const INITIAL_SCAN_MARKER = path.join(STATE_DIR, '.initial_scan_done');

// ---------- PROCESS ONE FILE ----------
async function processFile(client, ftpPath) {
  if (alreadySent(ftpPath)) {
    log('⏩ SKIP already sent', ftpPath);
    return;
  }

  const tmpFile = path.join(os.tmpdir(), `dcm_${crypto.randomBytes(6).toString('hex')}`);
  try {
    await client.downloadTo(tmpFile, ftpPath);
    log('⬇️  Downloaded', ftpPath);
  } catch (err) {
    log('FTP download error:', ftpPath, ':', err.message);
    if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    return;
  }

  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    attempt++;
    try {
      log(`Attempt ${attempt}/${MAX_RETRIES} →`, ftpPath);
      await sendDicom(tmpFile);
      markSent(ftpPath);
      log('✅ SENT OK', ftpPath);
      break;
    } catch (err) {
      log('Send error:', err.message);
      if (attempt < MAX_RETRIES) {
        const delay = attempt * 2000;
        log(`Retrying in ${delay} ms...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        log('❌ All retries failed for', ftpPath);
      }
    }
  }

  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
}

// ---------- MAIN SCAN ----------
async function runScanPaths(scanPaths, label) {
  const client = new ftp.Client(30000);
  client.ftp.verbose = false;
  let totalFiles = 0;
  try {
    await client.access({
      host: FTP_HOST,
      port: FTP_PORT,
      user: FTP_USER,
      password: FTP_PASS,
      secure: false
    });
    for (const scanPath of scanPaths) {
      log(`📂 Scanning: ${scanPath}`);
      const files = await listFtpRecursive(client, scanPath);
      log(`   Found ${files.length} file(s) in ${scanPath}`);
      totalFiles += files.length;
      for (const ftpPath of files) {
        await processFile(client, ftpPath);
      }
    }
  } catch (err) {
    log(`❌ FTP error [${label}]:`, err.message);
  } finally {
    client.close();
  }
  return totalFiles;
}

async function scan(fullScan = false) {
  if (fullScan) {
    log(`🔍 INITIAL FULL SCAN — ${FTP_HOST}:${FTP_PORT}${FTP_DIR} (semua data, per-bulan)`);
    // List tahun dulu, lalu scan per bulan agar ada progress & tidak timeout
    const yearClient = new ftp.Client(30000);
    yearClient.ftp.verbose = false;
    let months = [];
    try {
      await yearClient.access({ host: FTP_HOST, port: FTP_PORT, user: FTP_USER, password: FTP_PASS, secure: false });
      const years = await yearClient.list(FTP_DIR);
      for (const yr of years.filter(i => i.type === 2)) {
        const yrPath = `${FTP_DIR}/${yr.name}`;
        const mList = await yearClient.list(yrPath);
        for (const mo of mList.filter(i => i.type === 2)) {
          months.push(`${yrPath}/${mo.name}`);
        }
      }
    } catch (err) {
      log('❌ Error listing years/months:', err.message);
    } finally {
      yearClient.close();
    }

    log(`📅 Found ${months.length} month(s) to scan`);
    let grandTotal = 0;
    for (const monthPath of months) {
      const n = await runScanPaths([monthPath], monthPath);
      grandTotal += n;
    }
    log(`✅ INITIAL FULL SCAN completed. Grand total files: ${grandTotal}`);
    fs.writeFileSync(INITIAL_SCAN_MARKER, new Date().toISOString());
    log('📌 Initial full scan marked as done.');
  } else {
    const datePaths = getRecentDatePaths(FTP_DIR);
    log(`🔍 Periodic scan — ${datePaths.join(', ')}`);
    const total = await runScanPaths(datePaths, 'periodic');
    log(`✅ Periodic scan completed. Files: ${total}`);
  }
}

// ---------- START ----------
log(`🚀 DICOM FTP Forwarder starting — ${FTP_HOST}:${FTP_PORT}${FTP_DIR} → ${ROUTER_AET}@${ROUTER_HOST}:${ROUTER_PORT}`);
log(`🔁 Periodic scan interval: ${SCAN_INTERVAL / 1000}s`);

let scanning = false;

async function safeScan(fullScan = false) {
  if (scanning) { log('⏳ Scan still running, skipping.'); return; }
  scanning = true;
  try { await scan(fullScan); } finally { scanning = false; }
}

// Pertama kali start: cek apakah initial scan pernah dilakukan
const isFirstRun = !fs.existsSync(INITIAL_SCAN_MARKER);
if (isFirstRun) {
  log('🆕 First run detected — starting FULL scan of all data...');
  safeScan(true).then(() => {
    // Setelah full scan selesai, mulai periodic scan
    setInterval(() => safeScan(false), SCAN_INTERVAL);
  });
} else {
  log('🔄 Resuming — skipping full scan, starting periodic scan...');
  safeScan(false);
  setInterval(() => safeScan(false), SCAN_INTERVAL);
}