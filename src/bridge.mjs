#!/usr/bin/env node
// pre.dev MCP: pre.dev in any local coding agent. Browser Agents Local drives the Chrome you
// already run, across every profile, through one shared debugging connection; pre.dev's hosted
// tools (cloud Browser Agents, specs, plans) come through on the same key (remote.mjs).
//
//   predev-mcp          stdio MCP server (what agents launch); starts the daemon on demand
//   predev-mcp setup    signs in to pre.dev, adds it to every coding agent, connects to Chrome
//                       (also login, logout, uninstall; see setup.mjs)
//   predev-mcp check    checks your setup and lists your Chrome profiles
//   predev-mcp stop     stops the background daemon
//   predev-mcp daemon   (internal) holds the single Chrome connection and serves the MCP shims
//                       over localhost HTTP with a per-run token. Tools live in tools.mjs and
//                       hot-reload, so editing them never drops the approved connection.
//
// Chrome asks "Allow remote debugging?" once per connection, so the daemon keeps one
// connection for every agent instead of each agent opening its own.

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRemote } from './remote.mjs';

const SELF = fileURLToPath(import.meta.url);
const TOOLS_FILE = path.join(path.dirname(SELF), 'tools.mjs');
const PKG = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(path.dirname(SELF), '../package.json'), 'utf8')); } catch { return {}; }
})();
// Content hash, not mtime: reinstalling the same version must not restart the daemon (and re-ask Allow).
const VERSION = crypto.createHash('sha1').update(fs.readFileSync(SELF)).digest('hex').slice(0, 12);

function defaultChromeDir() {
  const home = os.homedir();
  if (process.platform === 'darwin') return path.join(home, 'Library/Application Support/Google/Chrome');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData/Local'), 'Google/Chrome/User Data');
  return path.join(process.env.XDG_CONFIG_HOME || path.join(home, '.config'), 'google-chrome');
}

const CUSTOM_DIR = (process.env.CHROME_MCP_USER_DATA_DIR || '').trim();
const CHROME_DIR = CUSTOM_DIR ? path.resolve(CUSTOM_DIR.replace(/^~(?=[/\\]|$)/, os.homedir())) : defaultChromeDir();
// One daemon per Chrome: a custom user data dir gets its own daemon and state.
const BASE_STATE_DIR = path.join(os.homedir(), '.predev', 'mcp');
const STATE_DIR = CUSTOM_DIR
  ? path.join(BASE_STATE_DIR, crypto.createHash('sha1').update(CHROME_DIR).digest('hex').slice(0, 10))
  : BASE_STATE_DIR;
