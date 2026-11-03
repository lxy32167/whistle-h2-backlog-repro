'use strict';
const http = require('node:http');
const http2 = require('node:http2');
const tls = require('node:tls');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { fork, execFileSync } = require('node:child_process');
const { once } = require('node:events');
const { performance } = require('node:perf_hooks');

const args = process.argv.slice(2);
function numberArg(name, fallback, max = 100000) {
  const index = args.indexOf(name);
  const value = index < 0 ? fallback : Number(args[index + 1]);
  if (!Number.isInteger(value) || value < 1 || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
const concurrency = numberArg('--concurrency', 200, 1000);
const count = numberArg('--requests', 1000, 20000);
const proxyPort = numberArg('--proxy-port', 18899, 65535);
const trace = args.includes('--trace');
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'whistle-h2-repro-'));
const expectedBody = 'export default 1;\n';
let child, session, tunnel, secureSocket, stopping = false;
let originRequests = 0;
const origin = http.createServer((req, res) => {
  originRequests++;
  res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
  res.end(expectedBody);
});
const bridgeErrors = {};
let bridgeStats;
async function cleanup() {
  if (stopping) return;
  stopping = true;
  session?.destroy();
  secureSocket?.destroy();
  tunnel?.destroy();
  origin.closeAllConnections();
  origin.close();
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    const timer = setTimeout(() => child.kill('SIGKILL'), 3000);
    await exited;
    clearTimeout(timer);
  }
  fs.rmSync(dataDir, { recursive: true, force: true });
}
process.once('SIGINT', () => cleanup().finally(() => process.exit(130)));
process.once('SIGTERM', () => cleanup().finally(() => process.exit(143)));

async function connect(caFile) {
  tunnel = await new Promise((resolve, reject) => {
    const request = http.request({ host: '127.0.0.1', port: proxyPort, method: 'CONNECT', path: 'repro.test:443', agent: false });
    request.setTimeout(10000, () => request.destroy(new Error('CONNECT timeout')));
    request.once('error', reject);
    request.once('connect', (res, socket, head) => {
      if (res.statusCode !== 200) { socket.destroy(); reject(new Error(`CONNECT ${res.statusCode}`)); return; }
      socket.setTimeout(0);
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    request.end();
  });
  secureSocket = tls.connect({ socket: tunnel, servername: 'repro.test', ca: fs.readFileSync(caFile), ALPNProtocols: ['h2'] });
  await once(secureSocket, 'secureConnect');
  if (secureSocket.alpnProtocol !== 'h2') throw new Error(`Expected h2, got ${secureSocket.alpnProtocol}`);
  session = http2.connect('https://repro.test', {
    createConnection: () => secureSocket,
    maxSessionMemory: 1200,
    streamResetBurst: 100000,
    streamResetRate: 33,
  });
  session.on('error', error => console.error('HTTP/2 session error:', error.code));
  await once(session, 'remoteSettings');
}

function requestOne(index) {
  return new Promise(resolve => {
    let stream, status, body = '', errorCode, timedOut = false;
    try { stream = session.request({ ':path': `/module-${index}.js`, ':method': 'GET' }); }
    catch (error) { resolve({ ok: false, error: error.code || error.message }); return; }
    const timer = setTimeout(() => { timedOut = true; stream.close(http2.constants.NGHTTP2_CANCEL); }, 15000);
    stream.setEncoding('utf8');
    stream.on('response', headers => { status = headers[':status']; });
    stream.on('data', chunk => { body += chunk; });
    stream.on('error', error => { errorCode = error.code; });
    stream.once('close', () => {
      clearTimeout(timer);
      const ok = status === 200 && body === expectedBody && !errorCode && !timedOut;
      resolve({ ok, status: status ?? null, rstCode: stream.rstCode, error: timedOut ? 'TIMEOUT' : errorCode || (status === undefined ? 'CLOSED_WITHOUT_HEADERS' : ok ? null : 'BAD_RESPONSE') });
    });
    stream.end();
  });
}

async function main() {
  await new Promise((resolve, reject) => { origin.once('error', reject); origin.listen(0, '127.0.0.1', resolve); });
  const env = { ...process.env, WHISTLE_PATH: dataDir, REPRO_PROXY_PORT: String(proxyPort), REPRO_ORIGIN_PORT: String(origin.address().port), REPRO_TRACE: trace ? '1' : '0' };
  delete env.NODE_OPTIONS; // Do not inherit temporary Whistle patches from another session.
  child = fork(path.join(__dirname, 'whistle-worker.cjs'), [], { env, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
  child.stderr.on('data', chunk => process.stderr.write(chunk));
  child.on('message', message => {
    if (message.type === 'bridge-error') { const key = `${message.code}:${message.syscall}`; bridgeErrors[key] = (bridgeErrors[key] || 0) + 1; }
    if (message.type === 'stats') bridgeStats = message;
  });
  const ready = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Whistle startup timeout')), 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.once('exit', code => { clearTimeout(timer); reject(new Error(`Whistle exited: ${code}`)); });
    child.on('message', message => { if (message.type === 'ready') { clearTimeout(timer); resolve(message); } });
  });
  await connect(ready.caFile);
  const start = performance.now();
  let next = 0;
  const results = [];
  await Promise.all(Array.from({ length: Math.min(concurrency, count) }, async () => {
    while (next < count) results.push(await requestOne(next++));
  }));
  const elapsedMs = Math.round(performance.now() - start);
  if (trace) {
    await new Promise(resolve => {
      const timer = setTimeout(resolve, 1000);
      child.on('message', message => { if (message.type === 'stats') { clearTimeout(timer); resolve(); } });
      child.send('stats');
    });
  }
  let somaxconn = null;
  if (process.platform === 'darwin') {
    try { somaxconn = Number(execFileSync('/usr/sbin/sysctl', ['-n', 'kern.ipc.somaxconn'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch (_) { /* Optional environment metadata. */ }
  }
  const failures = results.filter(result => !result.ok);
  const report = {
    node: process.version, whistle: require('whistle/package.json').version,
    platform: process.platform, release: os.release(), arch: process.arch, somaxconn,
    alpn: secureSocket.alpnProtocol, concurrency, requests: count,
    passed: count - failures.length, failed: failures.length, elapsedMs, originRequests,
    failureTypes: failures.reduce((map, result) => { map[result.error] = (map[result.error] || 0) + 1; return map; }, {}),
    firstFailures: failures.slice(0, 5), ...(trace ? { bridgeErrors, bridgeStats } : {}),
  };
  fs.mkdirSync(path.join(__dirname, 'results'), { recursive: true });
  fs.writeFileSync(path.join(__dirname, 'results', 'latest.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = failures.length ? 1 : 0;
}
const watchdog = setTimeout(() => {
  console.error('Harness timed out after 60 seconds');
  cleanup().finally(() => process.exit(2));
}, 60000);
watchdog.unref();
main().catch(error => { console.error(error.message); process.exitCode = 2; }).finally(async () => {
  clearTimeout(watchdog);
  await cleanup();
});
