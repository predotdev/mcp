// The user's computer, one channel: pre.dev web runs reach the Chrome on this computer ("Do it in
// my Chrome"), only after the user paired it (`predev-mcp pair`, with PREDEV_HANDOFF=1). The daemon
// holds one tunnel to pre.dev's edge for the paired account; a web run that person typed sends its
// chrome_* calls down it, and they run here, in this Chrome, with this computer's rules:
//
//   - the guard is always on (handoffs on, whatever the calling agent's flags): the run works only
//     in tabs it opened, never types into password, code or card fields, and asks first before a
//     click that sends, posts, buys or deletes;
//   - a site a web run has not used here before needs a click on this computer: a pre.dev page in
//     this Chrome asks "Allow pre.dev to use <site>?", and only the person at this computer can
//     answer it (the page's address carries a one-time secret no run ever sees). A site is a
//     registrable domain (accounts.google.com and mail.google.com ask once), by the same rule as
//     every pre.dev `site`: pre.dev computes it from the host alone, never a URL. The allowed list
//     is listed and revoked here (`predev-mcp sites`) and on pre.dev, at once;
//   - "Finish on my computer": a paused cloud Browser Agents task can hand its rest here (the
//     instruction, the page it stopped on and what it did). pre.dev's cloud then carries it on by
//     itself in the tab opened for it: its planner stays in the cloud and sends one chrome_* call at a
//     time (POST /tasks/call), under the same rules plus a screenshot of that tab only. An agent on
//     this computer may take the task over instead (chrome_handed_off): one of them drives at a time;
//   - only the tools a web run needs: no scripts (chrome_eval could read a site's cookies or
//     storage), no file uploads (files on this computer), no screenshots;
//   - nothing else leaves this computer: no cookies, no storage, no files.
//
// Unpair (`predev-mcp unpair`) stops all of it at once, here and at pre.dev.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** What a web run may call here (pre.dev's backend has the same list). chrome_handoff is the
 *  handoff itself (bring the tab forward, check, wait, release, take back after the user). */
const WEB_TOOLS = new Set(['chrome_profiles', 'chrome_tabs', 'chrome_open', 'chrome_navigate', 'chrome_snapshot', 'chrome_click',
  'chrome_type', 'chrome_act', 'chrome_press', 'chrome_scroll', 'chrome_read', 'chrome_wait', 'chrome_show', 'chrome_close']);
const HANDOFF_TOOL = 'chrome_handoff';
/** What pre.dev's cloud run of a handed task may call here ("Finish on my computer"): a web run's tools
 *  minus the tab list and profile list, plus a screenshot of its own tab (its planner looks at the page).
 *  Still no scripts and no uploads. */
const TASK_TOOLS = new Set(['chrome_open', 'chrome_navigate', 'chrome_snapshot', 'chrome_click', 'chrome_type', 'chrome_press',
  'chrome_scroll', 'chrome_read', 'chrome_wait', 'chrome_screenshot']);
/** Tools that can take a tab to another page: the page they end on is checked too. */
const MOVES = new Set(['chrome_open', 'chrome_navigate', 'chrome_click', 'chrome_act', 'chrome_press', 'chrome_type', 'chrome_handoff']);
const PING_MS = 15000;
/** How long a call waits for the person at this computer to allow a new site. */
const ALLOW_WAIT_MS = 120000;
const FRAME_BODY = 1;
const CHUNK = 256 * 1024;

const isPage = t => t?.type === 'page';

/** An http(s) page's host, or '' (other schemes are never a web run's). */
export function hostOf(url) {
  let u;
  try { u = new URL(String(url)); } catch { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  return u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}
/** This machine or a private network: the Allow page warns about these. */
const isLocalHost = host => host === 'localhost' || host.endsWith('.localhost') || /^(127|10)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^::1$|^0\.0\.0\.0$/.test(host);

/** This computer's id for pre.dev in a state folder: random, made once, not a secret. */
export function computerIdIn(stateDir) {
  const file = path.join(stateDir, 'computer.json');
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (/^[a-f0-9]{32}$/.test(saved?.id || '')) return saved.id;
  } catch {}
  const id = crypto.randomBytes(16).toString('hex');
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ id }), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return id;
}

/** The files pairing keeps in a state folder: the pairing itself, the sites web runs may use, and the
 *  cloud tasks handed here to finish ("Finish on my computer"). */
export const pairingFiles = stateDir => ({
  pairing: path.join(stateDir, 'pairing.json'),
  sites: path.join(stateDir, 'web-sites.json'),
  tasks: path.join(stateDir, 'handed-tasks.json'),
});