const STATE_FILE = path.join(STATE_DIR, 'daemon.json');
const LOCK_FILE = path.join(STATE_DIR, 'daemon.lock');
const MAP_FILE = path.join(STATE_DIR, 'profiles.json');
const LOG_FILE = path.join(STATE_DIR, 'predev-mcp.log');
/** Saved by `predev-mcp login` / `setup`, shared by every agent and every Chrome. */
const CREDENTIALS_FILE = path.join(BASE_STATE_DIR, 'credentials.json');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function log(...parts) {
  try { fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${parts.join(' ')}\n`); } catch {}
}

// ---------------------------------------------------------------- CDP connection

class Chrome {
  constructor() {
    this.ws = null;
    this.wsUrl = '';
    this.nextId = 0;
    this.pending = new Map();
    this.targets = new Map();   // targetId -> TargetInfo
    this.sessions = new Map();  // targetId -> sessionId
    this.connecting = null;
  }

  get connected() { return this.ws?.readyState === 1; }

  // One pending connection at a time: while Chrome's "Allow remote debugging?" prompt is up,
  // callers get a clear retry message instead of each opening another prompt.
  async connect() {
    if (this.connected) return;
    this.connecting ??= this.#open().finally(() => { this.connecting = null; });
    let timer;
    const waiting = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Chrome is asking "Allow remote debugging?". Click Allow in Chrome, then retry this call.')), 40000);
    });
    try { await Promise.race([this.connecting, waiting]); } finally { clearTimeout(timer); }
  }

  async #open() {
    let port, wsPath;
    try {
      [port, wsPath] = fs.readFileSync(path.join(CHROME_DIR, 'DevToolsActivePort'), 'utf8').trim().split('\n');
    } catch {
      throw new Error(`Chrome remote debugging is off. Open chrome://inspect/#remote-debugging in Chrome and turn it on.${CUSTOM_DIR ? ` (Looked in ${CHROME_DIR}.)` : ''}`);
    }
    const url = `ws://127.0.0.1:${port}${wsPath}`;
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        try { ws.close(); } catch {}
        reject(new Error('Chrome\'s "Allow remote debugging?" prompt was not answered in 10 minutes; retry to ask again.'));
      }, 600000);
      ws.onopen = () => { clearTimeout(timer); resolve(); };
      ws.onerror = () => { clearTimeout(timer); reject(new Error('Chrome refused the debugging connection (prompt cancelled, or Chrome is not running).')); };
    });
    ws.onmessage = event => this.#onMessage(JSON.parse(event.data));
    ws.onclose = () => {
      log('chrome connection closed');
      this.ws = null;
      this.targets.clear();
      this.sessions.clear();
      for (const call of this.pending.values()) { clearTimeout(call.timer); call.reject(new Error('Chrome connection closed; retry.')); }
      this.pending.clear();
    };
    this.ws = ws;
    if (this.wsUrl !== url) { contextDirs.clear(); this.wsUrl = url; loadProfileMap(); }
    failedProbes.clear();
    triedDirs.clear();
    await this.send('Target.setDiscoverTargets', { discover: true });
    for (const info of (await this.send('Target.getTargets')).targetInfos) this.targets.set(info.targetId, info);
    log('connected', url);
  }

  #onMessage(message) {
    if (message.id !== undefined) {
      const call = this.pending.get(message.id);
      if (!call) return;
      this.pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) call.reject(new Error(message.error.message));
      else call.resolve(message.result);
      return;
    }
    const { method, params } = message;
    if (method === 'Target.targetCreated' || method === 'Target.targetInfoChanged') {
      this.targets.set(params.targetInfo.targetId, params.targetInfo);
    } else if (method === 'Target.targetDestroyed') {
      this.targets.delete(params.targetId);
      this.sessions.delete(params.targetId);
    } else if (method === 'Target.detachedFromTarget') {
      for (const [targetId, sessionId] of this.sessions) if (sessionId === params.sessionId) this.sessions.delete(targetId);
    }
  }

  send(method, params = {}, sessionId, timeout = 15000) {
    if (!this.connected) return Promise.reject(new Error('Not connected to Chrome; retry.'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Chrome did not answer ${method} within ${timeout / 1000}s.`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }

  async session(targetId) {
    const existing = this.sessions.get(targetId);
    if (existing) return existing;
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true });
    this.sessions.set(targetId, sessionId);
    // Background tabs are throttled or frozen; keep them responsive while an agent drives them.
    await this.send('Page.setWebLifecycleState', { state: 'active' }, sessionId).catch(() => {});
    await this.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId).catch(() => {});
    return sessionId;
  }
}

const chrome = new Chrome();
const contextDirs = new Map(); // browserContextId -> Chrome profile directory

function loadProfileMap() {
  try {
    const saved = JSON.parse(fs.readFileSync(MAP_FILE, 'utf8'));
    if (saved.wsUrl === chrome.wsUrl) for (const [ctx, dir] of Object.entries(saved.map)) contextDirs.set(ctx, dir);
  } catch {}
}

function saveProfileMap() {
  try { fs.writeFileSync(MAP_FILE, JSON.stringify({ wsUrl: chrome.wsUrl, map: Object.fromEntries(contextDirs) })); } catch {}
}

// Mapping attempts that failed are not retried on the same connection, so tabs never flash twice.
const failedProbes = new Set();
const triedDirs = new Set();
let daemonPort = 0;

const core = {
  chrome, contextDirs, failedProbes, triedDirs, saveProfileMap, log, sleep,
  chromeDir: CHROME_DIR, customChromeDir: Boolean(CUSTOM_DIR), version: PKG.version || '0.0.0',
  get daemonPort() { return daemonPort; },
};

let loaded = { mtime: 0, api: null };
async function loadTools() {
  let mtime;
  try { mtime = fs.statSync(TOOLS_FILE).mtimeMs; } catch (error) { if (loaded.api) return loaded.api; throw error; }
  if (!loaded.api || loaded.mtime !== mtime) {
    const module = await import(`${pathToFileURL(TOOLS_FILE).href}?v=${mtime}`);
    loaded = { mtime, api: module.createTools(core) };
    log('tools loaded', Math.round(mtime));
  }
  return loaded.api;
}

async function callTool(name, args, ctx) {
  const { TOOLS } = await loadTools();
  const tool = TOOLS.find(t => t.name === name);
  if (!tool) throw new Error(`Unknown tool ${name}`);
  await chrome.connect();
  const result = await tool.run(args || {}, ctx);
  return typeof result === 'string' ? { content: [{ type: 'text', text: result }] } : result;
}

// ---------------------------------------------------------------- daemon

function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }

function takeLock() {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch {
      const holder = Number(fs.readFileSync(LOCK_FILE, 'utf8')) || 0;
      if (holder && pidAlive(holder)) return false;
      fs.rmSync(LOCK_FILE, { force: true });
    }
  }
  return false;
}

function runDaemon() {
  fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
  if (!takeLock()) { log('another daemon holds the lock; exiting'); process.exit(0); }
  const release = () => {
    try { if (fs.readFileSync(LOCK_FILE, 'utf8') === String(process.pid)) fs.rmSync(LOCK_FILE); } catch {}
  };
  process.on('exit', release);
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(0));

  const token = crypto.randomBytes(24).toString('hex');
  const server = http.createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/blank') {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>Opening…</title>');
      return;
    }
    // A browser page could reach localhost; it can't know the token, and it would send Origin.
    if (req.headers['x-bridge-token'] !== token || req.headers.origin) { res.writeHead(403); res.end(); return; }
    const reply = (body, status = 200) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
    if (req.method === 'GET' && req.url === '/health') return reply({ ok: true, version: VERSION, chrome: chrome.connected });
    if (req.method === 'POST' && req.url === '/shutdown') { reply({ ok: true }); setTimeout(() => process.exit(0), 50); return; }
    if (req.method === 'POST' && req.url === '/call') {
      let body = '';
      for await (const chunk of req) body += chunk;
      const { name, args } = JSON.parse(body);
      // Each agent passes its own pre.dev API key; the daemon is shared, so it never uses one of its own.
      const ctx = {
        apiKey: String(req.headers['x-predev-api-key'] || '').trim(),
        apiUrl: String(req.headers['x-predev-api-url'] || DEFAULT_API_URL).trim(),
      };
      const started = Date.now();
      try {
        const result = await callTool(name, args, ctx);
        log('call', name, 'ok', `${Date.now() - started}ms`);
        reply(result);
      } catch (error) {
        log('call', name, 'error', error.message);
        reply({ content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true });
      }
      return;
    }
    reply({ error: 'not found' }, 404);
  });
  server.listen(0, '127.0.0.1', () => {
    daemonPort = server.address().port;
    const tmp = `${STATE_FILE}.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ port: server.address().port, token, pid: process.pid, version: VERSION }), { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
    log('daemon listening on', server.address().port, 'version', VERSION);
  });
}

