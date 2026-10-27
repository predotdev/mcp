// The pre.dev Chrome extension: "Do it in my Chrome" for pre.dev web runs, with nothing else to
// install. It is a client of the same computer channel as the pre.dev MCP's daemon (channel.mjs),
// paired to the user's own pre.dev account the same way (a device code they approve on pre.dev), and it
// runs the same chrome_* tools with the same guard (tools.mjs) and the same web run rules
// (web_rules.mjs), through chrome.debugger instead of a remote debugging port:
//
//   - only web runs the paired person typed reach it (pre.dev routes by user; a teammate's run names
//     the teammate);
//   - a site needs a click in this Chrome first; the popup lists the sites, ticked or not;
//   - the guard is always on: the run works only in tabs it opened, never types passwords, codes or
//     card numbers, asks first before a click that sends, posts, buys or deletes, and keeps a sign-in a
//     handoff made (no scripts there at all; the web tools have no script tool);
//   - Chrome shows its own "started debugging this browser" bar while a tab is attached, and Cancel on
//     it pauses pre.dev here at once;
//   - Pause, Stop (a chat run: for the rest of that turn) and Unpair in the popup take effect at once;
//   - "Finish in my Chrome": a Browser Agents task handed to this Chrome goes on here, carried on by pre.dev's
//     cloud run with the same rules, in the tab opened for it (web_rules.mjs createTaskCalls);
//   - it never reads cookies, storage or passwords, and asks for no permission that could.

import { CONFIG } from './config.mjs';
import { CONTEXT, createDebuggerChrome } from './cdp.mjs';
import { createTools } from './lib/tools.mjs';
import {
  ALLOW_WAIT_MS, HANDOFF_TOOL, WEB_TOOLS, allowQuestion, cleanTaskId, createTaskCalls, createWebCalls, hostOf, runKeyOf, runTurnOf, taskAgent, text, webAgent,
} from './lib/web_rules.mjs';

const PING_MS = 15000;
const FRAME_BODY = 1;
const CHUNK = 256 * 1024;
const CLIENT_ID = 'predev-chrome-mcp';
const CLIENT_HEADER = 'predev-chrome-extension';
const PROFILE = { dir: 'Default', name: 'This Chrome', email: '', open: true };
const LOG_MAX = 200;
/** Attached tabs nobody used for this long let go (Chrome's bar goes with the last one). */
const IDLE_DETACH_MS = 90000;
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const PAUSED_TEXT = "The user paused pre.dev in their Chrome. Don't retry: tell them in one line what you need from their Chrome, and continue with what you have.";
/** A stopped run stays stopped for the rest of its turn, however long it waits between calls: pre.dev names the
 *  turn on every call (the person's latest message in that chat), and only a new message there ends the stop. */
const STOPPED_TEXT = "The user stopped this run in their Chrome. Don't use their Chrome again for the rest of this turn (until they send a new message): tell them in one line what is left, and finish with what you have.";
const BLOCKED_TEXT = "This Chrome's settings (set by the user's company) turn off developer tools, which pre.dev needs to work in it. Don't retry here: tell the user in one line, and continue with what you have.";
/** The code a handed task's call carries when it can't run here, so pre.dev's runner reads the reason from a field
 *  and not from the wording: the person ended it (Stop or Pause), or a company policy turns developer tools off. */
const TASK_CODES = new Map([[STOPPED_TEXT, 'STOPPED_BY_USER'], [PAUSED_TEXT, 'PAUSED_BY_USER'], [BLOCKED_TEXT, 'POLICY_BLOCKED']]);
/** What a handed task's run is told when developer tools are off here: plain, for the person's card and log. */
const POLICY_TEXT = "Developer tools are turned off in this Chrome by a company setting, so pre.dev can't work in it.";
const taskWords = why => (why === BLOCKED_TEXT ? POLICY_TEXT : why);
const unavailableBody = why => ({ unavailable: true, ...(TASK_CODES.has(why) ? { code: TASK_CODES.get(why) } : {}) });

// ---------------------------------------------------------------- state

const local = {
  async get(key, fallback) { try { const v = (await chrome.storage.local.get(key))[key]; return v === undefined ? fallback : v; } catch { return fallback; } },
  set: (key, value) => chrome.storage.local.set({ [key]: value }),
  remove: keys => chrome.storage.local.remove(keys),
};
const session = {
  async get(key, fallback) { try { const v = (await chrome.storage.session.get(key))[key]; return v === undefined ? fallback : v; } catch { return fallback; } },
  set: (key, value) => chrome.storage.session.set({ [key]: value }),
};
/** One account's activity here (its runs, their stops and log lines, the tasks handed here) is written only while
 *  this Chrome is paired, checked right before the write: a call that began before an Unpair lands nothing after it,
 *  and forget() clears what came before. Another account paired next never sees any of it. */
const paired = async () => !!(await local.get('pairing', null));
const accountSession = { set: async (key, value) => { if (await paired()) await session.set(key, value); } };

/** This Chrome's id for pre.dev: random, made once, not a secret. */
async function computerId() {
  let id = await local.get('computerId', '');
  if (!/^[a-f0-9]{32}$/.test(id)) {
    id = [...crypto.getRandomValues(new Uint8Array(16))].map(b => b.toString(16).padStart(2, '0')).join('');
    await local.set('computerId', id);
  }
  return id;
}
const pairing = () => local.get('pairing', null);
const apiBase = p => String(p?.apiUrl || CONFIG.apiUrl).replace(/\/+$/, '');

let status = 'unpaired';
let devtoolsBlocked = '';
let paused = false;
let pairingFlow = null;
let lastError = '';
let ws = null;
let running = false;
let wake = null;
/** Calls in flight: each with its run and a way to end it now. */
const inflight = new Set();
/** One question per site at a time: site -> { nonce, site, decided, waiters, tabId, targetId }. */
const asking = new Map();
const byNonce = new Map();

async function platform() {
  try {
    const { os } = await chrome.runtime.getPlatformInfo();
    return { mac: 'macOS', win: 'Windows', linux: 'Linux', cros: 'ChromeOS', android: 'Android', openbsd: 'OpenBSD', fuchsia: 'Fuchsia' }[os] || os;
  } catch { return 'unknown'; }
}

// ---------------------------------------------------------------- the log the popup shows

let logQueue = Promise.resolve();
function note(entry, { always = false } = {}) {
  logQueue = logQueue.then(async () => {
    if (!always && !(await paired())) return;
    const list = await session.get('log', []);
    list.push({ at: Date.now(), ...entry });
    await session.set('log', list.slice(-LOG_MAX));
  }).catch(() => {});
  return logQueue;
}
const log = (...parts) => console.log('[pre.dev]', ...parts);