/** The sites this computer allowed web runs to use, from its state folder (newest last). */
export function readAllowedSites(stateDir) {
  try { return JSON.parse(fs.readFileSync(pairingFiles(stateDir).sites, 'utf8'))?.sites || {}; } catch { return {}; }
}

/** Forget one allowed site here, at once (a running daemon reads the file on every call). */
export function forgetAllowedSite(stateDir, site) {
  const sites = readAllowedSites(stateDir);
  if (!sites[site]) return false;
  delete sites[site];
  const file = pairingFiles(stateDir).sites;
  const tmp = `${file}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ sites }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
  return true;
}

const escapeHtml = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export function createChannel(ctx) {
  const { stateDir, chromeDir, chrome, log, sleep, callTool, loadTools, privateTabs, readCredentials, cliLogin, defaultApiUrl } = ctx;
  const { pairing: PAIRING_FILE, sites: SITES_FILE, tasks: TASKS_FILE } = pairingFiles(stateDir);
  let ws = null;
  let running = false;
  let status = 'off';
  let pingTimer = null;
  let wake = null;
  /** One question per site at a time: site -> { nonce, decided, waiters, targetId }. */
  const asking = new Map();
  const byNonce = new Map();
  /** Cloud runs of handed tasks: calls in flight per task (chrome_handed_off waits for them on a take-over). */
  const RUNS = chrome.__predevHandedRuns || (chrome.__predevHandedRuns = { inflight: new Map() });
  const APPROVED = chrome.__predevApproved || (chrome.__predevApproved = new Map());

  const readJson = file => { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } };
  const writePrivate = (file, value) => {
    const tmp = `${file}.${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, file);
  };

  const computerId = () => computerIdIn(stateDir);
  const pairing = () => readJson(PAIRING_FILE);
  // The key this computer signs in with: the saved one, else the pre.dev CLI's login.
  const key = () => String(readCredentials().apiKey || cliLogin() || '').trim();

  async function post(apiUrl, route, body) {
    const res = await fetch(`${apiUrl.replace(/\/+$/, '')}${route}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key()}`, 'Content-Type': 'application/json', 'x-predev-client': 'predev-mcp' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(20000),
    });
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }

  // ---------------------------------------------------------------- sites a web run may use

  const allowedSites = () => readJson(SITES_FILE)?.sites || {};
  const isAllowed = site => !!site && !!allowedSites()[site];
  function allow(site) {
    const sites = allowedSites();
    sites[site] = { allowedAt: new Date().toISOString() };
    writePrivate(SITES_FILE, { sites });
    // pre.dev keeps the list too, to show it and to revoke from the web. Only this click adds one.
    const p = pairing();
    if (p?.apiUrl) void post(p.apiUrl, '/computer-channel/sites', { computerId: computerId(), site }).catch(error => log('channel', 'site note failed', error.message));
  }
  /** pre.dev's list at (re)connect: a site revoked there while this computer was away drops here. */
  function keepOnly(sitesAtPredev) {
    if (!Array.isArray(sitesAtPredev)) return;
    const keep = new Set(sitesAtPredev.map(String));
    const sites = allowedSites();
    let dropped = 0;
    for (const site of Object.keys(sites)) if (!keep.has(site)) { delete sites[site]; dropped++; }
    if (dropped) { writePrivate(SITES_FILE, { sites }); log('channel', `dropped ${dropped} site(s) revoked at pre.dev`); }
  }

  /** The registrable domain of a host, as pre.dev computes every site (tldts, private suffixes
   *  included). Asked with the host alone, cached; if pre.dev can't be asked, the host itself
   *  (stricter: it never lets one click cover more). */
  const siteCache = new Map();
  async function siteFor(host) {
    if (!host) return '';
    if (siteCache.has(host)) return siteCache.get(host);
    let site = host.replace(/^www\./, '');
    const p = pairing();
    try {
      const res = await fetch(`${String(p?.apiUrl || defaultApiUrl).replace(/\/+$/, '')}/computer-channel/site?host=${encodeURIComponent(host)}`, {
        headers: { Authorization: `Bearer ${key()}`, 'x-predev-client': 'predev-mcp' }, signal: AbortSignal.timeout(8000),
      });
      const json = await res.json().catch(() => ({}));
      if (res.ok && typeof json.site === 'string' && json.site && host.endsWith(json.site)) {
        site = json.site;
        siteCache.set(host, site);
        if (siteCache.size > 2000) siteCache.delete(siteCache.keys().next().value);
      }
    } catch {}
    return site;
  }

  /** The page that asks the person at this computer. Its address carries the one-time secret. */
  function askPage(entry, port) {
    const site = escapeHtml(entry.site);
    const local = isLocalHost(entry.site);
    return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Allow pre.dev to use ${site}?</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0d0d;color:#cfd3da;font:15px/1.55 ui-sans-serif,system-ui,-apple-system,sans-serif}
main{max-width:480px;padding:28px}h1{font-size:18px;color:#fff;margin:0 0 10px}p{margin:0 0 12px;color:#9aa3b2}b{color:#fff}
.row{display:flex;gap:10px;margin-top:20px}button{font:inherit;font-weight:600;border-radius:8px;padding:9px 16px;cursor:pointer;border:1px solid #333}
.yes{background:#fff;color:#000;border-color:#fff}.no{background:transparent;color:#cfd3da}.warn{color:#f5c26b}</style></head>
<body><main><h1>Allow pre.dev to use <b>${site}</b> in this Chrome?</h1>
<p>A pre.dev run you started on the web wants to work on <b>${site}</b> here, signed in as you. It reads and clicks only in tabs it opens.</p>
<p>It never types passwords, codes or card numbers, and it asks you before it sends, posts, buys or deletes anything.</p>
${local ? '<p class="warn">This address is on this computer or your own network. Only allow it if you expect the run to use it.</p>' : ''}
<p>Only allow sites you expect. You can stop all of it with: npx -y @predotdev/mcp unpair</p>
<form method="post" action="/allow/${entry.nonce}" class="row">
<button class="yes" name="decision" value="allow" type="submit">Allow</button>
<button class="no" name="decision" value="deny" type="submit">Don't allow</button>
</form></main></body></html>`;
  }

  const donePage = allowed => `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>pre.dev</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0d0d;color:#cfd3da;font:15px/1.5 ui-sans-serif,system-ui,sans-serif}</style></head>
<body><p>${allowed ? 'Allowed. pre.dev carries on, and this tab closes.' : "Not allowed. pre.dev won't use this site here."}</p></body></html>`;

  /** The daemon's HTTP server hands these here first: the question page and its answer. They
   *  carry no daemon token (a page in Chrome can't); the one-time secret in the address is the key. */
  async function handleHttp(req, res, port) {
    const m = /^\/allow\/([A-Za-z0-9_-]{20,64})$/.exec(req.url || '');
    if (!m) return false;
    const entry = byNonce.get(m[1]);
    const send = (status, html) => { res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-frame-options': 'DENY' }); res.end(html); };
    if (!entry || entry.decided) { send(410, donePage(false)); return true; }
    if (req.method === 'GET') { send(200, askPage(entry, port)); return true; }
    if (req.method !== 'POST') { send(405, ''); return true; }
    // Only the page itself answers: the same origin, a form the person submitted.
    const origin = String(req.headers.origin || '');
    if (origin !== `http://127.0.0.1:${port}` || String(req.headers['sec-fetch-site'] || '') !== 'same-origin') { send(403, donePage(false)); return true; }
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 1000) break; }
    const decision = new URLSearchParams(body).get('decision');
    decide(entry, decision === 'allow');
    send(200, donePage(decision === 'allow'));
    return true;
  }

  function decide(entry, allowed) {
    if (entry.decided) return;
    entry.decided = allowed ? 'allow' : 'deny';
    if (allowed) allow(entry.site);
    log('channel', `site ${entry.site} ${entry.decided}`);
    for (const w of entry.waiters.splice(0)) w(allowed);
    asking.delete(entry.site);
    setTimeout(() => {
      byNonce.delete(entry.nonce);
      if (entry.targetId) chrome.send('Target.closeTarget', { targetId: entry.targetId }).catch(() => {});
      privateTabs.delete(entry.targetId);
    }, allowed ? 1500 : 4000);
  }

  /** Ask the person at this computer to allow a site for web runs. true once allowed. */
  async function askToAllow(site, port, inFront) {
    if (isAllowed(site)) return true;
    let entry = asking.get(site);
    if (!entry) {
      entry = { site, nonce: crypto.randomBytes(24).toString('base64url'), decided: null, waiters: [], targetId: null };
      asking.set(site, entry);
      byNonce.set(entry.nonce, entry);
      try {
        await chrome.connect();
        const front = await inFront().catch(() => true);
        const { targetId } = await chrome.send('Target.createTarget', { url: `http://127.0.0.1:${port}/allow/${entry.nonce}`, background: !front });
        entry.targetId = targetId;
        // pre.dev's own tab: no agent may read or act in it.
        privateTabs.add(targetId);
        log('channel', `asked to allow ${site}`);
        // Brought forward only once Chrome is the app in front, so it never takes the keyboard.
        if (!front) void (async () => {
          for (let i = 0; i < ALLOW_WAIT_MS / 1000 && !entry.decided; i++) {
            await sleep(1000);
            if (await inFront().catch(() => false)) { await chrome.send('Target.activateTarget', { targetId }).catch(() => {}); return; }
          }
        })();
      } catch (error) {
        asking.delete(site);
        byNonce.delete(entry.nonce);
        throw new Error(`Could not ask on this computer: ${error.message}`);
      }
    }
    const answer = await new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), ALLOW_WAIT_MS);
      entry.waiters.push(v => { clearTimeout(timer); resolve(v); });
    });
    // Nobody answered: the question goes away, the next call asks again.
    if (answer === null && !entry.decided) {
      entry.decided = 'timeout';
      asking.delete(site);
      byNonce.delete(entry.nonce);
      if (entry.targetId) chrome.send('Target.closeTarget', { targetId: entry.targetId }).catch(() => {});
      privateTabs.delete(entry.targetId);
    }
    return answer === true;
  }

  // ---------------------------------------------------------------- the calls a web run makes

  function tabInfo(tab) {
    const wanted = String(tab || '').trim().toUpperCase();
    if (!wanted) return null;
    const hits = [...chrome.targets.values()].filter(t => isPage(t) && t.targetId.toUpperCase().startsWith(wanted));
    return hits.length === 1 ? hits[0] : null;
  }

  const text = (t, isError = true) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
  /** A refusal a cloud run acts on (tools.mjs Refused): the same words, plus what it was for. */
  const refusedText = (t, refusal) => ({ ...text(t), refusal });
  const notAllowed = site => text(`The user didn't allow web runs to use ${site} in their Chrome (pre.dev asks on their computer the first time a web run uses a site). Don't retry on your own: tell them in one line what you need from ${site}, and continue with what you have.`);

  /** One call from a web run. `run.key` names the run, so its tabs are its own. */
  async function webCall(body, port, api) {
    const name = String(body?.name || '');
    if (!WEB_TOOLS.has(name) && name !== HANDOFF_TOOL) return text(`${name || 'That tool'} isn't available to web runs in the user's Chrome.`);
    const args = {};
    for (const [k, v] of Object.entries(body?.args || {})) if (!k.startsWith('__')) args[k] = v;
    // The sign-ins this run's handoffs made, kept here too (handoff rule 3), and the ones the user's
    // own messages asked to give up: pre.dev's brain works these out, never the model.
    for (const k of ['__predev_signed_in', '__predev_signout_ok']) {
      if (Array.isArray(body?.args?.[k])) args[k] = body.args[k].filter(x => typeof x === 'string').slice(0, 50).map(x => x.slice(0, 255));
    }
    const runKey = String(body?.run?.key || '').replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 100);
    if (!runKey) return text('A web run must say which run it is.');
    // This computer's rules for every web run: the guard on, the run's own tabs.
    args.__agent = runKey.startsWith('web:') ? runKey : `web:${runKey}`;
    args.__predev_handoff = true;
    args.__via = 'web';
    if (args.tab && privateTabs.has(tabInfo(args.tab)?.targetId)) return text("That tab is pre.dev's own question to the user; no run can use it.");
    const blocked = await sitesAllowed(name, args, body, port, api);
    if (blocked) return blocked;
    const timeoutMs = Math.min(Math.max(Number(body?.timeoutMs) || 180000, 5000), 11 * 60000);
    const signal = AbortSignal.timeout(timeoutMs);
    const result = await callTool(name, args, { apiKey: key(), apiUrl: (pairing()?.apiUrl || defaultApiUrl), signal });
    return (await movedTo(name, args, result)) || result;
  }

  /** A new site needs a click here first: where the call goes, and where the tab is now. null when allowed. */
  async function sitesAllowed(name, args, body, port, api) {
    const wanted = [];
    if ((name === 'chrome_open' || name === 'chrome_navigate') && args.url && !['back', 'forward', 'reload'].includes(args.url)) {
      const raw = String(args.url);
      const host = hostOf(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
      if (!host) return text('Web runs can open only http and https pages in the user\'s Chrome.');
      // pre.dev computed the target's site with the call (the same rule); only what matches this host counts.
      const given = typeof body?.site === 'string' && body.site && host.endsWith(body.site) ? body.site : '';
      wanted.push(given || await siteFor(host));
    }
    const info = args.tab ? tabInfo(args.tab) : null;
    if (info) { const here = await siteFor(hostOf(info.url)); if (here && !wanted.includes(here)) wanted.push(here); }
    for (const site of wanted) {
      if (isAllowed(site)) continue;
      const ok = await askToAllow(site, port, api.chromeInFront);
      if (!ok) return { ...notAllowed(site), refusal: { kind: 'not_allowed', site } };
    }
    return null;
  }

  /** The page a call ended on must be allowed too: else its text never leaves this computer. */
  async function movedTo(name, args, result) {
    if (!MOVES.has(name) || result?.isError) return null;
    const shown = (result?.content || []).find(c => c.type === 'text')?.text || '';
    const tab = /^Tab ([0-9A-F]{6,}) ·/m.exec(shown)?.[1] || args.tab;
    const now = tab ? tabInfo(tab) : null;
    const site = now ? await siteFor(hostOf(now.url)) : '';
    if (site && !isAllowed(site)) {
      return text(`Tab ${tab} is now on ${site}, which web runs haven't used in the user's Chrome yet, so its page isn't shown. The next call on this tab asks the user to allow ${site} on their computer.`, false);
    }
    return null;
  }

  // ---------------------------------------------------------------- a handed task, carried on by pre.dev's cloud

  const handedTasks = () => readJson(TASKS_FILE)?.tasks || [];
  const handedTask = taskId => handedTasks().find(t => t.taskId === taskId) || null;
  const cleanTaskId = v => String(v || '').replace(/[^a-f0-9]/gi, '').slice(0, 40);

  /** One call from pre.dev's cloud run of a task handed here. It drives only the tabs it opened for that task
   *  (the one opened at hand-off, and its popups), with this computer's rules, and only while no agent here took
   *  the task over. */
  async function taskCall(body, port, api) {
    const taskId = cleanTaskId(body?.taskId);
    const name = String(body?.name || '');
    const t = taskId ? handedTask(taskId) : null;
    if (!t) return refusedText('This task is not handed to this computer any more.', { kind: 'taken_over' });
    if (t.driver !== 'cloud') return refusedText('An agent on this computer has this task now.', { kind: 'taken_over' });
    if (name === 'ping') return text('ok', false);
    const agent = `handed:${taskId}`;
    const args = {};
    for (const [k, v] of Object.entries(body?.args || {})) if (!k.startsWith('__')) args[k] = v;
    for (const k of ['__predev_signed_in', '__predev_signout_ok']) {
      if (Array.isArray(body?.args?.[k])) args[k] = body.args[k].filter(x => typeof x === 'string').slice(0, 50).map(x => x.slice(0, 255));
    }
    args.__agent = agent;
    args.__predev_handoff = true;
    args.__via = 'web';
    // The hand-back of the tab after the user had it (a card's Done): nothing else of chrome_handoff.
    if (name === HANDOFF_TOOL) {
      if (!args.tab || args.reason !== 'user_control' || args.resume !== true) return text('Only the hand-back of the tab is available to this run.');
      return callTool(HANDOFF_TOOL, { tab: args.tab, reason: 'user_control', resume: true, __agent: agent, __predev_handoff: true, __via: 'web' }, { apiKey: key(), apiUrl: pairing()?.apiUrl || defaultApiUrl });
    }
    if (!TASK_TOOLS.has(name)) return text(`${name || 'That tool'} isn't available to pre.dev's cloud run of this task.`);
    if (args.tab) {
      const info = tabInfo(args.tab);
      if (!info) return refusedText(`Tab ${String(args.tab).slice(0, 12)} is closed.`, { kind: 'tab_closed' });
      if (privateTabs.has(info.targetId)) return refusedText("That tab is pre.dev's own question to the user; no run can use it.", { kind: 'scope' });
      // The tab opened for this task stays this run's, also after this daemon restarted (the list on disk says so).
      const H = chrome.__predevHandoff;
      if (H?.owned && t.tab && info.targetId.toUpperCase().startsWith(String(t.tab).toUpperCase())) {
        if (!H.owned.has(agent)) H.owned.set(agent, new Set());
        H.owned.get(agent).add(info.targetId);
      }
    } else if (name !== 'chrome_open') return text('A call for this task must name its tab.');
    if (name === 'chrome_open' && !args.profile) args.profile = profiles().find(p => p.lastUsed)?.dir || profiles()[0]?.dir || 'Default';
    const blocked = await sitesAllowed(name, args, body, port, api);
    if (blocked) return blocked;
    // An approval the person gave on pre.dev's card, for exactly one control (pre.dev checked the card).
    const approved = body?.approved && typeof body.approved === 'object' && typeof body.approved.desc === 'string' && typeof body.approved.page === 'string'
      ? { desc: body.approved.desc.slice(0, 500), page: body.approved.page.slice(0, 2000), at: Date.now() } : null;
    if (approved) APPROVED.set(agent, approved);
    const timeoutMs = Math.min(Math.max(Number(body?.timeoutMs) || 180000, 5000), 11 * 60000);
    RUNS.inflight.set(taskId, (RUNS.inflight.get(taskId) || 0) + 1);
    let result;
    try {
      // Taken over while this call waited (a new site's question): it does not run.
      if (handedTask(taskId)?.driver !== 'cloud') return refusedText('An agent on this computer has this task now.', { kind: 'taken_over' });
      result = await callTool(name, args, { apiKey: key(), apiUrl: pairing()?.apiUrl || defaultApiUrl, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
      return { ...text(`Error: ${error.message}`), ...(error.refusal ? { refusal: error.refusal } : {}) };
    } finally {
      RUNS.inflight.set(taskId, Math.max(0, (RUNS.inflight.get(taskId) || 1) - 1));
      if (approved && APPROVED.get(agent) === approved) APPROVED.delete(agent);
    }
    return (await movedTo(name, args, result)) || result;
  }

  /** pre.dev: the cloud run of a handed task ended (or never started): it comes off the list, or waits for an agent here. */
  function taskDriver(body) {
    const taskId = cleanTaskId(body?.taskId);
    const tasks = handedTasks();
    const t = tasks.find(x => x.taskId === taskId);
    if (!t) return { ok: true, known: false };
    if (body?.finished === true && t.driver === 'cloud') {
      writePrivate(TASKS_FILE, { tasks: tasks.filter(x => x.taskId !== taskId) });
      log('channel', `task ${taskId} finished by pre.dev's cloud run`);
      return { ok: true, removed: true };
    }
    if (body?.driver === 'local' && t.driver === 'cloud') {
      t.driver = 'local';
      writePrivate(TASKS_FILE, { tasks });
      log('channel', `task ${taskId} waits for an agent on this computer`);
    }
    return { ok: true, driver: t.driver || 'local' };
  }

  function webTools(api) {
    const ctx = { handoff: true, via: 'web', apiKey: key(), cloud: false };
    return {
      tools: api.toolList(ctx).filter(t => WEB_TOOLS.has(t.name)),
      instructions: api.instructions(ctx),
    };
  }

  function profiles() {
    try {
      const state = JSON.parse(fs.readFileSync(path.join(chromeDir, 'Local State'), 'utf8'));
      const cache = state?.profile?.info_cache || {};
      const last = state?.profile?.last_used || 'Default';
      return Object.entries(cache).map(([dir, p]) => ({ dir, name: String(p?.name || dir), lastUsed: dir === last }));
    } catch { return []; }
  }

  // ---------------------------------------------------------------- Finish on my computer

  /** A cloud Browser Agents task handed here: keep it for Browser Agents Local (chrome_handed_off
   *  lists it to the agents on this computer), and open the page it stopped on in this Chrome, once
   *  the person here allows that site. Nothing in it is a cookie or storage. */
  async function takeTask(body, port, api) {
    const taskId = String(body?.taskId || '').replace(/[^a-f0-9]/gi, '').slice(0, 40);
    const checkpoint = body?.checkpoint || {};
    const url = String(checkpoint.url || '');
    const host = hostOf(url);
    if (!taskId || !host) return { accepted: false, error: 'a handed-off task needs its id and the http(s) page it stopped on' };
    const site = (typeof body?.site === 'string' && body.site && host.endsWith(body.site)) ? body.site : await siteFor(host);
    if (!isAllowed(site) && !(await askToAllow(site, port, api.chromeInFront))) {
      return { accepted: false, error: `the person at this computer didn't allow ${site}` };
    }
    const before = readJson(TASKS_FILE)?.tasks || [];
    const prior = before.find(t => t.taskId === taskId);
    const tasks = before.filter(t => t.taskId !== taskId);
    let tab = '';
    // Handed here again (the computer was away, and the user chose it once more): the tab it had, if still open.
    const kept = prior?.tab ? tabInfo(prior.tab) : null;
    if (kept && !privateTabs.has(kept.targetId)) tab = prior.tab;
    if (!tab) try {
      const profile = profiles().find(p => p.lastUsed)?.dir || profiles()[0]?.dir || 'Default';
      const opened = await callTool('chrome_open', { profile, url, foreground: false, __agent: `handed:${taskId}`, __predev_handoff: true, __via: 'web' },
        { apiKey: key(), apiUrl: pairing()?.apiUrl || defaultApiUrl, signal: AbortSignal.timeout(60000) });
      tab = /^Tab ([0-9A-F]{6,}) ·/m.exec((opened?.content || []).find(c => c.type === 'text')?.text || '')?.[1] || '';
    } catch (error) { log('channel', 'handed task open failed', error.message); }
    tasks.push({
      taskId, batchId: String(body?.batchId || ''), site, tab, at: new Date().toISOString(),
      // 'cloud': pre.dev's cloud carries it on in that tab by itself; else it waits for an agent here.
      driver: body?.runner === 'cloud' ? 'cloud' : 'local',
      instruction: String(body?.instruction || '').slice(0, 20000),
      checkpoint: { url, step: Number(checkpoint.step) || 0, reason: String(checkpoint.reason || ''), memory: String(checkpoint.memory || '').slice(0, 8000),
        history: (Array.isArray(checkpoint.history) ? checkpoint.history : []).slice(-60) },
    });
    writePrivate(TASKS_FILE, { tasks: tasks.slice(-20) });
    log('channel', `task ${taskId} handed to this computer (${site}${body?.runner === 'cloud' ? ', carried on by pre.dev' : ''})`);
    return { accepted: true, ...(tab ? { tab } : {}) };
  }

  // ---------------------------------------------------------------- the tunnel

  function frame(id, bytes) {
    const out = Buffer.alloc(5 + bytes.length);
    out[0] = FRAME_BODY;
    out.writeUInt32BE(id >>> 0, 1);
    bytes.copy(out, 5);
    return out;
  }

  async function onRequest(socket, m, port) {
    // The head goes at once: a call that waits for the person here (a new site, a handoff) is
    // timed by its caller, not by the edge's first-byte wait.
    const head = status => socket.send(JSON.stringify({ t: 'res', id: m.id, status, headers: [['content-type', 'application/json']] }));
    const end = value => {
      if (socket.readyState !== 1) return;
      const bytes = Buffer.from(JSON.stringify(value));
      for (let at = 0; at < bytes.length; at += CHUNK) socket.send(frame(m.id, bytes.subarray(at, at + CHUNK)));
      socket.send(JSON.stringify({ t: 'res-end', id: m.id }));
    };
    let body = null;
    try { body = m.body ? JSON.parse(Buffer.from(m.body, 'base64').toString('utf8')) : null; } catch {}
    const route = `${m.method} ${String(m.path || '').split('?')[0]}`;
    try {
      head(200);
      const api = await loadTools();
      if (route === 'GET /state') {
        end({ ok: true, chrome: chrome.connected || fs.existsSync(path.join(chromeDir, 'DevToolsActivePort')), version: ctx.version, profiles: profiles() });
      } else if (route === 'GET /tools') {
        end(webTools(api));
      } else if (route === 'POST /sites/revoke') {
        // Revoked on pre.dev: it stops here now.
        const site = String(body?.site || '');
        const sites = allowedSites();
        const had = !!sites[site];
        if (had) { delete sites[site]; writePrivate(SITES_FILE, { sites }); log('channel', `site ${site} revoked at pre.dev`); }
        end({ ok: true, revoked: had });
      } else if (route === 'POST /tasks/continue') {
        end(await takeTask(body, port, api));
      } else if (route === 'POST /tasks/call') {
        const started = Date.now();
        const result = await taskCall(body, port, api);
        log('channel', 'task call', String(body?.name || ''), result?.refusal ? `refused (${result.refusal.kind})` : result?.isError ? 'failed' : 'ok', `${Date.now() - started}ms`);
        end({ result });
      } else if (route === 'POST /tasks/driver') {
        end(taskDriver(body));
      } else if (route === 'POST /call') {
        const started = Date.now();
        const result = await webCall(body, port, api);
        log('channel', 'call', String(body?.name || ''), result?.isError ? 'refused or failed' : 'ok', `${Date.now() - started}ms`);
        end({ result });
      } else {
        end({ error: 'not found' });
      }
    } catch (error) {
      log('channel', route, 'error', error.message);
      end({ result: { ...text(`Error: ${error.message}`), ...(error.refusal ? { refusal: error.refusal } : {}) } });
    }
  }

  async function connectOnce(port) {
    const p = pairing();
    if (!p?.apiUrl) { status = 'unpaired'; return 'stop'; }
    if (!key()) { status = 'signed_out'; return 'later'; }
    let grant;
    try {
      // This computer's own allowed list goes along: pre.dev keeps only what is still allowed here.
      const r = await post(p.apiUrl, '/computer-channel/tunnel', { computerId: computerId(), sites: Object.keys(allowedSites()) });
      if (r.status === 409) {
        // Unpaired at pre.dev (by `unpair` or from pre.dev's settings): stop, and say so in the log.
        log('channel', 'pre.dev says this computer is no longer paired; stopping');
        try { fs.rmSync(PAIRING_FILE, { force: true }); } catch {}
        status = 'unpaired';
        return 'stop';
      }
      if (r.status === 404) { status = 'unavailable'; return 'later'; }
      if (r.status === 401 || r.status === 403) { status = 'signed_out'; return 'later'; }
      if (!r.json?.grant?.url) { status = 'offline'; return 'retry'; }
      grant = r.json.grant;
      keepOnly(r.json.sites);
    } catch (error) {
      log('channel', 'grant failed', error.message);
      status = 'offline';
      return 'retry';
    }
    const headers = { Authorization: `Bearer ${grant.token}`, 'X-Predev-Ping-Ms': String(PING_MS) };
    // Against a local edge (development), name the host the edge would see.
    try { if (new URL(grant.url).host !== grant.host) headers['X-Predev-Dev-Host'] = grant.host; } catch {}
    return new Promise(resolve => {
      let opened = false;
      let settled = false;
      let heardAt = Date.now();
      const socket = new WebSocket(grant.url, { headers });
      ws = socket;
      socket.binaryType = 'arraybuffer';
      // One way out, whichever comes first: the close, a connect that hangs, or a link that went
      // silent (the edge answers every ping, so two missed answers mean it is gone).
      const finish = (next, why) => {
        if (settled) return;
        settled = true;
        clearInterval(pingTimer);
        clearTimeout(connectTimer);
        if (ws === socket) ws = null;
        if (status === 'online') status = 'offline';
        log('channel', 'closed', why);
        try { socket.close(1000, 'reconnect'); } catch {}
        resolve(next);
      };
      const connectTimer = setTimeout(() => { if (!opened) finish('retry', 'connect timed out'); }, 15000);
      socket.onopen = () => {
        opened = true;
        heardAt = Date.now();
        status = 'online';
        clearTimeout(connectTimer);
        log('channel', 'connected');
        clearInterval(pingTimer);
        pingTimer = setInterval(() => {
          if (Date.now() - heardAt > 2.5 * PING_MS) return finish('retry-now', 'no answer from pre.dev');
          try { socket.send('{"t":"ping"}'); } catch {}
        }, PING_MS);
        pingTimer.unref?.();
      };
      socket.onmessage = event => {
        heardAt = Date.now();
        if (typeof event.data !== 'string') return;
        let m;
        try { m = JSON.parse(event.data); } catch { return; }
        if (m.t === 'req' && Number.isInteger(m.id)) void onRequest(socket, m, port);
        // Unpaired at pre.dev: the edge says so before it closes; ask pre.dev now.
        else if (m.t === 'bye') finish('check-now', `bye ${String(m.why || '').slice(0, 40)}`);
      };
      socket.onerror = () => {};
      socket.onclose = event => {
        // Unpaired or replaced at pre.dev: the edge cut it off on purpose.
        finish(event.code === 4003 ? 'check' : opened ? 'retry-now' : 'retry', `${event.code || ''} ${event.reason || ''}`.trim());
      };
    });
  }

  async function loop(port) {
    let backoff = 1000;
    while (running) {
      const next = await connectOnce(port).catch(error => { log('channel', 'error', error.message); return 'retry'; });
      if (!running || next === 'stop') break;
      if (next === 'retry-now') backoff = 1000;
      const wait = next === 'later' ? 60000 : next === 'check' ? 2000 : next === 'check-now' ? 0 : backoff;
      backoff = Math.min(backoff * 2, 30000);
      await new Promise(resolve => { wake = resolve; setTimeout(resolve, wait).unref?.(); });
      wake = null;
    }
    running = false;
    if (status === 'online') status = 'offline';
  }

  return {
    computerId,
    pairing,
    handleHttp,
    get status() { return pairing() ? status : 'unpaired'; },
    /** Start (or keep) the channel when this computer is paired. */
    start(port) {
      if (running || !pairing()) return;
      running = true;
      status = 'connecting';
      void loop(port);
    },
    /** Stop it now (unpair). */
    stop() {
      running = false;
      try { ws?.close(1000, 'unpaired'); } catch {}
      wake?.();
      status = 'unpaired';
    },
    /** Pairing changed on disk (pair, unpair): follow it. */
    reload(port) {
      if (!pairing()) { this.stop(); try { fs.rmSync(SITES_FILE, { force: true }); } catch {} return; }
      if (!running) this.start(port);
      else { try { ws?.close(1000, 'reload'); } catch {} wake?.(); }
    },
  };
}
