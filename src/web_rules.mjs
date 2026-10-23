// What a pre.dev web run may do in the user's Chrome, for every client of the computer channel: the
// daemon (channel.mjs) and the pre.dev Chrome extension (extension/). One copy, so both behave the
// same way. No Node or Chrome APIs here: each client passes in how it reaches its Chrome, the user's
// allowed sites and the person at that computer.

/** What a web run may call here (pre.dev's backend has the same list). chrome_handoff is the
 *  handoff itself (bring the tab forward, check, wait, release, take back after the user). */
export const WEB_TOOLS = new Set(['chrome_profiles', 'chrome_tabs', 'chrome_open', 'chrome_navigate', 'chrome_snapshot', 'chrome_click',
  'chrome_type', 'chrome_act', 'chrome_press', 'chrome_scroll', 'chrome_read', 'chrome_wait', 'chrome_show', 'chrome_close']);
export const HANDOFF_TOOL = 'chrome_handoff';
/** What pre.dev's cloud run of a handed task may call here ("Finish on my computer"): a web run's tools
 *  minus the tab list and profile list, plus a screenshot of its own tab (its planner looks at the page).
 *  Still no scripts and no uploads. */
export const TASK_TOOLS = new Set(['chrome_open', 'chrome_navigate', 'chrome_snapshot', 'chrome_click', 'chrome_type', 'chrome_press',
  'chrome_scroll', 'chrome_read', 'chrome_wait', 'chrome_screenshot']);
/** Tools that can take a tab to another page: the page they end on is checked too. */
export const MOVES = new Set(['chrome_open', 'chrome_navigate', 'chrome_click', 'chrome_act', 'chrome_press', 'chrome_type', 'chrome_handoff']);
/** How long a call waits for the person at this computer to allow a new site. */
export const ALLOW_WAIT_MS = 120000;
/** The sign-in keeping lists pre.dev's brain sends with a call (handoff rule 3): the only `__` arguments
 *  a call from pre.dev may carry. */
const KEEP_SIGN_IN_ARGS = ['__predev_signed_in', '__predev_signout_ok'];

/** An http(s) page's host, or '' (other schemes are never a web run's). */
export function hostOf(url) {
  let u;
  try { u = new URL(String(url)); } catch { return ''; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return '';
  return u.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}
/** This machine or a private network: the Allow question warns about these. */
export const isLocalHost = host => host === 'localhost' || host.endsWith('.localhost') || /^(127|10)\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|^::1$|^0\.0\.0\.0$/.test(host);

export const text = (t, isError = true) => ({ content: [{ type: 'text', text: t }], ...(isError ? { isError: true } : {}) });
/** A refusal a cloud run acts on (tools.mjs Refused): the same words, plus what it was for. */
export const refusedText = (t, refusal) => ({ ...text(t), refusal });
export const notAllowed = site => text(`The user didn't allow web runs to use ${site} in their Chrome (pre.dev asks on their computer the first time a web run uses a site). Don't retry on your own: tell them in one line what you need from ${site}, and continue with what you have.`);
/** A site the person turned off here (the extension's list of allowed sites): no question, a plain no. */
export const turnedOff = site => text(`The user turned ${site} off for web runs in their Chrome, so this run can't use it there. Don't retry or ask them to allow it: tell them in one line what you need from ${site} (they can tick it again from the pre.dev button in their Chrome's toolbar), and continue with what you have.`);
export const PRIVATE_TAB = "That tab is pre.dev's own question to the user; no run can use it.";

/** A call's arguments without pre.dev's own `__` flags (the computer sets those), except the
 *  brain's kept sign-in lists. */
export function callArgs(body) {
  const args = {};
  for (const [k, v] of Object.entries(body?.args || {})) if (!k.startsWith('__')) args[k] = v;
  for (const k of KEEP_SIGN_IN_ARGS) {
    if (Array.isArray(body?.args?.[k])) args[k] = body.args[k].filter(x => typeof x === 'string').slice(0, 50).map(x => x.slice(0, 255));
  }
  return args;
}

/** The run a web call names (its tabs are its own), or ''. */
export const runKeyOf = body => String(body?.run?.key || '').replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 100);
/** The guard's scope for a web run: `web:<run>`. */
export const webAgent = runKey => (runKey.startsWith('web:') ? runKey : `web:${runKey}`);
/** How long one call may take: what pre.dev asked, within 5 s and 11 minutes. */
export const callTimeout = body => Math.min(Math.max(Number(body?.timeoutMs) || 180000, 5000), 11 * 60000);
/** The tab a tool result names first (`Tab ABC123 · ...`), or ''. */
export const tabInResult = result => /^Tab ([0-9A-F]{6,}) ·/m.exec((result?.content || []).find(c => c.type === 'text')?.text || '')?.[1] || '';