// ---------------------------------------------------------------- MCP stdio shim

const DEFAULT_API_URL = 'https://api.pre.dev';
function readCredentials() {
  try { return JSON.parse(fs.readFileSync(CREDENTIALS_FILE, 'utf8')) || {}; } catch { return {}; }
}
// Read on every call, so signing in takes effect without restarting the agent. An agent's
// PREDEV_API_KEY wins over the saved key.
function shimCtx() {
  const saved = process.env.PREDEV_API_KEY ? {} : readCredentials();
  return {
    apiKey: String(process.env.PREDEV_API_KEY || saved.apiKey || '').trim(),
    apiUrl: String(process.env.PREDEV_API_URL || saved.apiUrl || DEFAULT_API_URL).trim(),
  };
}

function request(state, method, route, body, timeout = 180000) {
  const { apiKey, apiUrl } = shimCtx();
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: state.port, path: route, method, timeout,
      headers: {
        'x-bridge-token': state.token, 'content-type': 'application/json',
        ...(apiKey ? { 'x-predev-api-key': apiKey, 'x-predev-api-url': apiUrl } : {}),
      },
    }, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (error) { reject(error); } });
    });
    req.on('timeout', () => req.destroy(new Error('The Chrome MCP daemon did not answer in time.')));
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function readState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return null; }
}