/** What a call did, in a few words, never what it typed. */
function describe(name, args) {
  const where = u => { try { const x = new URL(/^[a-z][a-z0-9+.-]*:/i.test(String(u)) ? String(u) : `https://${u}`); return `${x.host}${x.pathname === '/' ? '' : x.pathname}`.slice(0, 80); } catch { return String(u || '').slice(0, 80); } };
  const el = () => (args.ref ? `[${String(args.ref).replace(/^\[|\]$/g, '')}]` : args.selector ? String(args.selector).slice(0, 60) : args.text && name !== 'chrome_type' ? `"${String(args.text).slice(0, 40)}"` : '');
  switch (name) {
    case 'chrome_open': return `Opened ${where(args.url)}`;
    case 'chrome_navigate': return ['back', 'forward', 'reload'].includes(args.url) ? `Went ${args.url}` : `Went to ${where(args.url)}`;
    case 'chrome_click': return `Clicked ${el() || 'an element'}`;
    case 'chrome_type': return `Typed ${String(args.text ?? '').length} characters${args.ref || args.selector ? ` into ${el()}` : ''}`;
    case 'chrome_act': return `${args.action === 'type' ? 'Typed into' : 'Clicked'} ${String(args.target || '').slice(0, 60)}`;
    case 'chrome_press': return `Pressed ${String(args.keys || '').slice(0, 20)}`;
    case 'chrome_scroll': return `Scrolled ${String(args.direction || '')}`.trim();
    case 'chrome_snapshot': return 'Read the page structure';
    case 'chrome_read': return 'Read the page';
    case 'chrome_wait': return 'Waited for the page';
    case 'chrome_show': return 'Brought a tab forward';
    case 'chrome_close': return 'Closed a tab';
    case 'chrome_tabs': return 'Listed its tabs';
    case 'chrome_profiles': return 'Looked at this Chrome';
    case 'chrome_screenshot': return 'Looked at the tab';
    case HANDOFF_TOOL: {
      if (args.resume === true) return 'Took the tab back after your step';
      if (args.check === true || !args.reason) return 'Checked a step it handed you';
      const step = { login_required: 'the sign-in', step_up: 'a security check', captcha: 'a check', approval: 'a step to approve', user_control: 'the tab', chrome_dialog: "Chrome's password warning" }[String(args.reason)];
      return `Handed you ${step || 'a step'}`;
    }
    default: return name;
  }
}
const REFUSED_AS = {
  approval: 'Asked first (would send, post, buy or delete)',
  keep_signin: 'Kept your sign-in',
  not_allowed: 'Site not allowed',
  secret: 'Never types passwords, codes or cards',
  scope: 'Not one of its tabs',
  passkey: 'Left the passkey to you',
  chrome_dialog: "Chrome's own dialog is over the tab",
  user_control: 'You were using the tab',
  tab_closed: 'Its tab was closed',
  taken_over: 'Not handed here any more',
  page_busy: "The page wasn't answering",
};
/** A dialog the page opened, in the person's words. */
const DIALOG_AS = { alert: 'A message (alert)', confirm: 'A confirm dialog', prompt: 'A prompt dialog', beforeunload: 'A "Leave site?" dialog' };
function outcomeOf(result) {
  if (result?.landed && DIALOG_AS[result.dialog?.type]) return { ok: true, text: `Done; ${DIALOG_AS[result.dialog.type].toLowerCase()} opened on the page, waiting for you` };
  if (result?.partial) return { ok: true, text: 'Part of it may have gone through; then the page stopped answering' };
  if (!result?.isError) return { ok: true, text: 'done' };
  const kind = result.refusal?.kind;
  if (kind === 'page_busy' && DIALOG_AS[result.refusal.dialog?.type]) return { ok: false, kind, text: `${DIALOG_AS[result.refusal.dialog.type]} is open on the page, waiting for you` };
  const all = String((result.content || []).find(c => c.type === 'text')?.text || '');
  // This Chrome's own reasons, in the person's words rather than the run's.
  if (all.includes(BLOCKED_TEXT)) return { ok: false, kind: 'blocked', text: 'Refused: developer tools are off' };
  if (all.includes(PAUSED_TEXT)) return { ok: false, kind: 'ended', text: 'Refused: paused' };
  if (all.includes(STOPPED_TEXT)) return { ok: false, kind: 'ended', text: 'Refused: you stopped this run' };
  if (kind === 'not_allowed' && result.refusal?.answer === 'none') return { ok: false, kind, text: `No answer in ${Math.round(ALLOW_WAIT_MS / 60000)} minutes` };
  if (kind === 'secret' && result.refusal?.reopened) return { ok: false, kind, text: 'Opened the tab again: its sign-in was lost when the windows closed, so it goes to you' };
  return { ok: false, kind: kind || 'error', text: REFUSED_AS[kind] || all.split('\n')[0].slice(0, 160) };
}

// ---------------------------------------------------------------- what the popup sees

let uiTimer = null;
function ui() {
  clearTimeout(uiTimer);
  uiTimer = setTimeout(async () => {
    const p = await pairing();
    const runs = await session.get('runs', {});
    const stopped = await session.get('stopped', {});
    await session.set('ui', {
      status: p ? status : pairingFlow ? 'pairing' : 'unpaired',
      account: p?.account || null,
      name: p?.name || '',
      paused,
      devtoolsBlocked,
      error: lastError,
      pairing: pairingFlow ? { userCode: pairingFlow.userCode, link: pairingFlow.link } : null,
      asking: [...asking.values()].filter(e => !e.decided).map(e => e.site),
      runs: !p ? [] : Object.entries(runs).map(([key, r]) => ({ key, ...r, stopped: !!stopped[key], active: [...inflight].some(c => c.runKey === key) }))
        .sort((a, b) => b.last - a.last).slice(0, 5),
      dev: CONFIG.dev,
      apiUrl: apiBase(p),
    });
    const badge = !p ? '' : devtoolsBlocked ? '!' : paused ? 'II' : asking.size ? '?' : status === 'online' ? '' : 'off';
    chrome.action.setBadgeText({ text: badge }).catch(() => {});
    chrome.action.setBadgeBackgroundColor({ color: badge === '?' ? '#d97706' : '#555' }).catch(() => {});
  }, 50);
}

// ---------------------------------------------------------------- this Chrome, through chrome.debugger

const conn = createDebuggerChrome({
  log,
  async beforeAttach() {
    if (paused) throw new Error(PAUSED_TEXT);
    if (devtoolsBlocked) throw new Error(BLOCKED_TEXT);
  },
  onDetach(targetId, reason) {
    // Cancel on Chrome's own bar: the person wants it to stop. Everything pauses here, now.
    if (reason === 'canceled_by_user' && !paused) {
      void note({ kind: 'control', text: "Paused: you clicked Cancel on Chrome's debugging bar" });
      void setPaused(true);
    }
  },
});
conn.__predevPrivate ??= new Set();
const core = {
  chrome: conn,
  contextDirs: new Map([[CONTEXT, PROFILE.dir]]),
  failedProbes: new Set(),
  triedDirs: new Set(),
  saveProfileMap() {},
  log,
  sleep,
  chromeDir: '',
  customChromeDir: true,
  version: CONFIG.version,
  stateDir: '',
  daemonPort: 0,
  chromeProfiles: () => [PROFILE],
  async chromeInFront() {
    try { const w = await chrome.windows.getLastFocused(); return !!w?.focused; } catch { return true; }
  },
  // tools.mjs pressed OK on an alert in a run's tab: the person sees it in Activity.
  onDialog({ targetId, site }) {
    let run;
    for (const [agent, tabs] of conn.__predevHandoff?.owned || []) if (tabs.has(targetId) && agent.startsWith('handed:')) run = `task:${cleanTaskId(agent.slice(7))}`;
    void note({ kind: 'control', ...(run ? { run } : {}), text: `Closed a message on ${site || 'a page'}` });
    ui();
  },
  // A dialog opened or closed in a tab (or its page answers again): held pings look again.
  onBusy() { wakeHolds(); },
};
const api = createTools(core);

async function callTool(name, args, ctx) {
  const tool = api.TOOLS.find(t => t.name === name);
  if (!tool) throw new Error(`Unknown tool ${name}`);
  await conn.connect();
  try {
    const result = await tool.run(args || {}, ctx);
    return typeof result === 'string' ? { content: [{ type: 'text', text: result }] } : result;
  } catch (error) {
    // Chrome wouldn't attach to a web page: if it won't attach to a blank tab either, developer tools
    // are off in this Chrome (a company setting), and no call can work here.
    if (error?.attachFailed && !devtoolsBlocked && !(await checkDebugger()).ok && devtoolsBlocked) throw new Error(BLOCKED_TEXT);
    throw error;
  }
}

async function markBlocked(message) {
  if (devtoolsBlocked) return;
  devtoolsBlocked = String(message || 'Developer tools are turned off in this Chrome.').slice(0, 200);
  wakeHolds();
  await session.set('devtoolsBlocked', devtoolsBlocked);
  await note({ kind: 'control', text: "Can't work here: this Chrome's settings turn off developer tools" }, { always: true });
  ui();
}

/** Does chrome.debugger work in this Chrome? (A company setting can turn developer tools off.) */
async function checkDebugger() {
  let tab;
  try {
    tab = await chrome.tabs.create({ url: 'about:blank', active: false });
    await chrome.debugger.attach({ tabId: tab.id }, '1.3');
    await chrome.debugger.detach({ tabId: tab.id }).catch(() => {});
    if (devtoolsBlocked) { devtoolsBlocked = ''; wakeHolds(); }
    await session.set('devtoolsBlocked', '');
    return { ok: true };
  } catch (error) {
    // A blank tab of this profile is always attachable unless developer tools are turned off.
    const message = String(error?.message || error);
    await markBlocked(message);
    return { ok: false, error: message };
  } finally {
    if (tab) chrome.tabs.remove(tab.id).catch(() => {});
    ui();
  }
}

