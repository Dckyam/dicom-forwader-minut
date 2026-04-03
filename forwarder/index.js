const fs   = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const os   = require('os');
const { spawn } = require('child_process');
const ftp  = require('basic-ftp');
const mysql = require('mysql2/promise');

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────
const FTP_HOST    = process.env.FTP_HOST    || '10.100.1.22';
const FTP_PORT    = parseInt(process.env.FTP_PORT    || '2121', 10);
const FTP_USER    = process.env.FTP_USER    || 'admin';
const FTP_PASS    = process.env.FTP_PASS    || '';
const FTP_DIR     = process.env.FTP_DIR     || '/';
const ROUTER_AET  = process.env.ROUTER_AET  || 'DCMROUTER';
const ROUTER_HOST = process.env.ROUTER_HOST || 'dicom-router';
const ROUTER_PORT = process.env.ROUTER_PORT || '11112';
const MAX_RETRIES = parseInt(process.env.MAX_RETRIES || '3', 10);
const UI_PORT     = parseInt(process.env.UI_PORT     || '3000', 10);
const STATE_DIR   = '/state';
const LOG_FILE    = path.join(STATE_DIR, 'forwarder.log');
const RESPONSE_LOG = path.join(STATE_DIR, 'responses.json');
const ROUTER_CONTAINER_NAME = process.env.ROUTER_CONTAINER_NAME || 'dicom-router';
const DB_HOST = process.env.DB_HOST || FTP_HOST;
const DB_PORT = 3306;
const DB_USER = 'pacs';
const DB_PASS = 'pacs';
const DB_NAME = 'pacsdb';

if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });

// ─────────────────────────────────────────────
//  LOGGING
// ─────────────────────────────────────────────
function log(...args) {
  const msg = `${new Date().toISOString()} ${args.join(' ')}\n`;
  process.stdout.write(msg);
  fs.appendFileSync(LOG_FILE, msg);
}

// ─────────────────────────────────────────────
//  RESPONSE LOG  (JSON array, append-only)
// ─────────────────────────────────────────────
function logResponse(ftpPath, status, detail) {
  const entry = { ts: new Date().toISOString(), path: ftpPath, status, detail };
  let arr = [];
  try { arr = JSON.parse(fs.readFileSync(RESPONSE_LOG, 'utf8')); } catch (_) {}
  arr.push(entry);
  if (arr.length > 2000) arr = arr.slice(arr.length - 2000);
  fs.writeFileSync(RESPONSE_LOG, JSON.stringify(arr, null, 2));
}

// ─────────────────────────────────────────────
//  MARKER SYSTEM
// ─────────────────────────────────────────────
function markerPath(ftpPath) {
  const hash = crypto.createHash('md5').update(ftpPath).digest('hex');
  return path.join(STATE_DIR, `${hash}.sent`);
}
function alreadySent(ftpPath) { return fs.existsSync(markerPath(ftpPath)); }
function markSent(ftpPath) {
  fs.writeFileSync(markerPath(ftpPath), `${new Date().toISOString()} ${ftpPath}\n`);
}

// ─────────────────────────────────────────────
//  SEND DICOM
// ─────────────────────────────────────────────
function sendDicom(localFile) {
  return new Promise((resolve, reject) => {
    const args = ['-v', '-aec', ROUTER_AET, ROUTER_HOST, ROUTER_PORT, localFile];
    const proc = spawn('storescu', args);
    let stderr = '';
    proc.stdout.on('data', d => log('[storescu]', d.toString().trim()));
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`storescu exit ${code}: ${stderr}`));
    });
  });
}