async function ensureDaemon() {
  for (let attempt = 0; attempt < 3; attempt++) {
    const state = readState();
    const health = state && await request(state, 'GET', '/health', null, 3000).catch(() => null);
    if (health?.ok && health.version === VERSION) return state;
    if (health?.ok) { await request(state, 'POST', '/shutdown', {}, 3000).catch(() => {}); await sleep(300); }
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const out = fs.openSync(LOG_FILE, 'a');
    spawn(process.execPath, [SELF, 'daemon'], { detached: true, stdio: ['ignore', out, out], windowsHide: true }).unref();
    for (let i = 0; i < 50; i++) {
      await sleep(100);
      const fresh = readState();
      if (fresh && fresh.version === VERSION && await request(fresh, 'GET', '/health', null, 1000).then(h => h.ok).catch(() => false)) return fresh;
    }
  }
  throw new Error(`Could not start the Chrome MCP daemon; see ${LOG_FILE}.`);
}

const remote = createRemote({ version: PKG.version || '0.0.0' });

function runMcp() {
  const write = message => process.stdout.write(`${JSON.stringify(message)}\n`);
  const handle = async message => {
    const reply = result => write({ jsonrpc: '2.0', id: message.id, result });
    try {
      switch (message.method) {
        case 'initialize':
          return reply({
            protocolVersion: message.params?.protocolVersion || '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'predev', version: PKG.version || '0.0.0' },
            instructions: (await loadTools()).instructions(shimCtx()),
          });
        case 'tools/list': {
          const ctx = shimCtx();
          return reply({ tools: [...(await loadTools()).toolList(ctx), ...(await remote.listTools(ctx))] });
        }
        case 'tools/call': {
          const ctx = shimCtx();
          const { name, arguments: args } = message.params;
          // pre.dev's hosted tools go straight to pre.dev; they don't need Chrome.
          if (await remote.isRemote(ctx, name)) {
            if (!ctx.apiKey) return reply({ content: [{ type: 'text', text: 'pre.dev tools need a free pre.dev account. Sign in by running `npx -y @predotdev/mcp login` in a terminal (no restart needed).' }], isError: true });
            return reply(await remote.callTool(ctx, name, args));
          }
          const state = await ensureDaemon();
          return reply(await request(state, 'POST', '/call', { name, args }));
        }
        case 'ping':
          return reply({});
        default:
          if (message.id !== undefined) write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } });
      }
    } catch (error) {
      if (message.id !== undefined) reply({ content: [{ type: 'text', text: `Error: ${error.message}` }], isError: true });
    }
  };
  let buffer = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let newline;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      handle(message);
    }
  });
  process.stdin.on('end', () => process.exit(0));
}

// ---------------------------------------------------------------- terminal commands

const HELP = `pre.dev MCP ${PKG.version || ''}
pre.dev in any coding agent: Browser Agents in the Chrome you already use (every profile, your
logins, your tabs) and in pre.dev's cloud, plus specs and plans.

Set it up in one go (signs you in to pre.dev, adds it to every coding agent on this computer,
and connects to Chrome). Run it again any time to update:

  npx -y @predotdev/mcp setup

Commands:
  predev-mcp setup      sign in, add to your agents, connect to Chrome (safe to repeat; also updates)
  predev-mcp check      check your setup and list your Chrome profiles
  predev-mcp login      sign in to pre.dev again
  predev-mcp logout     forget the saved pre.dev key
  predev-mcp stop       stop the background daemon (it restarts on the next tool call)
  predev-mcp uninstall  remove it from every agent and delete its files
  predev-mcp            run the MCP server (what your agent launches)
  predev-mcp --version

Docs: https://docs.pre.dev/browser-agents/local
`;