// ---------------------------------------------------------------- sites a web run may use

const allowedSites = () => local.get('sites', {});
let sitesCache = null;
async function sites() { if (!sitesCache) sitesCache = await allowedSites(); return sitesCache; }
chrome.storage.onChanged.addListener((changes, area) => { if (area === 'local' && changes.sites) sitesCache = changes.sites.newValue || {}; });
const isAllowedNow = site => !!site && !!sitesCache?.[site]?.on;

async function post(route, body, p) {
  p ||= await pairing();
  const res = await fetch(`${apiBase(p)}${route}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${p?.key || ''}`, 'Content-Type': 'application/json', 'x-predev-client': CLIENT_HEADER },
    body: JSON.stringify(body || {}),
    signal: AbortSignal.timeout(20000),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

/** Tick or untick a site here (only the person at this Chrome does: the popup, or the question). */
async function setSite(site, on) {
  site = String(site || '').trim().toLowerCase();
  if (!site) return;
  const list = { ...(await sites()) };
  list[site] = { ...(list[site] || {}), on: !!on, ...(on ? { allowedAt: new Date().toISOString() } : { offAt: new Date().toISOString() }) };
  if (!(await paired())) return;
  sitesCache = list;
  await local.set('sites', list);
  await note({ kind: 'control', text: on ? `Allowed ${site}` : `Unticked ${site}: web runs can't use it here` });
  // pre.dev keeps the list too, to show it and to revoke from the web.
  const id = await computerId();
  void post(on ? '/computer-channel/sites' : '/computer-channel/sites/revoke', { computerId: id, site }).catch(error => log('site note failed', error.message));
  ui();
}

/** pre.dev's list at (re)connect: a site revoked there while this Chrome was away drops here (the next run
 *  that wants it asks again). A site the person unticked here stays unticked. */
async function keepOnly(atPredev) {
  if (!Array.isArray(atPredev)) return;
  const keep = new Set(atPredev.map(String));
  const list = { ...(await sites()) };
  let dropped = 0;
  for (const [site, s] of Object.entries(list)) if (s.on && !keep.has(site)) { delete list[site]; dropped++; }
  if (dropped && (await paired())) { sitesCache = list; await local.set('sites', list); await note({ kind: 'control', text: `${dropped} site(s) revoked on pre.dev while this Chrome was away` }); }
}

/** The registrable domain of a host, as pre.dev computes every site; the host itself if pre.dev can't
 *  be asked (stricter: one click never covers more). */
const siteCache = new Map();
async function siteFor(host) {
  if (!host) return '';
  if (siteCache.has(host)) return siteCache.get(host);
  let site = host.replace(/^www\./, '');
  const p = await pairing();
  try {
    const res = await fetch(`${apiBase(p)}/computer-channel/site?host=${encodeURIComponent(host)}`, {
      headers: { Authorization: `Bearer ${p?.key || ''}`, 'x-predev-client': CLIENT_HEADER }, signal: AbortSignal.timeout(8000),
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

/** Ask the person at this Chrome to allow a site: the extension's own page, which no run can reach
 *  (no run attaches to an extension page or opens one). true once allowed, false when they said no,
 *  'no_answer' when nobody answered in time (the question closes; the next call asks again), 'off' when
 *  the site is unticked here. */
async function askToAllow(site) {
  await sites();
  if (isAllowedNow(site)) return true;
  if (paused) return false;
  // Unticked in the popup: the person said no to this site here. Refused without asking; ticking it again allows it.
  if (sitesCache?.[site] && !sitesCache[site].on) return 'off';
  let entry = asking.get(site);
  if (!entry) {
    const nonce = [...crypto.getRandomValues(new Uint8Array(24))].map(b => b.toString(16).padStart(2, '0')).join('');
    entry = { site, nonce, decided: null, waiters: [], tabId: null, targetId: null };
    asking.set(site, entry);
    byNonce.set(nonce, entry);
    try {
      const front = await core.chromeInFront();
      const tab = await chrome.tabs.create({ url: chrome.runtime.getURL(`allow.html#${nonce}`), active: front });
      entry.tabId = tab.id;
      await conn.refresh().catch(() => {});
      entry.targetId = conn.targetOfTab(tab.id);
      if (entry.targetId) conn.__predevPrivate.add(entry.targetId);
      await note({ kind: 'control', text: `Asked you to allow ${site}` });
      ui();
    } catch (error) {
      asking.delete(site);
      byNonce.delete(nonce);
      throw new Error(`Could not ask in this Chrome: ${error.message}`);
    }
  }
  const answer = await new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), ALLOW_WAIT_MS);
    entry.waiters.push(v => { clearTimeout(timer); resolve(v); });
  });
  if (answer === null && !entry.decided) {
    entry.decided = 'timeout';
    closeQuestion(entry, 0);
    await note({ kind: 'control', text: `No answer about ${site} in ${Math.round(ALLOW_WAIT_MS / 60000)} minutes: the question closed` });
  }
  return answer === true ? true : answer === null ? 'no_answer' : false;
}

function closeQuestion(entry, delay) {
  asking.delete(entry.site);
  setTimeout(() => {
    byNonce.delete(entry.nonce);
    if (entry.tabId != null) chrome.tabs.remove(entry.tabId).catch(() => {});
    if (entry.targetId) conn.__predevPrivate.delete(entry.targetId);
  }, delay);
  ui();
}

async function decide(nonce, allowed) {
  const entry = byNonce.get(String(nonce || ''));
  if (!entry || entry.decided) return { ok: false };
  entry.decided = allowed ? 'allow' : 'deny';
  if (allowed) await setSite(entry.site, true);
  else await note({ kind: 'control', text: `Didn't allow ${entry.site}` });
  for (const w of entry.waiters.splice(0)) w(allowed);
  closeQuestion(entry, allowed ? 1500 : 4000);
  return { ok: true };
}

// A question waits behind another app: it comes forward once Chrome does.
chrome.windows.onFocusChanged.addListener(windowId => {
  if (windowId === chrome.windows.WINDOW_ID_NONE) return;
  for (const entry of asking.values()) {
    if (!entry.decided && entry.tabId != null) chrome.tabs.update(entry.tabId, { active: true }).catch(() => {});
  }
});
chrome.tabs.onRemoved.addListener(tabId => {
  // The person closed the question: that's a no.
  for (const entry of asking.values()) if (entry.tabId === tabId && !entry.decided) void decide(entry.nonce, false);
});

// ---------------------------------------------------------------- the calls a web run makes

const webCalls = createWebCalls({
  callTool,
  ctx: () => ({ apiKey: pairingKey, apiUrl: apiBase(pairingCache) }),
  tabInfo: tab => conn.tabInfo(tab),
  isPrivate: targetId => !!targetId && conn.__predevPrivate.has(targetId),
  siteFor,
  isAllowed: isAllowedNow,
  askToAllow,
});
let pairingCache = null;
let pairingKey = '';
async function loadPairing() {
  pairingCache = await pairing();
  pairingKey = String(pairingCache?.key || '');
  return pairingCache;
}

async function touchRun(runKey, name, args, turn = '') {
  const runs = await session.get('runs', {});
  const r = runs[runKey] || { first: Date.now(), calls: 0, hosts: [] };
  r.last = Date.now();
  r.calls++;
  delete r.cut;
  if (turn) r.turn = turn;
  // "back", "forward" and "reload" are moves in the tab, not sites: the row keeps the site it was on.
  const url = String(args?.url || '');
  const host = (name === 'chrome_open' || name === 'chrome_navigate') && url && !['back', 'forward', 'reload'].includes(url)
    ? hostOf(/^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`) : '';
  if (host && !r.hosts.includes(host)) r.hosts = [...r.hosts, host].slice(-6);
  runs[runKey] = r;
  const keys = Object.keys(runs).sort((a, b) => runs[b].last - runs[a].last);
  for (const k of keys.slice(20)) delete runs[k];
  await accountSession.set('runs', runs);
}

/** A new browser session (every window was closed, or Chrome restarted) starts with no runs or stops on record. The
 *  tasks still handed here get their rows back, cut off (their runs here stopped with the windows), so the popup
 *  lists them and a task the cloud takes back reads as Ended, not Finished. A run that carries on here clears it. */
async function restoreTaskRuns(list) {
  if (!list.length) return;
  const runs = await session.get('runs', {});
  const stopped = await session.get('stopped', {});
  for (const t of list) {
    const taskId = cleanTaskId(t.taskId);
    const key = `task:${taskId}`;
    if (!taskId || runs[key]) continue;
    const at = Date.parse(t.at || '') || Date.now();
    runs[key] = { first: at, last: at, calls: 0, hosts: t.site ? [String(t.site)] : [], cut: true };
    if (t.stopped && !stopped[key]) stopped[key] = { at: Number(t.stopped) || Date.now() };
  }
  await accountSession.set('runs', runs);
  await accountSession.set('stopped', stopped);
}

/** This Chrome stopped answering a handed task's run (a call refused here while paused, stopped or blocked; the
 *  connection to pre.dev dropped; or the extension started again after being away). pre.dev tells this Chrome the
 *  same thing when its run here finished the task and when the cloud took the task back, so this is what tells the
 *  two apart: a task whose run here was cut off, and that no call reached since, did not finish here. */
async function cutTaskRuns(runKey = '') {
  const runs = await session.get('runs', {});
  let changed = false;
  for (const [k, r] of Object.entries(runs)) {
    if (!k.startsWith('task:') || (runKey && k !== runKey) || r.ended || r.cut) continue;
    r.cut = true;
    changed = true;
  }
  if (changed) await accountSession.set('runs', runs);
}

/** A handed task is over here (its run finished, or this Chrome no longer has it): the popup shows how it ended. */
async function endRun(runKey, how) {
  const runs = await session.get('runs', {});
  if (!runs[runKey]) return;
  runs[runKey].ended = { at: Date.now(), how };
  await accountSession.set('runs', runs);
}

async function webCall(body) {
  const name = String(body?.name || '');
  const runKey = runKeyOf(body);
  const turn = runTurnOf(body);
  const args = body?.args && typeof body.args === 'object' ? body.args : {};
  const early = paused ? PAUSED_TEXT : devtoolsBlocked ? BLOCKED_TEXT : (await stillStopped(runKey, turn)) ? STOPPED_TEXT : '';
  if (early) {
    await note({ kind: 'call', run: runKey, tool: name, what: describe(name, args), ok: false, outcome: 'ended', text: early === PAUSED_TEXT ? 'Refused: paused' : early === STOPPED_TEXT ? 'Refused: you stopped this run' : 'Refused: developer tools are off', ms: 0 });
    return text(early);
  }
  await sites();
  await loadPairing();
  if (runKey) await touchRun(runKey, name, args, turn);
  heardFrom(runKey && webAgent(runKey), runKey);
  const controller = new AbortController();
  const call = { runKey, controller, why: '' };
  inflight.add(call);
  ui();
  const started = Date.now();
  let result;
  try {
    const ended = new Promise(resolve => controller.signal.addEventListener('abort', () => resolve(text(call.why || STOPPED_TEXT)), { once: true }));
    result = await Promise.race([
      webCalls.webCall(body, { signal: controller.signal }).catch(error => ({ ...text(`Error: ${error.message}`), ...(error.refusal ? { refusal: error.refusal } : {}) })),
      ended,
    ]);
  } finally {
    inflight.delete(call);
    heardFrom(runKey && webAgent(runKey), runKey);
    ui();
  }
  if (WEB_TOOLS.has(name) || name === HANDOFF_TOOL) {
    const o = outcomeOf(result);
    await note({ kind: 'call', run: runKey, tool: name, what: describe(name, args), ok: o.ok, outcome: o.kind || 'ok', text: o.text, ms: Date.now() - started });
  }
  log('call', name, result?.isError ? 'refused or failed' : 'ok', `${Date.now() - started}ms`);
  return result;
}

/** End the calls in flight (all, or one run's) now, and let go of their tabs. */
async function endCalls(why, runKey = null) {
  for (const call of inflight) {
    if (runKey && call.runKey !== runKey) continue;
    call.why = why;
    call.controller.abort();
  }
  const H = conn.__predevHandoff;
  if (runKey) {
    const agent = runKey.startsWith('task:') ? taskAgent(runKey.slice(5)) : webAgent(runKey);
    for (const targetId of H?.owned?.get(agent) || []) await conn.detach(targetId);
  } else {
    await conn.detachAll();
  }
}

async function setPaused(on) {
  paused = !!on;
  wakeHolds();
  await local.set('paused', paused);
  if (paused) {
    await endCalls(PAUSED_TEXT);
    for (const entry of [...asking.values()]) if (!entry.decided) await decide(entry.nonce, false);
  }
  await note({ kind: 'control', text: paused ? 'Paused: web runs cannot use this Chrome' : 'Resumed' });
  ui();
}

/** The person stopped this run here, for the rest of its turn: every call of that turn is refused, however long
 *  the run waits between calls. A call from a later turn (the person sent a new message in that chat) ends the
 *  stop; a run in another chat is another run key, never blocked by it. With no turn named (an older pre.dev),
 *  the stop holds until this Chrome restarts. */
async function stillStopped(runKey, turn) {
  if (!runKey) return false;
  const stopped = await session.get('stopped', {});
  const stop = stopped[runKey];
  if (!stop) return false;
  if (turn && stop.turn && turn !== stop.turn) {
    delete stopped[runKey];
    await accountSession.set('stopped', stopped);
    await note({ kind: 'control', run: runKey, text: 'A new message in that chat: its run may use this Chrome again' });
    ui();
    return false;
  }
  // Stopped before the run named its turn: this call's turn is the one stopped.
  if (turn && !stop.turn) { stopped[runKey] = { ...stop, turn }; await accountSession.set('stopped', stopped); }
  return true;
}

async function stopRun(runKey) {
  runKey = String(runKey || '');
  if (!runKey) return;
  if (runKey.startsWith('task:')) return stopTask(runKey.slice(5));
  const runs = await session.get('runs', {});
  const stopped = await session.get('stopped', {});
  stopped[runKey] = { at: Date.now(), turn: runs[runKey]?.turn || '' };
  await accountSession.set('stopped', stopped);
  await endCalls(STOPPED_TEXT, runKey);
  await note({ kind: 'control', run: runKey, text: 'Stopped this run in this Chrome for the rest of its turn' });
  ui();
}

// ---------------------------------------------------------------- Finish in my Chrome

/** The tasks handed to this Chrome: only id, site, tab, the page its tab is on (origin and path) and who drives,
 *  never the task's instruction or progress. They outlast the browser session (every window closed, or Chrome
 *  restarted) so a run can carry on there, and are dropped after TASK_KEEP_MS, when the run ends, or on Unpair. */
const TASK_KEEP_MS = 6 * 3600000;
const handedTasks = {
  async list() {
    const list = await local.get('tasks', []);
    return (Array.isArray(list) ? list : []).filter(t => Date.now() - Date.parse(t.at || 0) < TASK_KEEP_MS);
  },
  // A task taken over, dropped or stopped here is a change its held ping answers (holdPing checks what changed).
  save: async list => { if (await paired()) { await local.set('tasks', list); wakeHolds(); } },
};
const taskInflight = new Map();
const taskCalls = createTaskCalls({
  callTool,
  ctx: () => ({ apiKey: pairingKey, apiUrl: apiBase(pairingCache) }),
  tabInfo: tab => conn.tabInfo(tab),
  isPrivate: targetId => !!targetId && conn.__predevPrivate.has(targetId),
  siteFor,
  isAllowed: isAllowedNow,
  askToAllow,
  webCalls,
  tasks: handedTasks,
  defaultProfile: () => PROFILE.dir,
  owned: agent => {
    const H = conn.__predevHandoff;
    if (!H?.owned) return null;
    if (!H.owned.has(agent)) H.owned.set(agent, new Set());
    return H.owned.get(agent);
  },
  approved: conn.__predevApproved || (conn.__predevApproved = new Map()),
  inflight: taskInflight,
  refresh: () => conn.refresh(),
  log: line => log(line),
  cloudOnly: true,
  busyOf: tab => api.busyOf(tab),
});

/** Paused or blocked here: no task run can use this Chrome, and no task is taken here. */
function chromeUnavailable() {
  if (paused) return PAUSED_TEXT;
  if (devtoolsBlocked) return BLOCKED_TEXT;
  return '';
}

/** Paused, blocked or stopped here: pre.dev's cloud run of a handed task finds this Chrome unavailable (it waits a
 *  moment, then stops with its progress saved, unbilled). */
async function taskUnavailable(taskId) {
  const why = chromeUnavailable();
  if (why) return why;
  const stopped = await session.get('stopped', {});
  if (stopped[`task:${taskId}`]) return STOPPED_TEXT;
  // Stopped here before every window closed: it stays stopped (the task keeps the mark).
  return (await handedTasks.list()).find(t => t.taskId === taskId)?.stopped ? STOPPED_TEXT : '';
}

/** Held pings. A handed task's run that is only waiting on this Chrome (a card open, or paused here) asks with
 *  ping { hold: { ms, seen } }: "answer when this task's state here is no longer <seen>, or after ms". Its answer
 *  comes the moment the person presses Pause, Resume or Stop this task, Chrome turns developer tools off (or back
 *  on), or the task leaves this Chrome, in a plain ping's shapes; no change in ms answers the same state. One per
 *  task: a newer one answers the older now. A ping without hold answers at once, as before. */
const HOLD_MAX_MS = 30000;
const HOLD_KINDS = new Set(['ok', 'paused', 'stopped', 'policy', 'busy']);
/** A held ping that last saw the tab busy looks again this often (a page that didn't answer says nothing when it does). */
const BUSY_LOOK_MS = 2000;
const holds = new Map();
const kindOf = why => (why === PAUSED_TEXT ? 'paused' : why === STOPPED_TEXT ? 'stopped' : why === BLOCKED_TEXT ? 'policy' : 'ok');
function holdOf(args) {
  const h = args?.hold;
  if (!h || typeof h !== 'object' || !HOLD_KINDS.has(h.seen)) return null;
  const ms = Math.min(HOLD_MAX_MS, Math.floor(Number(h.ms) || 0));
  return ms > 0 ? { ms, seen: h.seen } : null;
}
/** This Chrome's state for one task (or every task) may have changed: its held ping looks again now. */
function wakeHolds(taskId = '', how = 'state') {
  for (const [id, wake] of [...holds]) if (!taskId || id === taskId) wake(how);
}
/** A ping's answer for this task now: why it can't run here ('' when it can), and whether the task is still here
 *  for this run to drive (a plain ping answers a refusal otherwise). */
async function pingState(body) {
  const why = await taskUnavailable(cleanTaskId(body?.taskId));
  if (why) return { kind: kindOf(why), why };
  const r = await taskCalls.taskCall({ ...body, name: 'ping' });
  // 'busy': a dialog only the person may close is open in the task's tab, or its page doesn't answer (ping's busy).
  return r?.isError ? { kind: 'gone', why } : { kind: r?.busy ? 'busy' : 'ok', why };
}
async function holdPing(body, hold) {
  const taskId = cleanTaskId(body?.taskId);
  holds.get(taskId)?.('newer');
  const started = Date.now();
  const until = started + hold.ms;
  let state;
  let how = 'time';
  let mine = null;
  for (;;) {
    const woke = new Promise(resolve => { mine = resolve; });
    holds.set(taskId, mine);
    // Set before the look, so a change made while it reads is never missed.
    state = await pingState(body);
    const left = until - Date.now();
    if (state.kind !== hold.seen || left <= 0) break;
    const timer = setTimeout(mine, hold.seen === 'busy' ? Math.min(left, BUSY_LOOK_MS) : left, 'time');
    how = await woke;
    clearTimeout(timer);
    if (how === 'newer' || how === 'gone') break;
  }
  if (holds.get(taskId) === mine) holds.delete(taskId);
  log('held ping', taskId.slice(-6), `${hold.seen} -> ${how === 'gone' ? 'unpaired' : state.kind}`, how === 'newer' ? 'superseded' : '', `${Date.now() - started}ms`);
  return how === 'gone' ? { gone: true } : state;
}

/** A task handed here: the person sees it in the popup's runs and log. */
async function takeTaskHere(body) {
  const taskId = cleanTaskId(body?.taskId);
  // Paused or blocked here: refused. A Stop this task from an earlier turn of this task is not a refusal: that stop
  // ended the run it cut, and pre.dev hands a task here only when the person chooses Finish in my Chrome again, so
  // this is a new turn (Stop this task, Resume on pre.dev's card, then Finish in my Chrome on its next card). The
  // stop's mark is cleared once this turn is taken; until then the old turn's calls stay refused (taskUnavailable).
  const arrived = Date.now();
  const why = chromeUnavailable();
  if (why) {
    const error = why === PAUSED_TEXT ? 'the person paused pre.dev in this Chrome' : "this Chrome's settings turn off developer tools";
    await note({ kind: 'control', run: `task:${taskId}`, text: `A handed task was not taken: ${error}` });
    ui();
    // The refusal says why in a code too (POLICY_BLOCKED, PAUSED_BY_USER): pre.dev records a policy refusal from it
    // and not from the wording.
    return { accepted: false, error, ...(TASK_CODES.has(why) ? { code: TASK_CODES.get(why) } : {}) };
  }
  await sites();
  await loadPairing();
  const out = await taskCalls.takeTask(body);
  if (out.accepted) {
    // The earlier turn's stop is cleared. One pressed while this turn was being taken (the allow question can wait
    // minutes) stays: this turn's run then finds this Chrome stopped and stops with its progress saved.
    const stopped = await session.get('stopped', {});
    const mark = stopped[`task:${taskId}`];
    if (mark && !(Number(mark.at) >= arrived)) { delete stopped[`task:${taskId}`]; await accountSession.set('stopped', stopped); wakeHolds(taskId); }
    await touchRun(`task:${taskId}`, 'chrome_open', { url: body?.checkpoint?.url });
    // Handed here again after it ended: it is live again.
    const runs = await session.get('runs', {});
    if (runs[`task:${taskId}`]?.ended) { delete runs[`task:${taskId}`].ended; await accountSession.set('runs', runs); }
  }
  await note({ kind: 'control', run: `task:${taskId}`, text: out.accepted ? `A Browser Agents task was handed to this Chrome (${hostOf(String(body?.checkpoint?.url || '')) || 'its page'})` : `A handed task was not taken: ${out.error}` });
  ui();
  return out;
}

/** One call from pre.dev's cloud run of a task handed here: logged like a web run's, and ended by Pause, Stop or Unpair. */
async function taskCallHere(body) {
  const name = String(body?.name || '');
  const taskId = cleanTaskId(body?.taskId);
  const runKey = `task:${taskId}`;
  const args = body?.args && typeof body.args === 'object' ? body.args : {};
  // A ping too: while paused, blocked or stopped here the run must find this Chrome away (it waits, then stops with
  // its progress saved), so a ping that answered would send it straight back into the next refused call.
  let why = '';
  if (taskId) heardFrom(taskAgent(taskId), runKey);
  const hold = name === 'ping' && taskId ? holdOf(args) : null;
  if (hold) {
    // A held ping waits while this task's state here is the one its run last saw (holdPing). Its head went at once
    // (onRequest), so only the run times it.
    const now = await pingState(body);
    if (now.kind === hold.seen) {
      if (body?.__checkOnly) return {};
      const out = await holdPing(body, hold);
      if (out.gone) return { unavailable: 'This Chrome is no longer paired with pre.dev.' };
      if (!out.why) return { result: await taskCalls.taskCall(body) };
      why = out.why;
    } else why = now.why;
  } else if (taskId) why = await taskUnavailable(taskId);
  if (why) {
    await cutTaskRuns(runKey);
    if (name !== 'ping') await note({ kind: 'call', run: runKey, tool: name, what: describe(name, args), ok: false, outcome: 'ended', text: why === PAUSED_TEXT ? 'Refused: paused' : why === STOPPED_TEXT ? 'Refused: you stopped this task' : 'Refused: developer tools are off', ms: 0 });
    return { unavailable: why };
  }
  if (body?.__checkOnly) return {};
  if (name === 'ping') return { result: await taskCalls.taskCall(body) };
  await sites();
  await loadPairing();
  await touchRun(runKey, name, args);
  const controller = new AbortController();
  const call = { runKey, controller, why: '' };
  inflight.add(call);
  ui();
  const started = Date.now();
  let result;
  try {
    const ended = new Promise(resolve => controller.signal.addEventListener('abort', () => resolve({ unavailable: call.why || STOPPED_TEXT }), { once: true }));
    result = await Promise.race([
      taskCalls.taskCall(body).then(r => ({ result: r }), error => ({ result: { ...text(`Error: ${error.message}`), ...(error.refusal ? { refusal: error.refusal } : {}) } })),
      ended,
    ]);
  } finally {
    inflight.delete(call);
    if (taskId) heardFrom(taskAgent(taskId), runKey);
    ui();
  }
  // Chrome refused to attach during this call and developer tools turned out to be off here (a company setting):
  // the run is told so by its code, like a press of Stop or Pause, and never takes it for a failed step.
  if (!result.unavailable && devtoolsBlocked && result.result?.isError) result = { unavailable: BLOCKED_TEXT };
  if (result.unavailable) await cutTaskRuns(runKey);
  const o = result.unavailable ? { ok: false, kind: 'ended', text: result.unavailable === BLOCKED_TEXT ? 'Refused: developer tools are off' : 'Ended here' } : outcomeOf(result.result);
  await note({ kind: 'call', run: runKey, tool: name, what: describe(name, args), ok: o.ok, outcome: o.kind || 'ok', text: o.text, ms: Date.now() - started });
  log('task call', name, result.unavailable ? 'ended' : result.result?.refusal ? `refused (${result.result.refusal.kind})` : result.result?.isError ? 'failed' : 'ok', `${Date.now() - started}ms`);
  return result;
}

/** pre.dev: the cloud run of a handed task ended. */
async function taskDriverHere(body) {
  const out = await taskCalls.taskDriver(body);
  if (out.removed) {
    const runKey = `task:${cleanTaskId(body?.taskId)}`;
    // Finished here only if its run here was never cut off since its last call (see cutTaskRuns): after a stop
    // here, Resume on pre.dev's card carries the task on in the cloud, and this Chrome just no longer has it.
    const finished = body?.finished === true && !(await session.get('runs', {}))[runKey]?.cut;
    await endRun(runKey, finished ? 'finished' : 'ended');
    await note({ kind: 'control', run: runKey, text: finished ? 'The handed task finished' : 'The handed task ended here' });
    ui();
  }
  return out;
}

/** Stop this task here: its cloud run finds this Chrome unavailable (it stops with its progress saved). */
async function stopTask(taskId) {
  taskId = cleanTaskId(taskId);
  if (!taskId) return;
  // Already over (a popup opened before it finished): nothing to stop.
  if ((await session.get('runs', {}))[`task:${taskId}`]?.ended) return ui();
  const stopped = await session.get('stopped', {});
  stopped[`task:${taskId}`] = { at: Date.now() };
  await accountSession.set('stopped', stopped);
  wakeHolds(taskId);
  await cutTaskRuns(`task:${taskId}`);
  const list = await handedTasks.list();
  const t = list.find(x => x.taskId === taskId);
  if (t) { t.stopped = Date.now(); await handedTasks.save(list); }
  await endCalls(STOPPED_TEXT, `task:${taskId}`);
  await note({ kind: 'control', run: `task:${taskId}`, text: 'Stopped this task in this Chrome' });
  ui();
}

function webTools() {
  const ctx = { handoff: true, via: 'web', apiKey: pairingKey, cloud: false };
  return {
    tools: api.toolList(ctx).filter(t => WEB_TOOLS.has(t.name)),
    instructions: api.instructions(ctx),
  };
}

// ---------------------------------------------------------------- the tunnel

function frame(id, bytes) {
  const out = new Uint8Array(5 + bytes.length);
  out[0] = FRAME_BODY;
  new DataView(out.buffer).setUint32(1, id >>> 0);
  out.set(bytes, 5);
  return out;
}
const fromBase64 = b64 => new TextDecoder().decode(Uint8Array.from(atob(b64), c => c.charCodeAt(0)));

async function onRequest(socket, m) {
  // The head goes at once: a call that waits for the person here is timed by its caller.
  const head = st => socket.send(JSON.stringify({ t: 'res', id: m.id, status: st, headers: [['content-type', 'application/json']] }));
  const end = value => {
    if (socket.readyState !== WebSocket.OPEN) return;
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    for (let at = 0; at < bytes.length; at += CHUNK) socket.send(frame(m.id, bytes.subarray(at, at + CHUNK)));
    socket.send(JSON.stringify({ t: 'res-end', id: m.id }));
  };
  let body = null;
  try { body = m.body ? JSON.parse(fromBase64(m.body)) : null; } catch {}
  const route = `${m.method} ${String(m.path || '').split('?')[0]}`;
  try {
    // A handed task's call while this Chrome is paused, blocked or stopped for it: unavailable (503) with the reason's
    // code, so pre.dev's cloud run holds for a pause, and stops with its progress saved for a stop or a policy. A held
    // ping whose run already saw that state waits instead (holdPing).
    if (route === 'POST /tasks/call') {
      const out = await taskCallHere({ ...body, __checkOnly: true });
      if (out.unavailable) { head(503); end({ error: taskWords(out.unavailable), ...unavailableBody(out.unavailable) }); return; }
    }
    head(200);
    await loadPairing();
    if (route === 'GET /state') {
      end({ ok: true, chrome: !paused && !devtoolsBlocked, version: CONFIG.version, client: 'chrome-extension', ...(paused ? { paused: true } : {}), ...(devtoolsBlocked ? { blocked: true } : {}), profiles: [{ dir: PROFILE.dir, name: PROFILE.name, lastUsed: true }] });
    } else if (route === 'GET /tools') {
      end(webTools());
    } else if (route === 'POST /sites/revoke') {
      // Revoked on pre.dev: it stops here now.
      const site = String(body?.site || '');
      const list = { ...(await sites()) };
      const had = !!list[site]?.on;
      if (had && (await paired())) { delete list[site]; sitesCache = list; await local.set('sites', list); await note({ kind: 'control', text: `${site} revoked on pre.dev` }); }
      end({ ok: true, revoked: had });
      ui();
    } else if (route === 'POST /call') {
      end({ result: await webCall(body) });
    } else if (route === 'POST /tasks/continue') {
      end(await takeTaskHere(body));
    } else if (route === 'POST /tasks/call') {
      const out = await taskCallHere(body);
      // Ended while it ran (Pause, Stop, Unpair): the next call finds this Chrome unavailable.
      end(out.unavailable ? { result: text(taskWords(out.unavailable)), ...unavailableBody(out.unavailable) } : { result: out.result });
    } else if (route === 'POST /tasks/driver') {
      end(await taskDriverHere(body));
    } else {
      end({ error: 'not found' });
    }
  } catch (error) {
    log(route, 'error', error.message);
    end({ result: { ...text(`Error: ${error.message}`), ...(error.refusal ? { refusal: error.refusal } : {}) } });
  }
}

async function connectOnce() {
  const p = await loadPairing();
  if (!p?.apiUrl) { status = 'unpaired'; return 'stop'; }
  if (!p.key) { status = 'signed_out'; return 'later'; }
  let grant;
  try {
    const list = await sites();
    const r = await post('/computer-channel/tunnel', { computerId: await computerId(), sites: Object.keys(list).filter(s => list[s].on), client: 'chrome-extension' }, p);
    if (r.status === 409) {
      log('pre.dev says this Chrome is no longer paired; stopping');
      await forget('pre.dev unpaired this Chrome');
      return 'stop';
    }
    if (r.status === 404) { status = 'unavailable'; return 'later'; }
    if (r.status === 401 || r.status === 403) { status = 'signed_out'; lastError = r.json?.error || 'pre.dev did not accept the saved sign-in. Unpair and pair again.'; return 'later'; }
    if (!r.json?.grant?.url) { status = 'offline'; return 'retry'; }
    grant = r.json.grant;
    if (r.json.account && JSON.stringify(r.json.account) !== JSON.stringify(p.account) && (await local.get('pairing', null))?.key === p.key) await local.set('pairing', { ...p, account: r.json.account });
    await keepOnly(r.json.sites);
  } catch (error) {
    log('grant failed', error.message);
    status = 'offline';
    return 'retry';
  }
  // A browser WebSocket can't send headers: the grant and the ping interval go as subprotocols, and
  // the edge answers with predev-computer.v1 only (the grant never comes back).
  const protocols = ['predev-computer.v1', grant.token, `predev-ping.${PING_MS}`];
  try { if (new URL(grant.url).host !== grant.host) protocols.push(`predev-dev-host.${grant.host}`); } catch {}
  return new Promise(resolve => {
    let opened = false;
    let settled = false;
    let heardAt = Date.now();
    let pingTimer = null;
    let socket;
    try { socket = new WebSocket(grant.url, protocols); } catch (error) { log('socket', error.message); status = 'offline'; resolve('retry'); return; }
    ws = socket;
    socket.binaryType = 'arraybuffer';
    const finish = (next, why) => {
      if (settled) return;
      settled = true;
      clearInterval(pingTimer);
      clearTimeout(connectTimer);
      if (ws === socket) ws = null;
      if (status === 'online') status = 'offline';
      void cutTaskRuns();
      log('closed', why);
      try { socket.close(1000, 'reconnect'); } catch {}
      ui();
      resolve(next);
    };
    const connectTimer = setTimeout(() => { if (!opened) finish('retry', 'connect timed out'); }, 15000);
    socket.onopen = () => {
      opened = true;
      heardAt = Date.now();
      status = 'online';
      lastError = '';
      clearTimeout(connectTimer);
      log('connected');
      ui();
      pingTimer = setInterval(() => {
        if (Date.now() - heardAt > 2.5 * PING_MS) return finish('retry-now', 'no answer from pre.dev');
        try { socket.send('{"t":"ping"}'); } catch {}
      }, PING_MS);
    };
    socket.onmessage = event => {
      heardAt = Date.now();
      if (typeof event.data !== 'string') return;
      let m;
      try { m = JSON.parse(event.data); } catch { return; }
      if (m.t === 'req' && Number.isInteger(m.id)) void onRequest(socket, m);
      else if (m.t === 'bye') finish('check-now', `bye ${String(m.why || '').slice(0, 40)}`);
    };
    socket.onerror = () => {};
    socket.onclose = event => finish(event.code === 4003 ? 'check' : opened ? 'retry-now' : 'retry', `${event.code || ''} ${event.reason || ''}`.trim());
  });
}

async function loop() {
  if (running) return;
  running = true;
  let backoff = 1000;
  try {
    while (running) {
      const next = await connectOnce().catch(error => { log('error', error.message); return 'retry'; });
      ui();
      if (!running || next === 'stop') break;
      if (next === 'retry-now') backoff = 1000;
      const wait = next === 'later' ? 60000 : next === 'check' ? 2000 : next === 'check-now' ? 0 : backoff;
      backoff = Math.min(backoff * 2, 30000);
      await new Promise(resolve => { wake = resolve; setTimeout(resolve, wait); });
      wake = null;
    }
  } finally {
    running = false;
    if (status === 'online') status = 'offline';
    ui();
  }
}

function stopLoop() {
  running = false;
  try { ws?.close(1000, 'unpaired'); } catch {}
  wake?.();
}

// ---------------------------------------------------------------- pairing

function b64url(bytes) { return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }

/** The same sign-in as `npx -y @predotdev/mcp pair`: a device code the person approves on pre.dev
 *  (scope mcp), then this Chrome registered as theirs. */
async function pair() {
  if (pairingFlow) return;
  const url = apiBase(null);
  const flow = { cancelled: false, userCode: '', link: '' };
  pairingFlow = flow;
  lastError = '';
  ui();
  try {
    const verifier = b64url(crypto.getRandomValues(new Uint8Array(32)));
    const challenge = b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))));
    const state = b64url(crypto.getRandomValues(new Uint8Array(16)));
    const os = await platform();
    const start = await fetch(`${url}/oauth/device/authorize`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({
        client_id: CLIENT_ID, code_challenge: challenge, code_challenge_method: 'S256', state, scope: 'mcp',
        device_os: os, device_host: 'Chrome extension', cli_version: `predev-chrome-extension ${CONFIG.version}`,
      }),
    }).then(r => (r.ok ? r.json() : Promise.reject(new Error(`pre.dev answered ${r.status}`))));
    flow.userCode = start.user_code || '';
    flow.link = start.verification_uri_complete || '';
    ui();
    if (flow.link) await chrome.tabs.create({ url: flow.link, active: true });
    const until = Date.now() + (start.expires_in || 600) * 1000;
    let code = null;
    while (Date.now() < until && !code && !flow.cancelled) {
      await sleep((start.interval || 2) * 1000);
      const poll = await fetch(`${url}/oauth/cli/poll?state=${encodeURIComponent(state)}`, { signal: AbortSignal.timeout(15000) })
        .then(r => r.json()).catch(() => ({ pending: true }));
      if (poll.error) throw new Error(poll.error === 'access_denied' ? 'Pairing was denied on pre.dev.' : `Pairing failed: ${poll.error}`);
      if (poll.code) code = poll.code;
    }
    if (flow.cancelled) return;
    if (!code) throw new Error('The pairing code expired. Pair again for a new one.');
    const token = await fetch(`${url}/oauth/token`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: AbortSignal.timeout(20000),
      body: JSON.stringify({ grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: start.redirect_uri, client_id: CLIENT_ID }),
    }).then(r => (r.ok ? r.json() : Promise.reject(new Error(`pre.dev answered ${r.status} to the sign-in`))));
    if (!token.access_token) throw new Error('pre.dev did not return a key.');
    const name = `Chrome on ${os}`;
    const p = { apiUrl: url, key: token.access_token, name };
    const r = await post('/computer-channel/pair', { computerId: await computerId(), name, os, client: 'chrome-extension' }, p);
    if (r.status === 404) throw new Error('Pairing Chrome is not available on your pre.dev account yet.');
    if (r.status < 200 || r.status >= 300) throw new Error(`pre.dev could not pair this Chrome: ${r.json?.error || `HTTP ${r.status}`}`);
    await local.set('pairing', { ...p, account: r.json?.account || null, pairedAt: new Date().toISOString() });
    await local.set('paused', false);
    paused = false;
    await note({ kind: 'control', text: `Paired${r.json?.account?.email ? ` with ${r.json.account.email}` : ''}` });
    status = 'connecting';
    void loop();
  } catch (error) {
    lastError = error.message;
    log('pair failed', error.message);
  } finally {
    if (pairingFlow === flow) pairingFlow = null;
    ui();
  }
}

/** Unpaired (here or on pre.dev): everything stops now, and the key and sites are gone. */
async function forget(why) {
  stopLoop();
  wakeHolds('', 'gone');
  await endCalls(why === 'unpaired' ? 'The user unpaired their Chrome from pre.dev.' : 'This Chrome is no longer paired with pre.dev.');
  for (const entry of [...asking.values()]) if (!entry.decided) await decide(entry.nonce, false);
  // Everything tied to the account goes with it, so this Chrome paired again (maybe as someone else) shows and keeps
  // none of it: the key, the sites and tasks handed here, this Chrome's id on pre.dev (a new pairing is a new
  // computer), this session's runs, stops and log, and the runs' tabs and approvals. Writes check the pairing first
  // (accountSession, note), so once it is gone nothing a call began before lands after this.
  await local.remove(['pairing', 'sites', 'paused', 'tasks', 'computerId']);
  sitesCache = {};
  pairingCache = null;
  pairingKey = '';
  paused = false;
  status = 'unpaired';
  await logQueue;
  await chrome.storage.session.remove(['runs', 'stopped', 'log', 'ui']).catch(() => {});
  const H = conn.__predevHandoff;
  if (H) {
    H.owned?.clear();
    H.checks?.clear();
    H.cancel?.clear();
    if (Array.isArray(H.queue)) H.queue.length = 0;
    H.active = null;
  }
  conn.__predevApproved?.clear();
  taskInflight.clear();
  await note({ kind: 'control', text: why === 'unpaired' ? 'Unpaired: web runs can no longer reach this Chrome' : why }, { always: true });
  ui();
}

async function unpair() {
  const p = await pairing();
  const id = await computerId();
  await forget('unpaired');
  if (p?.apiUrl && p.key) {
    const r = await post('/computer-channel/unpair', { computerId: id }, p).catch(() => null);
    if (!r || r.status >= 300) lastError = `pre.dev did not confirm (${r ? `HTTP ${r.status}` : 'no answer'}); this Chrome stopped anyway.`;
  }
  ui();
}

// ---------------------------------------------------------------- the popup and the question page

chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  // Only this extension's own pages: the popup and the question page.
  if (sender.id !== chrome.runtime.id || !String(sender.url || '').startsWith(chrome.runtime.getURL(''))) return false;
  const fromPopup = String(sender.url).startsWith(chrome.runtime.getURL('popup.html'));
  const fromAllow = String(sender.url).startsWith(chrome.runtime.getURL('allow.html'));
  (async () => {
    switch (msg?.type) {
      case 'refresh': ui(); return { ok: true };
      case 'pair': if (fromPopup) void pair(); return { ok: true };
      case 'cancelPair': if (pairingFlow) pairingFlow.cancelled = true; pairingFlow = null; ui(); return { ok: true };
      case 'unpair': if (fromPopup) await unpair(); return { ok: true };
      case 'pause': if (fromPopup) await setPaused(!!msg.on); return { ok: true };
      case 'stopRun': if (fromPopup) await stopRun(msg.runKey); return { ok: true };
      case 'site': if (fromPopup) await setSite(msg.site, !!msg.on); return { ok: true };
      case 'checkDebugger': return fromPopup ? checkDebugger() : { ok: false };
      case 'question': {
        const entry = fromAllow ? byNonce.get(String(msg.nonce || '')) : null;
        return entry && !entry.decided ? { site: entry.site, question: allowQuestion(entry.site) } : { gone: true };
      }
      case 'decide': return fromAllow ? decide(msg.nonce, msg.decision === 'allow') : { ok: false };
      default: return { ok: false };
    }
  })().then(reply, error => reply({ ok: false, error: error.message }));
  return true;
});

// ---------------------------------------------------------------- start, and stay up

async function boot() {
  // Away until now (the service worker was not running): a handed task's run here may have stopped meanwhile.
  await cutTaskRuns();
  // A new browser session (every window of this Chrome was closed, or it restarted): the tabs of tasks handed here
  // are gone, so a run's next call on one opens it again on the page it was on (web_rules.mjs reopenTab).
  let reopen = false;
  if (!(await session.get('session', false))) {
    await session.set('session', true);
    const list = await handedTasks.list();
    reopen = list.some(t => t.tab);
    if (reopen) await handedTasks.save(list.map(t => (t.tab ? { ...t, reopen: true } : t)));
    await restoreTaskRuns(list);
  }
  paused = !!(await local.get('paused', false));
  devtoolsBlocked = String(await session.get('devtoolsBlocked', ''));
  await sites();
  // Those tabs open again now (in the background, never focused), not only on the run's next call: a run that comes
  // back to this Chrome and hands the person a step in "the tab pre.dev opened" finds the tab there.
  if (reopen) await taskCalls.reopenHanded().catch(error => log(`handed tasks reopen failed: ${error.message}`));
  if (await loadPairing()) { status = 'connecting'; void loop(); }
  ui();
}

chrome.alarms.create('keepalive', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener(async alarm => {
  if (alarm.name !== 'keepalive') return;
  if (!running && (await loadPairing())) void loop();
});
// ---------------------------------------------------------------- letting tabs go

/** A tab whose page has a dialog of its own open, or doesn't answer, has a card on pre.dev that waits on what this
 *  session knows of it: letting the tab go would forget the dialog, and the card would close while the dialog is
 *  still up. So such a tab stays while its card can still be open: the mark is younger than the card's longest hold
 *  (10 minutes, and a minute for the card to open) and a run that owns the tab goes on. A run goes on while a call
 *  of it is in flight here, a held ping of it waits, or it was heard from in the last RUN_QUIET_MS (a run waiting on
 *  a card pings back to back, each ping held at most HOLD_MAX_MS); one stopped or ended here does not. Once no run
 *  of the tab goes on, the tab goes at the next sweep; once the hold is past, as soon as it is idle. */
const DIALOG_CARD_MS = 11 * 60000;
const RUN_QUIET_MS = 2 * HOLD_MAX_MS;
const SWEEP_MS = 30000;
/** agent (handed:<task> or web:<run>) -> when its run last called or pinged here, and its run key. */
const heard = new Map();
function heardFrom(agent, runKey) { if (agent) heard.set(agent, { at: Date.now(), runKey }); }
async function runGoesOn(agent, now, state) {
  const h = heard.get(agent);
  const runKey = agent.startsWith('handed:') ? `task:${agent.slice(7)}` : h?.runKey;
  if (!runKey || state.stopped[runKey] || state.runs[runKey]?.ended) return false;
  if (runKey.startsWith('task:')) {
    const taskId = runKey.slice(5);
    const t = state.tasks.find(x => x.taskId === taskId);
    if (!t || t.stopped) return false;
    if (holds.has(taskId)) return true;
  }
  return [...inflight].some(c => c.runKey === runKey) || (!!h && now - h.at < RUN_QUIET_MS);
}
/** targetId -> the last thing logged for its mark ('kept' or 'let go'), so each shows once. */
const markLog = new Map();
let sweeping = false;
async function sweep() {
  if (inflight.size || sweeping) return;
  sweeping = true;
  try {
    const dlg = conn.__predevDialogs;
    const owned = conn.__predevHandoff?.owned;
    const idle = new Set(conn.idle(IDLE_DETACH_MS));
    let state = null;
    const now = Date.now();
    for (const targetId of conn.idle(0)) {
      const since = dlg?.open?.get(targetId)?.at ?? dlg?.noAnswer?.get(targetId);
      if (since === undefined) {
        markLog.delete(targetId);
        if (idle.has(targetId)) void conn.detach(targetId);
        continue;
      }
      const what = dlg?.open?.has(targetId) ? `a ${dlg.open.get(targetId).type || 'dialog'}` : 'no answer';
      const owners = [...(owned || [])].filter(([, tabs]) => tabs.has(targetId)).map(([agent]) => agent);
      state ||= { runs: await session.get('runs', {}), stopped: await session.get('stopped', {}), tasks: await handedTasks.list() };
      let on = '';
      if (now - since < DIALOG_CARD_MS) for (const agent of owners) if (await runGoesOn(agent, now, state)) { on = agent; break; }
      if (on) {
        if (markLog.get(targetId) !== 'kept') {
          markLog.set(targetId, 'kept');
          log('dialog hold', 'kept', targetId.slice(-6), `${what} for ${Math.round((now - since) / 1000)}s, ${on} goes on`);
        }
        continue;
      }
      // No run of it goes on: it goes now. The hold is past (or nobody owns it): it goes once idle, like any tab.
      if ((owners.length && now - since < DIALOG_CARD_MS) || idle.has(targetId)) {
        markLog.delete(targetId);
        log('dialog hold', 'let go', targetId.slice(-6), `${what} for ${Math.round((now - since) / 1000)}s, ${owners.length ? (now - since >= DIALOG_CARD_MS ? 'the card hold is past' : 'its run is over') : 'no run has it'}`);
        void conn.detach(targetId);
      }
    }
  } finally { sweeping = false; }
}
// Let go of tabs nobody is using, so Chrome's bar shows only while pre.dev works.
setInterval(() => { void sweep().catch(error => log('sweep failed', error?.message || error)); }, SWEEP_MS);
chrome.runtime.onStartup.addListener(() => { void boot(); });
chrome.runtime.onInstalled.addListener(() => { void boot(); });
void boot();

// For the tests in this repo's harness only (a dev build): nothing here is reachable from a web page.
if (CONFIG.dev) globalThis.__predev = { status: () => ({ status, paused, devtoolsBlocked, running, inflight: inflight.size, holds: holds.size }), conn, sites, callTool, webCall, taskCall: taskCallHere, checkDebugger };
