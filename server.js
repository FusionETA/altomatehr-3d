// Globe Live Floor — a small, dependency-free server.
//
// It holds one read-only AltomateHR API key per Globe company, polls each
// company's data, merges the three into one snapshot and serves it (plus the
// map page) to browsers on the office network. Keys never reach the browser.
//
// What leaves this server is deliberately thin: names, job titles and clock-in
// status. No emails, selfies or GPS coordinates of people.

'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');

// ---------- config (.env next to this file, or real environment variables) ----------
loadEnv(path.join(__dirname, '.env'));
const API = (process.env.ALTOMATE_API_URL || 'http://localhost:5001').replace(/\/+$/, '');
const KEYS = (process.env.GLOBE_KEYS || '').split(',').map(s => s.trim()).filter(Boolean);
const HOST = process.env.HOST || '127.0.0.1';
const PORT = Number(process.env.PORT || 8080);
const REFRESH_MS = Math.max(15, Number(process.env.REFRESH_SECONDS || 30)) * 1000;
const SLOW_MS = 10 * 60 * 1000; // company name, projects and staff list change rarely
// Office network only: requests from anywhere else get 403, even if the port is exposed by mistake.
const ALLOW = (process.env.ALLOW_NETWORKS || '127.0.0.0/8,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16,::1/128,fc00::/7')
  .split(',').map(s => s.trim()).filter(Boolean);

if (!KEYS.length) {
  console.error('No API keys. Set GLOBE_KEYS in .env (comma-separated, one read-only key per company). See README.md.');
  process.exit(1);
}

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}

