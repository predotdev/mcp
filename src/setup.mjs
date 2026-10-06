// One-command setup for pre.dev Browser Agents Local, plus login, logout and uninstall.
//
//   chrome-mcp setup      sign in to pre.dev, install a stable copy, add it to every coding agent
//                         found on this computer, and connect to Chrome
//   chrome-mcp login      sign in again (saves the key for every agent)
//   chrome-mcp logout     forget the saved key
//   chrome-mcp uninstall  remove it from every agent, stop it, and delete its files
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
const OWN = /chrome-mcp/; // every way of running this package has it in its command or args
const NAMES = ['chrome', 'predev-chrome'];

export function createSetup(ctx) {
  const { baseStateDir, stateDir, chromeDir, customChromeDir, pkg, sleep, ensureDaemon, request, readCredentials, credentialsFile, packageRoot } = ctx;
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
  const run = (bin, args) => spawnSync(bin, args, { encoding: 'utf8', timeout: 30000 });

  // ------------------------------------------------------------------ sign in

  const apiUrl = () => (process.env.PREDEV_API_URL || readCredentials().apiUrl || 'https://api.pre.dev').replace(/\/+$/, '');

  async function keyWorks(key, url) {
    if (!key) return false;
    const status = await fetch(`${url}/v1/usage?days=1`, { headers: { Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(15000) })
      .then(r => r.status).catch(() => 0);
    return status === 200;
  }

  function saveKey(apiKey, url) {
    fs.mkdirSync(baseStateDir, { recursive: true, mode: 0o700 });
    const tmp = `${credentialsFile}.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify({ apiKey, apiUrl: url, savedAt: new Date().toISOString() }, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, credentialsFile);
  }

  // The pre.dev CLI's short-code sign-in: approve in the browser, the key comes back here.
  async function signIn() {
    const url = apiUrl();
    const verifier = crypto.randomBytes(32).toString('base64url');
    const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
    const state = crypto.randomBytes(16).toString('base64url');
    const start = await fetch(`${url}/oauth/device/authorize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        client_id: CLIENT_ID, code_challenge: challenge, code_challenge_method: 'S256', state, scope: 'mcp',
        device_os: { darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform] || process.platform,
        device_host: os.hostname(), cli_version: `chrome-mcp ${pkg.version || ''}`.trim(),
      }),
    }).then(async r => (r.ok ? r.json() : Promise.reject(new Error(`pre.dev answered ${r.status}`))));
    const link = start.verification_uri_complete;
    const opened = await openUrl(link);
    console.log(`  ${opened ? 'Opened pre.dev in your browser.' : 'Open this link in your browser:'} Sign in (or create a free account) and approve.`);
    if (opened) console.log(`  If nothing opened: ${link}`);
    else console.log(`  ${link}`);
    console.log(`  Your code: ${start.user_code}`);
    const end = Date.now() + (start.expires_in || 600) * 1000;
    const wait = waiter('Waiting for you to approve in the browser');
    let code = null;
    while (Date.now() < end && !code) {
      wait.tick();
      await sleep((start.interval || 2) * 1000);
      const poll = await fetch(`${url}/oauth/cli/poll?state=${encodeURIComponent(state)}`, { signal: AbortSignal.timeout(15000) })
        .then(r => r.json()).catch(() => ({ pending: true }));
      if (poll.error) { wait.done(); throw new Error(poll.error === 'access_denied' ? 'Sign-in was denied in the browser.' : `Sign-in failed: ${poll.error}`); }
      if (poll.code) code = poll.code;
    }
    wait.done();
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
    }
    try {
      await signIn();
      ok(`Signed in. Your key is saved in ${credentialsFile.replace(home, '~')} for every agent.`);
    } catch (error) {
      bad(`${error.message} Plain-words actions stay off until you run: npx -y @predotdev/chrome-mcp login`);
    }
  }

  // ------------------------------------------------------------------ stable copy

  function installApp() {
    if (path.resolve(packageRoot) === path.resolve(APP_DIR)) return ok(`Installed in ${APP_DIR.replace(home, '~')}`);
    fs.mkdirSync(path.join(APP_DIR, 'src'), { recursive: true });
    for (const file of ['src/bridge.mjs', 'src/tools.mjs', 'src/setup.mjs', 'package.json', 'LICENSE', 'README.md']) {
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

  // Picks "chrome", or "predev-chrome" when another tool already uses "chrome". Never touches others.
  function pickName(entries) {
    const mine = NAMES.find(name => entries[name] && OWN.test(JSON.stringify(entries[name])));
    if (mine) return mine;
    return NAMES.find(name => !entries[name]) || null;
  }

  function jsonAgent(label, file, key, entry, detect) {
    return {
      label, detect,
      register() {
        let config = {};
        const existed = fs.existsSync(file);
        if (existed) {
          try { config = JSON.parse(fs.readFileSync(file, 'utf8') || '{}'); } catch {
            return { manual: `couldn't read ${file.replace(home, '~')} (comments or invalid JSON); add the server by hand` };
          }
        }
        config[key] ??= {};
        const name = pickName(config[key]);
        if (!name) return { manual: `"chrome" and "predev-chrome" are taken in ${file.replace(home, '~')}` };
        config[key][name] = entry();
        fs.mkdirSync(path.dirname(file), { recursive: true });
        if (existed && !fs.existsSync(`${file}.bak-chrome-mcp`)) fs.copyFileSync(file, `${file}.bak-chrome-mcp`);
        const tmp = `${file}.${process.pid}`;
        fs.writeFileSync(tmp, `${JSON.stringify(config, null, 2)}\n`);
        fs.renameSync(tmp, file);
        return { name };
      },
      unregister() {
        if (!fs.existsSync(file)) return 0;
        let config;
        try { config = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return 0; }
        let removed = 0;
        for (const name of NAMES) {
          if (config?.[key]?.[name] && OWN.test(JSON.stringify(config[key][name]))) { delete config[key][name]; removed++; }
        }
        if (removed) fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
        return removed;
      },
    };
  }

  const stdio = () => ({ command: NODE, args: [APP_ENTRY] });
  const appSupport = process.platform === 'darwin' ? path.join(home, 'Library/Application Support') : null;
  const exists = p => fs.existsSync(p);

  // What a CLI-managed agent already has under our names (its own description of each entry).
  const cliEntries = bin => {
    const entries = {};
    for (const name of NAMES) {
      const got = run(bin, bin === 'codex' ? ['mcp', 'get', name, '--json'] : ['mcp', 'get', name]);
      if (got.status === 0) entries[name] = got.stdout;
    }
    return entries;
  };

  const AGENTS = [
    {
      label: 'Claude Code', detect: () => has('claude'),
      register() {
        const entries = cliEntries('claude');
        const name = pickName(entries);
        if (!name) return { manual: '"chrome" and "predev-chrome" are taken' };
        if (entries[name]) run('claude', ['mcp', 'remove', name, '-s', 'user']);
        const added = run('claude', ['mcp', 'add', '--scope', 'user', name, '--', NODE, APP_ENTRY]);
        return added.status === 0 ? { name } : { manual: (added.stderr || added.stdout || 'claude mcp add failed').trim().split('\n')[0] };
      },
      unregister() {
        let removed = 0;
        for (const name of NAMES) {
          const got = run('claude', ['mcp', 'get', name]);
          if (got.status === 0 && OWN.test(got.stdout)) { run('claude', ['mcp', 'remove', name, '-s', 'user']); removed++; }
        }
        return removed;
      },
    },
    {
      label: 'Codex', detect: () => has('codex'),
      register() {
        const entries = cliEntries('codex');
        const name = pickName(entries);
        if (!name) return { manual: '"chrome" and "predev-chrome" are taken' };
        if (entries[name]) run('codex', ['mcp', 'remove', name]);
        const added = run('codex', ['mcp', 'add', name, '--', NODE, APP_ENTRY]);
        if (added.status !== 0) return { manual: (added.stderr || added.stdout || 'codex mcp add failed').trim().split('\n')[0] };
        // Slow pages need more than Codex's default tool timeout.
        const file = path.join(process.env.CODEX_HOME || path.join(home, '.codex'), 'config.toml');
        try {
          const lines = fs.readFileSync(file, 'utf8').split('\n');
          const at = lines.findIndex(line => line.trim() === `[mcp_servers.${name}]`);
          let end = lines.findIndex((line, i) => i > at && /^\s*\[/.test(line));
          if (end < 0) end = lines.length;
          if (at >= 0 && !lines.slice(at, end).some(line => /^\s*tool_timeout_sec\s*=/.test(line))) {
            lines.splice(at + 1, 0, 'tool_timeout_sec = 120');
            fs.writeFileSync(file, lines.join('\n'));
          }
        } catch {}
        return { name };
      },
      unregister() {
        let removed = 0;
        for (const name of NAMES) {
          const got = run('codex', ['mcp', 'get', name, '--json']);
          if (got.status === 0 && OWN.test(got.stdout)) { run('codex', ['mcp', 'remove', name]); removed++; }
        }
        return removed;
      },
    },
    jsonAgent('Cursor', path.join(home, '.cursor/mcp.json'), 'mcpServers', stdio, () => exists(path.join(home, '.cursor'))),
    jsonAgent('Windsurf', path.join(home, '.codeium/windsurf/mcp_config.json'), 'mcpServers', stdio, () => exists(path.join(home, '.codeium/windsurf'))),
    jsonAgent('Gemini CLI', path.join(home, '.gemini/settings.json'), 'mcpServers', stdio, () => exists(path.join(home, '.gemini')) || has('gemini')),
    jsonAgent('OpenCode', path.join(home, '.config/opencode/opencode.json'), 'mcp',
      () => ({ type: 'local', command: [NODE, APP_ENTRY], enabled: true }),
      () => (exists(path.join(home, '.config/opencode')) || has('opencode')) && !exists(path.join(home, '.config/opencode/opencode.jsonc'))),
    ...(appSupport ? [
      jsonAgent('VS Code', path.join(appSupport, 'Code/User/mcp.json'), 'servers',
        () => ({ type: 'stdio', ...stdio() }), () => exists(path.join(appSupport, 'Code/User'))),
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
        if (result.name) { added.push(agent.label); ok(`${agent.label}${result.name === 'chrome' ? '' : ` (as "${result.name}", since "chrome" is taken)`}`); }
        else skip(`${agent.label}: ${result.manual}. See https://github.com/predotdev/chrome-mcp#setup-for-every-agent`);
      } catch (error) {
        skip(`${agent.label}: ${error.message}`);
      }
    }
    if (!added.length) skip('No coding agents found. Add it by hand: https://github.com/predotdev/chrome-mcp#setup-for-every-agent');
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
    const latest = await fetch('https://registry.npmjs.org/@predotdev/chrome-mcp/latest', { signal: AbortSignal.timeout(5000) })
      .then(r => (r.ok ? r.json() : null)).then(d => d?.version).catch(() => null);
    const parts = v => String(v || '0').split('.').map(Number);
    const [a, b] = [parts(latest), parts(pkg.version)];
    for (let i = 0; i < 3; i++) if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0) ? latest : null;
    return null;
  }

  async function setup() {
    console.log(`pre.dev Browser Agents Local ${pkg.version || ''} setup`);
    // Re-running setup is how people update, so run the newest published version when this one is older.
    const latest = process.env.CHROME_MCP_NO_SELF_UPDATE ? null : await newerVersion();
    if (latest) {
      console.log(`  Version ${latest} is out; switching to it.`);
      const next = spawnSync(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['-y', '@predotdev/chrome-mcp@latest', 'setup'], {
        stdio: 'inherit', env: { ...process.env, CHROME_MCP_NO_SELF_UPDATE: '1' },
      });
      if (next.status !== null) process.exit(next.status);
      console.log('  Could not switch; continuing with this version.');
    }
    step(1, 'Sign in to pre.dev');
    await ensureSignedIn();
    step(2, 'Install');
    installApp();
    step(3, 'Add to your coding agents');
    const added = registerAgents();
    step(4, 'Connect to Chrome');
    await connectChrome();
    console.log(failed ? '\nFix the ✗ items above, then run this again (it is safe to repeat).'
      : `\nAll set.${added.length ? ` Restart ${added.join(', ')} so ${added.length === 1 ? 'it loads' : 'they load'} the new server,` : ''} then ask your agent:\n  "List my Chrome profiles and the tabs I have open."`);
    process.exit(failed ? 1 : 0);
  }

  async function login() {
    console.log('Sign in to pre.dev');
    await ensureSignedIn(true);
    process.exit(failed ? 1 : 0);
  }

  function logout() {
    fs.rmSync(credentialsFile, { force: true });
    console.log('Signed out: the saved pre.dev key is deleted. Plain-words actions are off until you run login again.');
  }

  async function uninstall() {
    console.log('Removing pre.dev Browser Agents Local');
    for (const agent of AGENTS) {
      let found = false;
      try { found = agent.detect(); } catch {}
      if (!found) continue;
      try { if (agent.unregister()) ok(`Removed from ${agent.label}`); } catch (error) { skip(`${agent.label}: ${error.message}`); }
    }
    const state = (() => { try { return JSON.parse(fs.readFileSync(path.join(stateDir, 'daemon.json'), 'utf8')); } catch { return null; } })();
    if (state) await request(state, 'POST', '/shutdown', {}, 3000).catch(() => {});
    fs.rmSync(APP_DIR, { recursive: true, force: true });
    fs.rmSync(credentialsFile, { force: true });
    ok('Stopped it and deleted its files and saved key');
    console.log('\nDone. Restart your agents. To also turn off remote debugging, open chrome://inspect/#remote-debugging.');
  }

  return { setup, login, logout, uninstall };
}
