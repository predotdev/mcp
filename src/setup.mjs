// One-command setup for the pre.dev MCP, plus login, logout and uninstall.
//
//   predev-mcp setup      sign in to pre.dev, install a stable copy, add it to every coding agent
//                         found on this computer, and connect to Chrome
//   predev-mcp login      sign in again (saves the key for every agent)
//   predev-mcp logout     forget the saved key
//   predev-mcp uninstall  remove it from every agent, stop it, and delete its files
//
// Agents are registered with absolute paths (this Node and the stable copy), so desktop apps that
// don't load your shell's PATH start it too, and no agent config holds the key: the server reads
// the key saved by login (an agent's PREDEV_API_KEY still wins).

import { execFile, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CLIENT_ID = 'predev-chrome-mcp';
// pre.dev's own servers: the hosted one, this package under either name, or its installed copy.
const OWN = /api\.pre\.dev\/mcp|predotdev\/(chrome-)?mcp|\.predev\/(chrome-)?mcp\b/;
const NAMES = ['predev', 'pre-dev'];
/** Names pre.dev servers were registered under before (hosted install, or this one as Browser Agents Local). */
const LEGACY_NAMES = ['predotdev', 'pre.dev', 'chrome', 'predev-chrome'];

export function createSetup(ctx) {
  const { baseStateDir, stateDir, chromeDir, customChromeDir, pkg, sleep, ensureDaemon, request, readCredentials, credentialsFile, cliLogin, packageRoot } = ctx;
  const APP_DIR = path.join(baseStateDir, 'app');
  const APP_ENTRY = path.join(APP_DIR, 'src', 'bridge.mjs');
  const NODE = process.execPath;
  const home = os.homedir();
  const tty = process.stdout.isTTY;
  let failed = false;

  const ok = text => console.log(`  ✓ ${text}`);
  const skip = text => console.log(`  · ${text}`);
  const bad = text => { failed = true; console.log(`  ✗ ${text}`); };
  const step = (n, text) => console.log(`\n${n}. ${text}`);

  // A ticking "waiting" line on a terminal; a line every 15 s when output goes to a log or an agent.
  function waiter(text) {
    const started = Date.now();
    let last = 0;
    const elapsed = () => { const s = Math.round((Date.now() - started) / 1000); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
    return {
      tick() {
        if (tty) process.stdout.write(`\r  … ${text} ${elapsed()}  `);
        else if (Date.now() - last > 15000) { last = Date.now(); console.log(`  … ${text} ${elapsed()}`); }
      },
      done() { if (tty) process.stdout.write('\r\x1b[2K'); },
    };
  }

  function openUrl(url) {
    if (process.env.PREDEV_NO_BROWSER) return Promise.resolve(false);
    const [cmd, args] = process.platform === 'darwin' ? ['open', [url]]
      : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
    return new Promise(resolve => execFile(cmd, args, error => resolve(!error)));
  }

  const has = bin => spawnSync(process.platform === 'win32' ? 'where' : 'which', [bin], { stdio: 'ignore' }).status === 0;
  // `input` answers a CLI's own confirmation prompts (Hermes asks before it adds or removes a server).
  const run = (bin, args, input, timeout = 30000) => spawnSync(bin, args, { encoding: 'utf8', timeout, ...(input ? { input } : {}) });

  // ------------------------------------------------------------------ sign in

  const apiUrl = () => (process.env.PREDEV_API_URL || readCredentials().apiUrl || 'https://api.pre.dev').replace(/\/+$/, '');

  async function keyWorks(key, url) {
    if (!key) return false;
    const status = await fetch(`${url}/v1/usage?days=1`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) })
      .then(r => r.status).catch(() => 0);
    return status === 200;
  }

  // ~/.predev/mcp holds the key, the daemon's token and its log: private to this user.
  function privateBaseDir() {
    fs.mkdirSync(baseStateDir, { recursive: true, mode: 0o700 });
    try { fs.chmodSync(baseStateDir, 0o700); } catch {}
  }

  function saveKey(apiKey, url) {
    privateBaseDir();
    const tmp = `${credentialsFile}.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ apiKey, apiUrl: url, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, credentialsFile);
  }

  // The pre.dev CLI's short-code sign-in: approve in the browser, the key comes back here.
  async function signIn(allowSkip = false) {
    const url = apiUrl();
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('base64url');
    const start = await fetch(`${url}/oauth/device/authorize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        client_id: CLIENT_ID, code_challenge: challenge, code_challenge_method: 'S256', state, scope: 'mcp',
        device_os: { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform] || process.platform,
        device_host: os.hostname(), cli_version: `predev-mcp ${pkg.version || ''}`.trim(),
      }),
    }).then(async r => (r.ok ? r.json() : Promise.reject(new Error(`pre.dev answered ${r.status}`))));
    const link = start.verification_uri_complete;
    const opened = await openUrl(link);
    console.log(`  ${opened ? 'Opened pre.dev in your browser.' : 'Open this link in your browser:'} Sign in (or create a free account) and approve.`);
    if (opened) console.log(`  If nothing opened: ${link}`);
    else console.log(`  ${link}`);
    console.log(`  Your code: ${start.user_code}`);
    const end = Date.now() + (start.expires_in || 600) * 1000;
    // On a terminal, Enter skips: the Chrome tools work without an account.
    let skipped = false;
    const onKey = () => { skipped = true; };
    if (allowSkip && process.stdin.isTTY) {
      console.log('  Press Enter to skip (the Chrome tools work without an account).');
      process.stdin.resume();
      process.stdin.once('data', onKey);
    }
    const wait = waiter('Waiting for you to approve in the browser');
    let code = null;
    try {
    while (Date.now() < end && !code && !skipped) {
      wait.tick();
      await sleep((start.interval || 2) * 1000);
      const poll = await fetch(`${url}/oauth/cli/poll?state=${encodeURIComponent(state)}`, { signal: AbortSignal.timeout(15000) })
        .then(r => r.json()).catch(() => ({ pending: true }));
      if (poll.error) { wait.done(); throw new Error(poll.error === 'access_denied' ? 'Sign-in was denied in the browser.' : `Sign-in failed: ${poll.error}`); }
      if (poll.code) code = poll.code;
    }
    } finally {
      process.stdin.off('data', onKey);
      if (process.stdin.isTTY) process.stdin.pause();
    }
    wait.done();
    if (skipped) return null;
    if (!code) throw new Error('The sign-in code expired. Run this again for a new one.');
    const token = await fetch(`${url}/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: start.redirect_uri, client_id: CLIENT_ID }),
    }).then(async r => (r.ok ? r.json() : Promise.reject(new Error(`pre.dev answered ${r.status} to the sign-in`))));
    if (!token.access_token) throw new Error('pre.dev did not return a key.');
    saveKey(token.access_token, url);
    return token.access_token;
  }

  async function ensureSignedIn(force = false) {
    const url = apiUrl();
    if (!force) {
      if (process.env.PREDEV_API_KEY) {
        if (await keyWorks(process.env.PREDEV_API_KEY, url)) {
          saveKey(process.env.PREDEV_API_KEY, url);
          return ok(`Saved PREDEV_API_KEY from your environment in ${credentialsFile.replace(home, '~')} for every agent`);
        }
        return bad('pre.dev rejected PREDEV_API_KEY. Unset it to sign in here instead.');
      }
      const saved = readCredentials();
      if (saved.apiKey && await keyWorks(saved.apiKey, saved.apiUrl || url)) return ok('Already signed in to pre.dev');
      // Signed in to the pre.dev CLI: the server uses that login as it is, nothing new is saved.
      if (await keyWorks(cliLogin(), url)) return ok('Signed in with your pre.dev CLI login');
    }
    const later = 'Plain-words actions stay off until you run: npx -y @predotdev/mcp login';
    try {
      const key = await signIn(!force);
      if (!key) return skip(`Skipped sign-in. The Chrome tools work without it. ${later}`);
      ok(`Signed in. Your key is saved in ${credentialsFile.replace(home, '~')} for every agent.`);
    } catch (error) {
      if (force) bad(`${error.message} ${later}`);
      else skip(`${error.message} The Chrome tools work without it. ${later}`);
    }
  }

  // ------------------------------------------------------------------ stable copy

  function installApp() {
    if (path.resolve(packageRoot) === path.resolve(APP_DIR)) return ok(`Installed in ${APP_DIR.replace(home, '~')}`);
    privateBaseDir();
    fs.mkdirSync(path.join(APP_DIR, 'src'), { recursive: true });
    // Every module in src/, so a new one can never be left out of the installed copy.
    const modules = fs.readdirSync(path.join(packageRoot, 'src')).filter(name => name.endsWith('.mjs')).map(name => `src/${name}`);
    for (const file of [...modules, 'package.json', 'LICENSE', 'README.md']) {
      const from = path.join(packageRoot, file);
      if (!fs.existsSync(from)) continue;
      const tmp = path.join(APP_DIR, `${file}.${process.pid}`);
      fs.copyFileSync(from, tmp);
      fs.renameSync(tmp, path.join(APP_DIR, file));
    }
    fs.chmodSync(APP_ENTRY, 0o755);
    ok(`Installed version ${pkg.version || '?'} in ${APP_DIR.replace(home, '~')}`);
  }

  // ------------------------------------------------------------------ agents

  // Registers as "predev" ("pre-dev" when another tool already uses "predev"). Every other entry
  // that is pre.dev's (the hosted server at api.pre.dev/mcp, or an older install of this one) is
  // removed, since this server carries all of their tools; nothing else is ever touched.
  function pickName(entries) {
    return NAMES.find(name => !entries[name] || OWN.test(JSON.stringify(entries[name]))) || null;
  }

  function jsonAgent(label, file, key, entry, detect) {
    const read = () => {
      if (!fs.existsSync(file)) return { config: {}, existed: false };
      return { config: JSON.parse(fs.readFileSync(file, 'utf8') || '{}'), existed: true };
    };
    const write = (config, existed) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if (existed && !fs.existsSync(`${file}.bak-predev`)) fs.copyFileSync(file, `${file}.bak-predev`);
      // Configs can hold other servers' keys: keep the file's permissions (a new one is private).
      const mode = existed ? fs.statSync(file).mode & 0o777 : 0o600;
      const tmp = `${file}.${process.pid}`;
      fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`, { mode });
      fs.chmodSync(tmp, mode);
      fs.renameSync(tmp, file);
    };
    return {
      label, detect,
      register() {
        let state;
        try { state = read(); } catch {
          return { manual: `couldn't read ${file.replace(home, '~')} (comments or invalid JSON); add the server by hand` };
        }
        const { config, existed } = state;
        config[key] ??= {};
        const name = pickName(config[key]);
        if (!name) return { manual: `"predev" and "pre-dev" are taken in ${file.replace(home, '~')}` };
        const replaced = Object.keys(config[key]).filter(other => other !== name && OWN.test(JSON.stringify(config[key][other])));
        for (const other of replaced) delete config[key][other];
        config[key][name] = entry();
        write(config, existed);
        return { name, replaced };
      },
      unregister() {
        let state;
        try { state = read(); } catch { return 0; }
        const mine = Object.keys(state.config[key] || {}).filter(name => OWN.test(JSON.stringify(state.config[key][name])));
        for (const name of mine) delete state.config[key][name];
        if (mine.length) write(state.config, true);
        return mine.length;
      },
    };
  }

  const stdio = () => ({ command: NODE, args: [APP_ENTRY] });
  const appSupport = process.platform === 'darwin' ? path.join(home, 'Library/Application Support') : null;
  const exists = p => fs.existsSync(p);

  // CLI-managed agents: what they hold under names pre.dev has used (its own description of each).
  const claudeEntries = () => {
    const entries = {};
    for (const name of [...NAMES, ...LEGACY_NAMES]) {
      const got = run('claude', ['mcp', 'get', name]);
      if (got.status === 0) entries[name] = got.stdout;
    }
    return entries;
  };
  const codexEntries = () => {
    const out = run('codex', ['mcp', 'list', '--json']);
    try { return Object.fromEntries(JSON.parse(out.stdout).map(server => [server.name, server])); } catch { return {}; }
  };

  // Hermes keeps its servers in config.yaml (under mcp_servers); each entry's block of lines, by name.
  const hermesHome = process.env.HERMES_HOME || path.join(home, '.hermes');
  const hermesEntries = () => {
    let lines;
    try { lines = fs.readFileSync(path.join(hermesHome, 'config.yaml'), 'utf8').split('\n'); } catch { return {}; }
    const at = lines.findIndex(line => /^mcp_servers:\s*$/.test(line));
    const entries = {};
    let name = null;
    for (const line of at < 0 ? [] : lines.slice(at + 1)) {
      if (/^\S/.test(line)) break;
      const key = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
      if (key) { name = key[1]; entries[name] = ''; } else if (name) entries[name] += `${line}\n`;
    }
    return entries;
  };

  function cliAgent(label, bin, entries, remove, add) {
    return {
      label, detect: () => has(bin),
      register() {
        const current = entries();
        const name = pickName(current);
        if (!name) return { manual: '"predev" and "pre-dev" are taken' };
        const replaced = Object.keys(current).filter(other => other !== name && OWN.test(JSON.stringify(current[other])));
        for (const other of [...replaced, ...(current[name] ? [name] : [])]) remove(other);
        const added = add(name);
        return added.status === 0 ? { name, replaced } : { manual: (added.stderr || added.stdout || `${bin} mcp add failed`).trim().split('\n')[0] };
      },
      unregister() {
        const current = entries();
        const mine = Object.keys(current).filter(name => OWN.test(JSON.stringify(current[name])));
        for (const name of mine) remove(name);
        return mine.length;
      },
    };
  }

  const AGENTS = [
    cliAgent('Claude Code', 'claude', claudeEntries,
      name => run('claude', ['mcp', 'remove', name, '-s', 'user']),
      name => run('claude', ['mcp', 'add', '--scope', 'user', name, '--', NODE, APP_ENTRY])),
    cliAgent('Codex', 'codex', codexEntries,
      name => run('codex', ['mcp', 'remove', name]),
      name => {
        const added = run('codex', ['mcp', 'add', name, '--', NODE, APP_ENTRY]);
        // Specs and cloud browser runs need more than Codex's default tool timeout.
        const file = path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
        try {
          const lines = fs.readFileSync(file, 'utf8').split('\n');
          const at = lines.findIndex(line => line.trim() === `[mcp_servers.${name}]`);
          let end = lines.findIndex((line, i) => i > at && /^\s*\[/.test(line));
          if (end < 0) end = lines.length;
          if (at >= 0 && !lines.slice(at, end).some(line => /^\s*tool_timeout_sec\s*=/.test(line))) {
            lines.splice(at + 1, 0, 'tool_timeout_sec = 900');
            fs.writeFileSync(file, lines.join('\n'));
          }
        } catch {}
        return added;
      }),
    // The pre.dev CLI runs the chrome_* tools only: it has pre.dev's cloud tools built in.
    // Hermes registers it with its own CLI, which checks the server and asks to enable its tools.
    cliAgent('Hermes', 'hermes', hermesEntries,
      name => run('hermes', ['mcp', 'remove', name], 'y\n', 90000),
      name => {
        const added = run('hermes', ['mcp', 'add', name, '--command', NODE, '--args', APP_ENTRY], 'Y\nY\n', 90000);
        // Specs and cloud browser runs need more than Hermes's default tool timeout.
        if (added.status === 0) run('hermes', ['config', 'set', `mcp_servers.${name}.timeout`, '900']);
        return added;
      }),
    // Pi's built-in MCP (and the pi-mcp-adapter extension) read ~/.pi/agent/mcp.json.
    jsonAgent('Pi', path.join(process.env.PI_CODING_AGENT_DIR || path.join(home, '.pi/agent'), 'mcp.json'), 'mcpServers',
      () => ({ ...stdio(), timeout: 900 }),
      () => exists(process.env.PI_CODING_AGENT_DIR || path.join(home, '.pi')) || has('pi')),
    // OpenClaw keeps its servers in JSON5; its CLI edits them (set replaces, unset removes) and `show` prints JSON.
    cliAgent('OpenClaw', 'openclaw', () => {
      const out = String(run('openclaw', ['mcp', 'show'], null, 60000).stdout || '');
      try { return JSON.parse(out.slice(out.indexOf('{'))); } catch { return {}; }
    },
      name => run('openclaw', ['mcp', 'unset', name], null, 60000),
      name => run('openclaw', ['mcp', 'set', name, JSON.stringify({ ...stdio(), requestTimeoutMs: 900000 })], null, 60000)),
    jsonAgent('pre.dev CLI', path.join(home, '.predev/mcp.json'), 'mcpServers',
      () => ({ type: 'stdio', ...stdio(), env: { PREDEV_MCP_CLOUD: 'off' } }),
      () => exists(path.join(home, '.predev/bin')) || exists(path.join(home, '.predev/auth.json'))),
    jsonAgent('Cursor', path.join(home, '.cursor/mcp.json'), 'mcpServers', stdio, () => exists(path.join(home, '.cursor'))),
    // Copilot CLI's file, which VS Code's agent host reads too.
    jsonAgent('GitHub Copilot CLI', path.join(process.env.COPILOT_HOME || path.join(home, '.copilot'), 'mcp-config.json'), 'mcpServers',
      () => ({ type: 'local', ...stdio(), tools: ['*'] }), () => exists(process.env.COPILOT_HOME || path.join(home, '.copilot')) || has('copilot')),
    jsonAgent('Antigravity', path.join(home, '.gemini/config/mcp_config.json'), 'mcpServers', stdio,
      () => exists(path.join(home, '.gemini/config')) || has('agy')),
    jsonAgent('Cline', path.join(home, '.cline/data/settings/cline_mcp_settings.json'), 'mcpServers',
      () => ({ ...stdio(), timeout: 900 }), () => exists(path.join(home, '.cline')) || has('cline')),
    jsonAgent('Kiro', path.join(home, '.kiro/settings/mcp.json'), 'mcpServers', stdio, () => exists(path.join(home, '.kiro')) || has('kiro-cli')),
    jsonAgent('Qwen Code', path.join(home, '.qwen/settings.json'), 'mcpServers', () => ({ ...stdio(), timeout: 900000 }),
      () => exists(path.join(home, '.qwen')) || has('qwen')),
    jsonAgent('Factory Droid', path.join(home, '.factory/mcp.json'), 'mcpServers', () => ({ type: 'stdio', ...stdio() }),
      () => exists(path.join(home, '.factory')) || has('droid')),
    jsonAgent('Augment', path.join(home, '.augment/settings.json'), 'mcpServers', stdio, () => exists(path.join(home, '.augment')) || has('auggie')),
    jsonAgent('Amp', path.join(home, '.config/amp/settings.json'), 'amp.mcpServers', stdio, () => exists(path.join(home, '.config/amp')) || has('amp')),
    jsonAgent('Kilo Code', path.join(home, '.config/kilo/kilo.jsonc'), 'mcp', () => ({ type: 'local', command: [NODE, APP_ENTRY], enabled: true }),
      () => exists(path.join(home, '.config/kilo'))),
    jsonAgent('Zed', path.join(home, '.config/zed/settings.json'), 'context_servers', () => ({ ...stdio(), env: {} }),
      () => exists(path.join(home, '.config/zed'))),
    jsonAgent('Kimi Code', path.join(home, '.kimi-code/mcp.json'), 'mcpServers', () => ({ ...stdio(), toolTimeoutMs: 900000 }),
      () => exists(path.join(home, '.kimi-code'))),
    jsonAgent('Junie', path.join(home, '.junie/mcp/mcp.json'), 'mcpServers', stdio, () => exists(path.join(home, '.junie'))),
    jsonAgent('Warp', path.join(home, '.warp/.mcp.json'), 'mcpServers', stdio, () => exists(path.join(home, '.warp'))),
    jsonAgent('Rovo Dev', path.join(home, '.rovodev/mcp.json'), 'mcpServers', () => ({ ...stdio(), transport: 'stdio' }),
      () => exists(path.join(home, '.rovodev'))),
    jsonAgent('OpenHands', path.join(home, '.openhands/mcp.json'), 'mcpServers', stdio, () => exists(path.join(home, '.openhands'))),
    jsonAgent('LM Studio', path.join(home, '.lmstudio/mcp.json'), 'mcpServers', stdio, () => exists(path.join(home, '.lmstudio'))),
    jsonAgent('Windsurf', path.join(home, '.codeium/windsurf/mcp_config.json'), 'mcpServers', stdio, () => exists(path.join(home, '.codeium/windsurf'))),
    jsonAgent('Gemini CLI', path.join(home, '.gemini/settings.json'), 'mcpServers', stdio, () => exists(path.join(home, '.gemini')) || has('gemini')),
    jsonAgent('OpenCode', path.join(home, '.config/opencode/opencode.json'), 'mcp',
      () => ({ type: 'local', command: [NODE, APP_ENTRY], enabled: true }),
      () => (exists(path.join(home, '.config/opencode')) || has('opencode')) && !exists(path.join(home, '.config/opencode/opencode.jsonc'))),
    ...(appSupport ? [
      jsonAgent('VS Code', path.join(appSupport, 'Code/User/mcp.json'), 'servers',
        () => ({ type: 'stdio', ...stdio() }), () => exists(path.join(appSupport, 'Code/User'))),
      jsonAgent('VS Code Insiders', path.join(appSupport, 'Code - Insiders/User/mcp.json'), 'servers',
        () => ({ type: 'stdio', ...stdio() }), () => exists(path.join(appSupport, 'Code - Insiders/User'))),
      jsonAgent('Cline in VS Code', path.join(appSupport, 'Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json'), 'mcpServers',
        () => ({ ...stdio(), timeout: 900 }), () => exists(path.join(appSupport, 'Code/User/globalStorage/saoudrizwan.claude-dev'))),
      jsonAgent('Claude Desktop', path.join(appSupport, 'Claude/claude_desktop_config.json'), 'mcpServers', stdio,
        () => exists(path.join(appSupport, 'Claude'))),
    ] : []),
  ];

  function registerAgents() {
    const added = [];
    for (const agent of AGENTS) {
      let found = false;
      try { found = agent.detect(); } catch {}
      if (!found) continue;
      try {
        const result = agent.register();
        if (!result.name) { skip(`${agent.label}: ${result.manual}. See https://github.com/predotdev/mcp#setup-for-every-agent`); continue; }
        added.push(agent.label);
        const notes = [
          result.name === 'predev' ? '' : `as "${result.name}", since "predev" is taken`,
          result.replaced?.length ? `replaced ${result.replaced.map(n => `"${n}"`).join(', ')}` : '',
        ].filter(Boolean);
        ok(`${agent.label}${notes.length ? ` (${notes.join('; ')})` : ''}`);
      } catch (error) {
        skip(`${agent.label}: ${error.message}`);
      }
    }
    if (!added.length) skip('No coding agents found. Add it by hand: https://github.com/predotdev/mcp#setup-for-every-agent');
    return added;
  }

  // ------------------------------------------------------------------ Chrome

  async function connectChrome() {
    if (!fs.existsSync(path.join(chromeDir, 'Local State'))) return bad(`No Chrome data at ${chromeDir}. Install Google Chrome, then run this again.`);
    const portFile = path.join(chromeDir, 'DevToolsActivePort');
    if (!fs.existsSync(portFile)) {
      const address = 'chrome://inspect/#remote-debugging';
      // Chrome won't open chrome:// pages handed to it by another app, so put the address on the clipboard.
      let copied = false;
      if (!customChromeDir && process.platform === 'darwin') {
        copied = spawnSync('pbcopy', { input: address }).status === 0;
        spawnSync('open', ['-a', 'Google Chrome'], { stdio: 'ignore' });
      }
      console.log(`  Turn on remote debugging once: in Chrome, open ${address}${copied ? ' (copied: press ⌘L, ⌘V, Enter)' : ''} and switch it on.`);
      const wait = waiter('Waiting for remote debugging to be on');
      const end = Date.now() + 10 * 60000;
      while (!fs.existsSync(portFile) && Date.now() < end) { wait.tick(); await sleep(1000); }
      wait.done();
      if (!fs.existsSync(portFile)) return bad('Remote debugging is still off. Turn it on, then run this again.');
      ok('Remote debugging is on');
    }
    console.log('  Connecting. If Chrome asks "Allow remote debugging?", click Allow.');
    const end = Date.now() + 10 * 60000;
    const wait = waiter('Waiting for you to click Allow in Chrome');
    let result = null;
    while (Date.now() < end) {
      try {
        result = await request(await ensureDaemon(), 'POST', '/call', { name: 'chrome_profiles', args: {} });
      } catch (error) { result = { isError: true, content: [{ text: `Error: ${error.message}` }] }; }
      if (!result.isError || !/Allow remote debugging/.test(result.content?.[0]?.text || '')) break;
      wait.tick();
      await sleep(1000);
    }
    wait.done();
    const text = result?.content?.[0]?.text || '';
    if (result?.isError) return bad(text.replace(/^Error: /, ''));
    ok('Connected to Chrome. Your profiles:');
    console.log(text.split('\n').map(line => `      ${line}`).join('\n'));
  }

  // ------------------------------------------------------------------ commands

  // npx reuses a cached copy without checking for a newer one.
  async function newerVersion() {
    const latest = await fetch('https://registry.npmjs.org/@predotdev/mcp/latest', { signal: AbortSignal.timeout(5000) })
      .then(r => (r.ok ? r.json() : null)).then(d => d?.version).catch(() => null);
    const parts = v => String(v || '0').split('.').map(Number);
    const [a, b] = [parts(latest), parts(pkg.version)];
    for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) ? latest : null;
    return null;
  }

  async function setup() {
    console.log(`pre.dev MCP ${pkg.version || ''} setup`);
    // Re-running setup is how people update, so run the newest published version when this one is older.
    const latest = process.env.CHROME_MCP_NO_SELF_UPDATE ? null : await newerVersion();
    if (latest) {
      console.log(`  Version ${latest} is out; switching to it.`);
      const next = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['-y', '@predotdev/mcp@latest', 'setup'], {
        stdio: 'inherit', env: { ...process.env, CHROME_MCP_NO_SELF_UPDATE: '1' },
      });
      if (next.status !== null) process.exit(next.status);
      console.log('  Could not switch; continuing with this version.');
    }
    step(1, 'Install');
    installApp();
    step(2, 'Add to your coding agents');
    const added = registerAgents();
    step(3, 'Connect to Chrome');
    await connectChrome();
    step(4, 'Sign in to pre.dev (optional: plain-words actions and cloud tools)');
    await ensureSignedIn();
    console.log(failed ? '\nFix the ✗ items above, then run this again (it is safe to repeat).'
      : `\nAll set.${added.length ? ` Restart ${added.length > 4 ? `your agents (${added.length} set up above)` : added.join(', ')} so ${added.length === 1 ? 'it loads' : 'they load'} the new server,` : ''} then ask your agent:\n  "List my Chrome profiles and the tabs I have open."`);
    process.exit(failed ? 1 : 0);
  }

  async function login() {
    console.log('Sign in to pre.dev');
    await ensureSignedIn(true);
    process.exit(failed ? 1 : 0);
  }

  function logout() {
    fs.rmSync(credentialsFile, { force: true });
    console.log(cliLogin()
      ? 'Deleted the saved pre.dev key. You are still signed in through the pre.dev CLI; run `predev logout` to sign out there too.'
      : 'Signed out: the saved pre.dev key is deleted. Plain-words actions are off until you run login again.');
  }

  async function uninstall() {
    console.log('Removing the pre.dev MCP');
    for (const agent of AGENTS) {
      let found = false;
      try { found = agent.detect(); } catch {}
      if (!found) continue;
      try { if (agent.unregister()) ok(`Removed from ${agent.label}`); } catch (error) { skip(`${agent.label}: ${error.message}`); }
    }
    // Every daemon it runs (one per Chrome data dir), then everything it keeps in ~/.predev/mcp:
    // the stable copy, the saved key, logs and the cached profile list (names and emails).
    const subdirs = (() => { try { return fs.readdirSync(baseStateDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => path.join(baseStateDir, d.name)); } catch { return []; } })();
    const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };
    for (const dir of new Set([stateDir, baseStateDir, ...subdirs])) {
      const state = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'daemon.json'), 'utf8')); } catch { return null; } })();
      // A stopped daemon's port may belong to something else now.
      if (!state || !state.pid || !alive(state.pid)) continue;
      await request(state, 'POST', '/shutdown', {}, 3000).catch(() => {});
      // It exits just after answering; wait, so its last log line can't recreate the folder.
      for (let i = 0; i < 30 && state.pid && alive(state.pid); i++) await sleep(100);
    }
    fs.rmSync(baseStateDir, { recursive: true, force: true });
    ok('Stopped it and deleted its files and saved key');
    console.log('\nDone. Restart your agents. To also turn off remote debugging, open chrome://inspect/#remote-debugging.');
  }

  return { setup, login, logout, uninstall, installApp };
}
