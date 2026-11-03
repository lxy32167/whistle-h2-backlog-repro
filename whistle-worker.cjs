'use strict';
// The parent supplies a fresh WHISTLE_PATH before this module is loaded.
const http = require('node:http');
const proxyPort = Number(process.env.REPRO_PROXY_PORT);
const originPort = Number(process.env.REPRO_ORIGIN_PORT);
const trace = process.env.REPRO_TRACE === '1';
const stats = { active: 0, peakActive: 0, requests: 0, errors: {} };

// Optional observation only. No Agent, headers, timeouts or forwarding behavior changes.
if (trace) {
  const request = http.request;
  http.request = function (options, ...args) {
    const client = request.call(this, options, ...args);
    if (options && options.host === '127.0.0.1' && Number(options.port) === proxyPort
        && /^repro\.test(?::443)?$/.test(options.headers?.host || options.headers?.Host || '')) {
      stats.requests++;
      stats.peakActive = Math.max(stats.peakActive, ++stats.active);
      client.once('close', () => { stats.active--; });
      client.on('error', error => {
        const key = `${error.code || 'UNKNOWN'}:${error.syscall || 'unknown'}`;
        stats.errors[key] = (stats.errors[key] || 0) + 1;
        process.send?.({ type: 'bridge-error', code: error.code, syscall: error.syscall });
      });
    }
    return client;
  };
}

require('whistle')({
  host: '127.0.0.1',
  port: proxyPort,
  baseDir: process.env.WHISTLE_PATH,
  mode: 'capture|http2|disableUpdateTips',
  noGlobalPlugins: true,
  disableAllPlugins: true,
  shadowRules: `repro.test http://127.0.0.1:${originPort}`,
}, () => {
  process.send?.({ type: 'ready', caFile: require('whistle/lib/https/ca').getRootCAFile() });
});
process.on('message', message => {
  if (message === 'stats') process.send?.({ type: 'stats', ...stats });
});
process.on('SIGTERM', () => process.exit(0));
