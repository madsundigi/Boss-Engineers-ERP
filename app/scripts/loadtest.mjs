// Dependency-free load probe (built-in http only).
//   node scripts/loadtest.mjs [url] [concurrency] [seconds]
// Defaults: http://localhost:3001/health, 50 conns, 10s. Pass a Bearer token via
// AUTH_TOKEN to hit a protected endpoint, e.g.:
//   AUTH_TOKEN=$T node scripts/loadtest.mjs http://localhost:3001/api/me 100 15
import http from 'node:http';

const url = process.argv[2] ?? 'http://localhost:3001/health';
const conc = Number(process.argv[3] ?? 50);
const secs = Number(process.argv[4] ?? 10);
const u = new URL(url);
const headers = process.env.AUTH_TOKEN ? { authorization: `Bearer ${process.env.AUTH_TOKEN}` } : {};

let ok = 0, errs = 0;
const lat = [];
const deadline = Date.now() + secs * 1000;

function once() {
  return new Promise((resolve) => {
    const start = process.hrtime.bigint();
    const req = http.get(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, headers },
      (res) => {
        res.resume();
        res.on('end', () => {
          lat.push(Number(process.hrtime.bigint() - start) / 1e6);
          if (res.statusCode < 400) ok++; else errs++;
          resolve();
        });
      });
    req.on('error', () => { errs++; resolve(); });
  });
}

async function worker() { while (Date.now() < deadline) await once(); }

const t0 = Date.now();
await Promise.all(Array.from({ length: conc }, worker));
const dur = (Date.now() - t0) / 1000;
lat.sort((a, b) => a - b);
const q = (p) => (lat.length ? lat[Math.floor(lat.length * p)].toFixed(1) : '-');
console.log(
  `ok=${ok} errors=${errs} rps=${(ok / dur).toFixed(0)} ` +
  `p50=${q(0.5)}ms p95=${q(0.95)}ms p99=${q(0.99)}ms  (${conc} conns, ${dur.toFixed(1)}s, ${url})`);