// ─────────────────────────────────────────────
//  FTP HELPERS
// ─────────────────────────────────────────────
async function listFtpRecursive(client, dir, results = []) {
  let items;
  try { items = await client.list(dir); }
  catch (err) { log('FTP list error at', dir, ':', err.message); return results; }
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

async function ftpConnect() {
  const client = new ftp.Client(30000);
  client.ftp.verbose = false;
  await client.access({
    host: FTP_HOST, port: FTP_PORT,
    user: FTP_USER, password: FTP_PASS,
    secure: false
  });
  return client;
}

// ─────────────────────────────────────────────
//  PROCESS ONE FILE  (opens its own FTP connection per file)
// ─────────────────────────────────────────────
async function processFile(ftpPath) {
  if (alreadySent(ftpPath)) { log('⏩ SKIP already sent', ftpPath); return; }

  const tmpFile = path.join(os.tmpdir(), `dcm_${crypto.randomBytes(6).toString('hex')}`);
  let downloaded = false;
  for (let dlAttempt = 1; dlAttempt <= 3; dlAttempt++) {
    let dlClient;
    try {
      dlClient = await ftpConnect();
      await dlClient.downloadTo(tmpFile, ftpPath);
      dlClient.close();
      log('⬇️  Downloaded', ftpPath);
      downloaded = true;
      break;
    } catch (err) {
      try { if (dlClient) dlClient.close(); } catch (_) {}
      log(`FTP download error (${dlAttempt}/3):`, ftpPath, ':', err.message);
      if (fs.existsSync(tmpFile)) { try { fs.unlinkSync(tmpFile); } catch (_) {} }
      if (dlAttempt < 3) {
        await new Promise(r => setTimeout(r, dlAttempt * 3000));
      } else {
        logResponse(ftpPath, 'FAIL', 'Download error: ' + err.message);
        return;
      }
    }
  }
  if (!downloaded) return;

  let attempt = 0;
  while (attempt < MAX_RETRIES) {
    attempt++;
    try {
      log(`Attempt ${attempt}/${MAX_RETRIES} =>`, ftpPath);
      const detail = await sendDicom(tmpFile);
      markSent(ftpPath);
      log('✅ SENT OK', ftpPath);
      logResponse(ftpPath, 'OK', detail ? detail.substring(0, 300) : 'sent');
      break;
    } catch (err) {
      log('Send error:', err.message);
      if (attempt < MAX_RETRIES) {
        const delay = attempt * 2000;
        log(`Retrying in ${delay} ms...`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        log('❌ All retries failed for', ftpPath);
        logResponse(ftpPath, 'FAIL', err.message.substring(0, 300));
      }
    }
  }

  if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
}

// ─────────────────────────────────────────────
//  SCAN HELPERS
// ─────────────────────────────────────────────
function todayPath() {
  const now = new Date();
  return `/${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}`;
}

function yesterdayPath() {
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return `/${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

function todayHourPath(hour) {
  const now = new Date();
  return `/${now.getFullYear()}/${now.getMonth() + 1}/${now.getDate()}/${hour}`;
}

function datePath(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return `/${y}/${m}/${d}`;
}

let scanning = false;
let lastScanTime = null;
let nextScheduledScans = [];

async function runScan(scanPaths, label) {
  if (scanning) { log('⏳ Scan still running, skipping.'); return; }
  scanning = true;
  lastScanTime = new Date();
  log(`🔍 Scan [${label}] — paths: ${scanPaths.join(', ')}`);
  try {
    let allFiles = [];
    for (const p of scanPaths) {
      let listClient;
      try {
        listClient = await ftpConnect();
        const files = await listFtpRecursive(listClient, p);
        log(`   ${p} => ${files.length} file(s)`);
        allFiles = allFiles.concat(files);
      } catch (err) {
        log(`❌ FTP list error [${p}]:`, err.message);
      } finally {
        try { if (listClient) listClient.close(); } catch (_) {}
      }
    }
    for (const f of allFiles) {
      await processFile(f);
    }
    log(`✅ Scan [${label}] completed.`);
  } catch (err) {
    log(`❌ Scan [${label}] error:`, err.message);
  } finally {
    scanning = false;
  }
}

// ─────────────────────────────────────────────
//  SCHEDULER  — setiap hari jam 03:00 WITA (kirim H-1 = 02:00-01:59)
// ─────────────────────────────────────────────
const SCHEDULE_HOUR = parseInt(process.env.SCHEDULE_HOUR || '3', 10);

function getNextScheduledTime() {
  const now = new Date();
  const t = new Date(now);
  t.setHours(SCHEDULE_HOUR, 0, 0, 0);
  if (t <= now) t.setDate(t.getDate() + 1);
  return t;
}

function scheduleNext() {
  const time = getNextScheduledTime();
  nextScheduledScans = [{ hour: SCHEDULE_HOUR, time }];
  const delay = time - Date.now();
  log(`⏰ Next scan: ${time.toLocaleString('id-ID')} (jam ${String(SCHEDULE_HOUR).padStart(2,'0')}:00 WIB — H-1)`);
  setTimeout(async () => {
    // Kirim H-1: kemarin full (00:00-23:59) + hari ini jam 00 & 01 (00:00-01:59)
    await runScan([yesterdayPath(), todayHourPath(0), todayHourPath(1)], `scheduled-${String(SCHEDULE_HOUR).padStart(2,'0')}:00-H-1`);
    scheduleNext();
  }, delay);
}

// ─────────────────────────────────────────────
//  STATE READER
// ─────────────────────────────────────────────
function readStateFiles() {
  const files = fs.readdirSync(STATE_DIR).filter(f => f.endsWith('.sent'));
  return files.map(f => {
    const content = fs.readFileSync(path.join(STATE_DIR, f), 'utf8').trim();
    const parts = content.split(' ');
    return { hash: f.replace('.sent', ''), ts: parts[0] || '', path: parts.slice(1).join(' ') || '' };
  }).sort((a, b) => b.ts.localeCompare(a.ts));
}

function readResponseLog() {
  try { return JSON.parse(fs.readFileSync(RESPONSE_LOG, 'utf8')); } catch (_) { return []; }
}

function tailLog(lines) {
  lines = lines || 200;
  try {
    const all = fs.readFileSync(LOG_FILE, 'utf8').split('\n');
    return all.slice(Math.max(0, all.length - lines)).join('\n');
  } catch (_) { return ''; }
}

// ─────────────────────────────────────────────
//  ROUTER LOG PARSER (SatuSehat stats)
// ─────────────────────────────────────────────
const ROUTER_LOGS_DIR = '/router-logs';

function getDockerLogs(lines) {
  return new Promise((resolve) => {
    const req = http.request({
      socketPath: '/var/run/docker.sock',
      path: `/v1.41/containers/${ROUTER_CONTAINER_NAME}/logs?tail=${lines}&stdout=1&stderr=1&timestamps=0`,
      method: 'GET'
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const data = Buffer.concat(chunks);
        let result = '';
        let i = 0;
        while (i + 8 <= data.length) {
          const size = data.readUInt32BE(i + 4);
          if (i + 8 + size > data.length) break;
          result += data.slice(i + 8, i + 8 + size).toString('utf8');
          i += 8 + size;
        }
        resolve(result);
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

const ROUTER_STATS_PERSIST_FILE = path.join(STATE_DIR, 'router-stats.json');

function loadPersistedStats() {
  try { return JSON.parse(fs.readFileSync(ROUTER_STATS_PERSIST_FILE, 'utf8')); }
  catch (_) { return { startedAt: null, epochOK: 0, epochFail: 0, totalOK: 0, totalFail: 0 }; }
}

function savePersistedStats(data) {
  try { fs.writeFileSync(ROUTER_STATS_PERSIST_FILE, JSON.stringify(data)); } catch (_) {}
}

function getContainerStartTime() {
  return new Promise((resolve) => {
    const req = http.request({
      socketPath: '/var/run/docker.sock',
      path: `/v1.41/containers/${ROUTER_CONTAINER_NAME}/json`,
      method: 'GET'
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        try { resolve(JSON.parse(Buffer.concat(chunks).toString()).State?.StartedAt || null); }
        catch (_) { resolve(null); }
      });
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

let routerStatsCache = { satusehatOK: 0, satusehatFail: 0, available: false };
let routerStatsCacheTime = 0;

async function getRouterStats() {
  if (Date.now() - routerStatsCacheTime < 30000) return routerStatsCache;
  const [content, startedAt] = await Promise.all([getDockerLogs('all'), getContainerStartTime()]);
  if (!content) return routerStatsCache;
  let epochOK = 0, epochFail = 0;
  for (const line of content.split('\n')) {
    if (line.includes('ImagingStudy POST-ed')) epochOK++;
    if (line.includes('Failed to obtain Patient ID and ServiceRequest ID') || line.includes('Could not process association')) epochFail++;
  }
  const persisted = loadPersistedStats();
  if (startedAt && startedAt !== persisted.startedAt) {
    persisted.totalOK = (persisted.totalOK || 0) + (persisted.epochOK || 0);
    persisted.totalFail = (persisted.totalFail || 0) + (persisted.epochFail || 0);
    persisted.startedAt = startedAt;
  }
  persisted.epochOK = epochOK;
  persisted.epochFail = epochFail;
  savePersistedStats(persisted);
  routerStatsCache = { satusehatOK: (persisted.totalOK || 0) + epochOK, satusehatFail: (persisted.totalFail || 0) + epochFail, available: true };
  routerStatsCacheTime = Date.now();
  return routerStatsCache;
}

function parseRouterStats() {
  let satusehatOK = 0, satusehatFail = 0;
  try {
    if (!fs.existsSync(ROUTER_LOGS_DIR)) return { satusehatOK, satusehatFail, available: false };
    const files = fs.readdirSync(ROUTER_LOGS_DIR).filter(f => !fs.statSync(path.join(ROUTER_LOGS_DIR, f)).isDirectory());
    for (const f of files) {
      try {
        const content = fs.readFileSync(path.join(ROUTER_LOGS_DIR, f), 'utf8');
        for (const line of content.split('\n')) {
          if (line.includes('ImagingStudy POST-ed')) satusehatOK++;
          if (line.includes('Failed to obtain Patient ID and ServiceRequest ID') || line.includes('Could not process association')) satusehatFail++;
        }
      } catch (_) {}
    }
    return { satusehatOK, satusehatFail, available: true };
  } catch (_) {
    return { satusehatOK, satusehatFail, available: false };
  }
}

async function getAccessionSummary() {
  const content = await getDockerLogs('all');
  if (!content) return { failed: [], succeeded: [] };
  const lines = content.split('\n');
  const failedMap = new Map();
  const succeededMap = new Map();

  function lookback(idx) {
    let acc = null, iuid = null;
    for (let j = idx - 1; j >= Math.max(0, idx - 20); j--) {
      if (!acc) {
        const aM = lines[j].match(/Accession Number:\s*(\S+)/);
        if (aM) { acc = aM[1].replace(/\r$/, ''); }
      }
      if (!iuid) {
        const uM = lines[j].match(/Study IUID:\s*(\S+)/);
        if (uM) { iuid = uM[1].replace(/\r$/, ''); }
      }
      if (acc && iuid) break;
    }
    return { acc, iuid };
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes('Failed to obtain Patient ID and ServiceRequest ID')) {
      const { acc, iuid } = lookback(i);
      if (acc) {
        const prev = failedMap.get(acc) || { accession: acc, iuid: iuid, count: 0 };
        failedMap.set(acc, { ...prev, count: prev.count + 1, iuid: iuid || prev.iuid });
      }
      continue;
    }
    if (line.includes('ImagingStudy POST-ed')) {
      const idM = line.match(/ImagingStudy POST-ed[^a-z]*id[:\s=]+([\S]+)/i);
      const { acc, iuid } = lookback(i);
      if (acc) {
        succeededMap.set(acc, { accession: acc, iuid: iuid, imagingStudyId: idM ? idM[1].replace(/[,\r]$/, '') : '—' });
      }
      continue;
    }
  }
  return { failed: [...failedMap.values()], succeeded: [...succeededMap.values()] };
}

// ─────────────────────────────────────────────
//  HTTP / REST API
// ─────────────────────────────────────────────
const PUBLIC_DIR = path.join(__dirname, 'public');

function serveStaticFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

function jsonResponse(res, statusCode, body) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

function readBody(req) {
  return new Promise(resolve => {
    let body = '';
    req.on('data', c => { body += c; });
    req.on('end', () => resolve(body));
  });
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;

  if (req.method === 'GET' && pathname === '/') {
    serveStaticFile(res, path.join(PUBLIC_DIR, 'index.html'), 'text/html; charset=utf-8');
    return;
  }

  if (req.method === 'GET' && pathname === '/api/status') {
    const sent = readStateFiles();
    jsonResponse(res, 200, {
      scanning,
      lastScanTime: lastScanTime ? lastScanTime.toISOString() : null,
      scheduledScans: nextScheduledScans.map(s => s.time.toISOString()),
      totalSentToRouter: sent.length,
      routerStats: await getRouterStats()
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/state') {
    jsonResponse(res, 200, readStateFiles());
    return;
  }

  if (req.method === 'GET' && pathname === '/api/responses') {
    const limit = parseInt(url.searchParams.get('limit') || '200', 10);
    const all = readResponseLog();
    jsonResponse(res, 200, all.slice(-limit).reverse());
    return;
  }

  if (req.method === 'GET' && pathname === '/api/logs') {
    const lines = parseInt(url.searchParams.get('lines') || '200', 10);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end(tailLog(lines));
    return;
  }

  if (req.method === 'GET' && pathname === '/api/files') {
    const dateStr = url.searchParams.get('date');
    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
      jsonResponse(res, 400, { error: 'Parameter date=YYYY-MM-DD wajib diisi' });
      return;
    }
    const scanPath = datePath(dateStr);
    try {
      const client = await ftpConnect();
      const files = await listFtpRecursive(client, scanPath);
      client.close();
      jsonResponse(res, 200, {
        date: dateStr, scanPath, total: files.length,
        files: files.map(f => ({ path: f, sent: alreadySent(f) }))
      });
    } catch (err) {
      jsonResponse(res, 500, { error: err.message });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/send') {
    if (scanning) {
      jsonResponse(res, 409, { error: 'Scan sedang berjalan, coba lagi sebentar.' });
      return;
    }
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (_) { jsonResponse(res, 400, { error: 'Body JSON tidak valid' }); return; }

    const { paths, date } = body;
    if (!date && (!Array.isArray(paths) || paths.length === 0)) {
      jsonResponse(res, 400, { error: 'Harus ada date atau paths' }); return;
    }

    jsonResponse(res, 202, { message: 'Pengiriman dimulai. Pantau di tab Responses.' });

    (async () => {
      scanning = true;
      lastScanTime = new Date();
      log(`📤 Manual send dari UI — date=${date}`);
      try {
        let targets = Array.isArray(paths) && paths.length > 0 ? paths : null;
        if (!targets) {
          const sp = datePath(date);
          let listClient;
          try {
            listClient = await ftpConnect();
            targets = await listFtpRecursive(listClient, sp);
            log(`   Listed ${targets.length} file(s) from ${sp}`);
          } finally {
            try { if (listClient) listClient.close(); } catch (_) {}
          }
        }
        for (const f of targets) await processFile(f);
        log('✅ Manual send completed.');
      } catch (err) {
        log('❌ Manual send error:', err.message);
      } finally {
        scanning = false;
      }
    })();
    return;
  }

  if (req.method === 'POST' && pathname === '/api/delete-state') {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (_) { jsonResponse(res, 400, { error: 'Body JSON tidak valid' }); return; }

    const { paths: delPaths } = body;
    if (!Array.isArray(delPaths) || delPaths.length === 0) {
      jsonResponse(res, 400, { error: 'Harus ada paths (array)' }); return;
    }
    let deleted = 0;
    for (const p of delPaths) {
      const mp = markerPath(p);
      if (fs.existsSync(mp)) { try { fs.unlinkSync(mp); deleted++; } catch (_) {} }
    }
    log(`🗑️ Delete state: ${deleted}/${delPaths.length} file(s) dihapus dari UI`);
    jsonResponse(res, 200, { message: `${deleted} state berhasil dihapus.`, deleted });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/router-logs') {
    const lines = parseInt(url.searchParams.get('lines') || '2000', 10);
    try {
      const content = await getDockerLogs(lines);
      if (content === null) {
        jsonResponse(res, 200, { available: false, content: '' });
      } else {
        jsonResponse(res, 200, { available: true, content });
      }
    } catch (err) {
      jsonResponse(res, 200, { available: false, content: '' });
    }
    return;
  }

  if (req.method === 'GET' && pathname === '/api/accession-summary') {
    try {
      const data = await getAccessionSummary();
      jsonResponse(res, 200, data);
    } catch (err) {
      jsonResponse(res, 200, { failed: [], succeeded: [] });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/get-path-by-acc') {
    let body;
    try { body = JSON.parse(await readBody(req)); }
    catch (_) { jsonResponse(res, 400, { error: 'Body JSON tidak valid' }); return; }
    const { accessions } = body;
    if (!Array.isArray(accessions) || accessions.length === 0) {
      jsonResponse(res, 400, { error: 'Harus ada accessions (array)' }); return;
    }
    try {
      const conn = await mysql.createConnection({
        host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASS,
        database: DB_NAME, connectTimeout: 8000
      });
      try {
        const placeholders = accessions.map(() => '?').join(',');
        const sql =
          'SELECT f.pk, st.accession_no, f.filepath, s.series_desc, st.created_time ' +
          'FROM files AS f ' +
          'JOIN instance AS i ON f.instance_fk = i.pk ' +
          'JOIN series AS s ON i.series_fk = s.pk ' +
          'JOIN study AS st ON s.study_fk = st.pk ' +
          'JOIN patient AS p ON st.patient_fk = p.pk ' +
          'WHERE st.accession_no IN (' + placeholders + ') ' +
          'ORDER BY f.pk, s.series_desc DESC';
        const [rows] = await conn.execute(sql, accessions);
        jsonResponse(res, 200, { rows });
      } finally {
        await conn.end();
      }
    } catch (err) {
      log('\u274C get-path-by-acc error:', err.message);
      jsonResponse(res, 500, { error: err.message });
    }
    return;
  }

  res.writeHead(404); res.end('Not found');
})

// ─────────────────────────────────────────────
//  STARTUP
// ─────────────────────────────────────────────
server.listen(UI_PORT, () => {
  log(`🌐 Web UI running at http://0.0.0.0:${UI_PORT}`);
});

log(`🚀 DICOM FTP Forwarder starting — ${FTP_HOST}:${FTP_PORT} -> ${ROUTER_AET}@${ROUTER_HOST}:${ROUTER_PORT}`);
log(`⏰ Scheduled scan: 1x sehari jam ${String(SCHEDULE_HOUR).padStart(2,'0')}:00 — kirim H-1`);

scheduleNext();