async function runCheck() {
  let failed = false;
  const ok = text => console.log(`  ✓ ${text}`);
  const bad = text => { failed = true; console.log(`  ✗ ${text}`); };
  console.log(`pre.dev MCP ${PKG.version || ''} setup check\n`);
  ok(`Node ${process.versions.node}`);
  if (fs.existsSync(path.join(CHROME_DIR, 'Local State'))) ok(`Chrome data found: ${CHROME_DIR}`);
  else bad(`No Chrome data at ${CHROME_DIR}. Install Google Chrome, or set CHROME_MCP_USER_DATA_DIR.`);
  if (fs.existsSync(path.join(CHROME_DIR, 'DevToolsActivePort'))) ok('Remote debugging is on');
  else bad('Remote debugging is off: open chrome://inspect/#remote-debugging in Chrome and turn it on, then run this again.');
  if (!failed) {
    console.log('\n  Connecting. If Chrome asks "Allow remote debugging?", click Allow.\n');
    const end = Date.now() + 120000;
    let result = null;
    while (Date.now() < end) {
      try {
        const state = await ensureDaemon();
        result = await request(state, 'POST', '/call', { name: 'chrome_profiles', args: {} });
      } catch (error) { result = { isError: true, content: [{ text: `Error: ${error.message}` }] }; }
      if (!result.isError || !/Allow remote debugging/.test(result.content?.[0]?.text || '')) break;
      await sleep(1000);
    }
    const text = result?.content?.[0]?.text || '';
    if (result?.isError) bad(text.replace(/^Error: /, ''));
    else {
      ok('Connected to Chrome. Your profiles:');
      console.log(text.split('\n').map(line => `      ${line}`).join('\n'));
    }
  }
  const { apiKey, apiUrl } = shimCtx();
  if (!apiKey) {
    console.log('  · Plain-words actions (chrome_act) are off: sign in to pre.dev (free) with');
    console.log('    npx -y @predotdev/mcp login');
  } else {
    let usage = null;
    const status = await fetch(`${apiUrl.replace(/\/+$/, '')}/v1/usage?days=30`, {
      headers: { Authorization: `Bearer ${apiKey}` }, signal: AbortSignal.timeout(15000),
    }).then(async r => { usage = await r.json().catch(() => null); return r.status; }).catch(() => 0);
    if (status === 200) {
      const actions = (usage?.by_model || []).filter(row => row.model === 'browser-agents-local').reduce((n, row) => n + row.requests, 0);
      const plan = /^trial$/i.test(usage?.tier || '') ? 'Free' : usage?.tier;
      ok(`Signed in to pre.dev${plan ? ` (plan: ${plan})` : ''}: plain-words actions are on, ${actions} used in the last 30 days`);
      if (/^(trial|free)$/i.test(usage?.tier || '')) console.log('    The free plan includes a limited number of them. More: https://pre.dev/billing?from=browser-agents-local');
    }
    else if (status === 401 || status === 403) bad('pre.dev rejected your key. Sign in again with: npx -y @predotdev/mcp login');
    else bad(`Could not check PREDEV_API_KEY with ${apiUrl} (${status ? `HTTP ${status}` : 'no answer'}).`);
  }
  console.log(failed ? '\nFix the ✗ items above, then run this again.' : '\nAll set. Add the server to your agent and ask it to use Chrome.');
  process.exit(failed ? 1 : 0);
}

async function runStop() {
  const state = readState();
  const stopped = state && await request(state, 'POST', '/shutdown', {}, 3000).then(r => r.ok).catch(() => false);
  console.log(stopped ? 'Stopped the Chrome MCP daemon.' : 'The Chrome MCP daemon is not running.');
}

if (typeof WebSocket === 'undefined') {
  process.stderr.write(`pre.dev Chrome MCP needs Node 22 or newer (this is Node ${process.versions.node}).\n`);
  process.exit(1);
}

async function runSetupCommand(name) {
  const { createSetup } = await import(pathToFileURL(path.join(path.dirname(SELF), 'setup.mjs')).href);
  const setup = createSetup({
    baseStateDir: BASE_STATE_DIR, stateDir: STATE_DIR, chromeDir: CHROME_DIR, customChromeDir: Boolean(CUSTOM_DIR),
    pkg: PKG, sleep, ensureDaemon, request, readCredentials, credentialsFile: CREDENTIALS_FILE,
    packageRoot: path.join(path.dirname(SELF), '..'),
  });
  await setup[name]();
}

const command = process.argv[2] || '';
if (command === 'daemon') runDaemon();
else if (['setup', 'install', 'login', 'logout', 'uninstall'].includes(command)) runSetupCommand(command === 'install' ? 'setup' : command);
else if (command === 'check') runCheck();
else if (command === 'stop') runStop();
else if (command === '--version' || command === '-v') console.log(PKG.version || '0.0.0');
else if (command === '--help' || command === '-h' || command === 'help') process.stdout.write(HELP);
else if (command === '' || command === 'mcp') {
  if (process.stdin.isTTY && !command) process.stderr.write(HELP);
  else runMcp();
} else {
  process.stderr.write(`Unknown command "${command}".\n\n${HELP}`);
  process.exit(1);
}