/** The question the person at this computer answers before a web run uses a new site. Each line is a
 *  list of parts: text, or { b: text } for the site, which a page shows in bold. */
export function allowQuestion(site) {
  return {
    title: ['Allow pre.dev to use ', { b: site }, ' in this Chrome?'],
    lines: [
      ['A pre.dev run you started on the web wants to work on ', { b: site }, ' here, signed in as you. It reads and clicks only in tabs it opens.'],
      ['It never types passwords, codes or card numbers, and it asks you before it sends, posts, buys or deletes anything.'],
    ],
    warn: isLocalHost(site) ? 'This address is on this computer or your own network. Only allow it if you expect the run to use it.' : '',
  };
}
/** A question line as plain text. */
export const plainLine = parts => parts.map(p => (typeof p === 'string' ? p : p.b)).join('');

/**
 * The web run calls of one client, with that client's Chrome and person:
 *   callTool(name, args, ctx)  runs a chrome_* tool (tools.mjs) in this Chrome
 *   ctx()                      { apiKey, apiUrl } for the guard's checks
 *   tabInfo(tab)               the page target a tab id names, or null
 *   isPrivate(targetId)        pre.dev's own question tab
 *   siteFor(host)              the registrable domain pre.dev computes for a host
 *   isAllowed(site)            the person allowed it here
 *   askToAllow(site)           ask the person here; true once allowed, 'off' when the person turned that
 *                              site off here (then there is no question)
 */
export function createWebCalls({ callTool, ctx, tabInfo, isPrivate, siteFor, isAllowed, askToAllow }) {
  /** A new site needs a click here first: where the call goes, and where the tab is now. null when allowed. */
  async function sitesAllowed(name, args, body) {
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
      const ok = await askToAllow(site);
      if (ok === 'off') return { ...turnedOff(site), refusal: { kind: 'not_allowed', site } };
      if (!ok) return { ...notAllowed(site), refusal: { kind: 'not_allowed', site } };
    }
    return null;
  }

  /** The page a call ended on must be allowed too: else its text never leaves this computer. */
  async function movedTo(name, args, result) {
    if (!MOVES.has(name) || result?.isError) return null;
    const tab = tabInResult(result) || args.tab;
    const now = tab ? tabInfo(tab) : null;
    const site = now ? await siteFor(hostOf(now.url)) : '';
    if (site && !isAllowed(site)) {
      return text(`Tab ${tab} is now on ${site}, which web runs haven't used in the user's Chrome yet, so its page isn't shown. The next call on this tab asks the user to allow ${site} on their computer.`, false);
    }
    return null;
  }

  /** One call from a web run. `run.key` names the run, so its tabs are its own. `signal` ends it early. */
  async function webCall(body, { signal } = {}) {
    const name = String(body?.name || '');
    if (!WEB_TOOLS.has(name) && name !== HANDOFF_TOOL) return text(`${name || 'That tool'} isn't available to web runs in the user's Chrome.`);
    const args = callArgs(body);
    const runKey = runKeyOf(body);
    if (!runKey) return text('A web run must say which run it is.');
    // This computer's rules for every web run: the guard on, the run's own tabs.
    args.__agent = webAgent(runKey);
    args.__predev_handoff = true;
    args.__via = 'web';
    if (args.tab && isPrivate(tabInfo(args.tab)?.targetId)) return text(PRIVATE_TAB);
    const blocked = await sitesAllowed(name, args, body);
    if (blocked) return blocked;
    const timeout = AbortSignal.timeout(callTimeout(body));
    const result = await callTool(name, args, { ...ctx(), signal: signal ? AbortSignal.any([timeout, signal]) : timeout });
    return (await movedTo(name, args, result)) || result;
  }

  return { webCall, sitesAllowed, movedTo };
}