// ---------- AltomateHR ----------
async function get(key, route) {
  const res = await fetch(API + route, { headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  if (res.status === 204) return null;
  if (!res.ok) {
    const err = new Error(`${route} → HTTP ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res.json();
}

const slowCache = new Map(); // key index → { at, org, projects, employees }

async function readCompany(key, i) {
  let slow = slowCache.get(i);
  if (!slow || Date.now() - slow.at > SLOW_MS) {
    const [org, projects, employees] = await Promise.all([
      get(key, '/organizations/current'), get(key, '/projects'), get(key, '/employees'),
    ]);
    slow = { at: Date.now(), org, projects, employees };
    slowCache.set(i, slow);
  }
  const [records, leave] = await Promise.all([get(key, '/attendance/org/today'), get(key, '/leave/on-leave-today')]);
  return shape(i, slow, records || [], leave || []);
}

// Turn the API responses into the map's snapshot for one company.
function shape(i, { org, projects, employees }, records, leave) {
  const onLeave = new Map(leave.map(l => [l.employeeId, l]));
  const recordOf = new Map(records.map(r => [r.employeeId, r]));
  const staff = employees.filter(e => e.role === 'Employee' || e.role === 'Supervisor' || recordOf.has(e.id));
  const people = staff.map(e => {
    const r = recordOf.get(e.id), l = onLeave.get(e.id);
    const open = r && r.timeIn && !r.timeOut;
    const p = { id: e.id, name: e.name || 'Unnamed', title: e.jobTitle || '', role: e.role, nickname: e.nickname || null };
    if (open) Object.assign(p, {
      status: r.offSite ? 'outside' : 'onsite', projectId: r.projectId || null, clockIn: r.timeIn,
      dist: r.clockInDistanceMeters == null ? null : Math.round(r.clockInDistanceMeters), late: r.lateByMin || 0,
      approval: r.offSite ? r.approvalStatus : null,
    });
    else if (l) Object.assign(p, { status: 'leave', leaveType: l.leaveTypeName, leaveUntil: l.endDate });
    else if (r && r.timeOut) Object.assign(p, { status: 'done', projectId: r.projectId || null, clockIn: r.timeIn, clockOut: r.timeOut });
    else Object.assign(p, { status: 'notin' });
    return p;
  });
  return {
    id: 'c' + i,
    name: org && org.name ? org.name : `Company ${i + 1}`,
    geofenceRadius: org && org.geofenceRadiusMeters ? org.geofenceRadiusMeters : 200,
    projects: projects.filter(p => !p.isArchived).map(p => ({
      id: p.id, name: p.name, location: p.location || '', lat: p.latitude, lng: p.longitude,
      start: p.workingHoursStart || null, end: p.workingHoursEnd || null, geofenceSites: p.geofenceSiteCount || 0,
    })),
    people,
  };
}

// ---------- the merged snapshot, refreshed in the background ----------
let snapshot = { at: null, refreshSeconds: REFRESH_MS / 1000, companies: [], errors: [] };
let refreshing = null;

async function refresh() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    const results = await Promise.allSettled(KEYS.map((k, i) => readCompany(k, i)));
    const companies = [], errors = [];
    results.forEach((r, i) => {
      if (r.status === 'fulfilled') companies.push(r.value);
      else {
        // Keep showing the last good data for that company rather than dropping it from the map.
        const prev = snapshot.companies.find(c => c.id === 'c' + i);
        if (prev) companies.push({ ...prev, stale: true });
        errors.push({ company: prev ? prev.name : `Company ${i + 1}`, message: friendly(r.reason) });
        console.warn(new Date().toISOString(), `company ${i + 1}:`, r.reason && r.reason.message);
      }
    });
    snapshot = { at: new Date().toISOString(), refreshSeconds: REFRESH_MS / 1000, companies, errors };
  })().finally(() => { refreshing = null; });
  return refreshing;
}

function friendly(err) {
  if (!err) return 'Unknown error';
  if (err.status === 401) return 'The API key was rejected (revoked or mistyped).';
  if (err.status === 403) return 'The API key is missing a read scope, or the module is off for this company.';
  if (err.status === 404) return 'AltomateHR does not have the /attendance/org/today endpoint yet.';
  if (err.name === 'TimeoutError') return 'AltomateHR did not answer in time.';
  return 'Could not reach AltomateHR.';
}

// ---------- office-network check ----------
function inCidr(ip, cidr) {
  const [base, bitsS] = cidr.split('/');
  const v4 = s => s.startsWith('::ffff:') ? s.slice(7) : s;
  const a = v4(ip), b = v4(base);
  const fam = net.isIPv4(a) ? 4 : net.isIPv6(a) ? 6 : 0;
  if (!fam || fam !== (net.isIPv4(b) ? 4 : 6)) return false;
  const bits = Number(bitsS ?? (fam === 4 ? 32 : 128));
  const bytes = s => fam === 4 ? s.split('.').map(Number) : expand6(s);
  const x = bytes(a), y = bytes(b);
  for (let i = 0, left = bits; left > 0; i++, left -= 8) {
    const mask = left >= 8 ? 0xff : (0xff << (8 - left)) & 0xff;
    if ((x[i] & mask) !== (y[i] & mask)) return false;
  }
  return true;
}
function expand6(s) {
  const [h, t = ''] = s.split('::');
  const hp = h ? h.split(':') : [], tp = t ? t.split(':') : [];
  const parts = s.includes('::') ? [...hp, ...Array(8 - hp.length - tp.length).fill('0'), ...tp] : hp;
  return parts.flatMap(p => { const n = parseInt(p || '0', 16); return [n >> 8, n & 0xff]; });
}
const allowed = ip => ALLOW.some(c => { try { return inCidr(ip || '', c); } catch { return false; } });

// ---------- HTTP ----------
const PUBLIC = path.join(__dirname, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };
const SECURITY = { 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'SAMEORIGIN' };

const server = http.createServer(async (req, res) => {
  if (!allowed(req.socket.remoteAddress)) { res.writeHead(403, SECURITY); res.end('Office network only.'); return; }
  const url = new URL(req.url, 'http://x');
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405, SECURITY); res.end(); return; }

  if (url.pathname === '/api/floor') {
    if (!snapshot.at) await refresh().catch(() => {});
    res.writeHead(200, { ...SECURITY, 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(snapshot));
    return;
  }

  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC + path.sep)) { res.writeHead(404, SECURITY); res.end(); return; }
  fs.readFile(file, (err, body) => {
    if (err) { res.writeHead(404, SECURITY); res.end('Not found'); return; }
    res.writeHead(200, { ...SECURITY, 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
});

refresh().catch(() => {});
setInterval(() => refresh().catch(() => {}), REFRESH_MS);
server.listen(PORT, HOST, () => {
  console.log(`Globe Live Floor on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT} · ${KEYS.length} companies · refresh every ${REFRESH_MS / 1000}s · AltomateHR at ${API}`);
});
