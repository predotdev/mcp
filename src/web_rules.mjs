// What a pre.dev web run may do in the user's Chrome, for every client of the computer channel: the
// daemon (channel.mjs) and the pre.dev Chrome extension (extension/). One copy, so both behave the
// same way. No Node or Chrome APIs here: each client passes in how it reaches its Chrome, the user's
// allowed sites and the person at that computer.

/** What a web run may call here (pre.dev's backend has the same list). chrome_handoff is the
 *  handoff itself (bring the tab forward, check, wait, release, take back after the user). */
export const WEB_TOOLS = new Set(['chrome_profiles', 'chrome_tabs', 'chrome_open', 'chrome_navigate', 'chrome_snapshot', 'chrome_click',
  'chrome_type', 'chrome_act', 'chrome_press', 'chrome_scroll', 'chrome_read', 'chrome_wait', 'chrome_show', 'chrome_close']);
export const HANDOFF_TOOL = 'chrome_handoff';
/** What pre.dev's cloud run of a handed task may call here ("Finish in my Chrome"): a web run's tools
 *  minus the tab list and profile list, plus a screenshot of its own tab (its planner looks at the page).
 *  Still no scripts and no uploads. */
export const TASK_TOOLS = new Set(['chrome_open', 'chrome_navigate', 'chrome_snapshot', 'chrome_click', 'chrome_type', 'chrome_press',
  'chrome_scroll', 'chrome_read', 'chrome_wait', 'chrome_screenshot']);
/** Tools that can take a tab to another page: the page they end on is checked too. */
export const MOVES = new Set(['chrome_open', 'chrome_navigate', 'chrome_click', 'chrome_act', 'chrome_press', 'chrome_type', 'chrome_handoff']);
/** How long a call waits for the person at this computer to allow a new site. */
export const ALLOW_WAIT_MS = 120000;
/** The sign-in keeping lists pre.dev's brain sends with a call (handoff rule 3), and pre.dev's word that alerts in
 *  this call's tab stay for the person (`__predev_alert_auto_ok: false`; tools.mjs presses OK on them otherwise):
 *  the only `__` arguments a call from pre.dev may carry. */
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
/** Nobody answered the question in time (the next call asks again): that says nothing about what the
 *  person wants, so the run asks them. */
export const noAnswer = site => text(`No answer from the person in ${Math.round(ALLOW_WAIT_MS / 60000)} minutes: pre.dev asked on their computer whether web runs may use ${site} in their Chrome, nobody clicked, and the question closed. Don't call it again right away: tell them in one line that their Chrome is waiting for a click to allow ${site}; when they say go ahead, call again and the question comes back. Continue with what you have meanwhile.`);
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
  if (body?.args?.__predev_alert_auto_ok === false) args.__predev_alert_auto_ok = false;
  return args;
}

/** The run a web call names (its tabs are its own), or ''. */
export const runKeyOf = body => String(body?.run?.key || '').replace(/[^A-Za-z0-9:_-]/g, '').slice(0, 100);
/** The turn of that run a call belongs to (pre.dev names it: the person's latest message in that chat), or ''. */
export const runTurnOf = body => String(body?.run?.turn || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
/** The guard's scope for a web run: `web:<run>`. */
export const webAgent = runKey => (runKey.startsWith('web:') ? runKey : `web:${runKey}`);
/** How long one call may take: what pre.dev asked, within 5 s and 11 minutes. */
export const callTimeout = body => Math.min(Math.max(Number(body?.timeoutMs) || 180000, 5000), 11 * 60000);
/** A tool result's lines before its page line (`Tab ABC123 · ...`): what the call did, each line ending in a newline. */
export function actionLines(result) {
  const lines = String((result?.content || []).find(c => c.type === 'text')?.text || '').split('\n');
  const at = lines.findIndex(l => /^Tab [0-9A-F]{6,} ·/.test(l));
  return (at < 0 ? [] : lines.slice(0, at)).filter(l => l.trim()).map(l => `${l}\n`).join('');
}
/** The tab a tool result names first (`Tab ABC123 · ...`), or ''. */
export const tabInResult = result => /^Tab ([0-9A-F]{6,}) ·/m.exec((result?.content || []).find(c => c.type === 'text')?.text || '')?.[1] || '';

/** The question the person at this computer answers before a web run uses a new site. Each line is a
 *  list of parts: text, or { b: text } for the site, which a page shows in bold. */
export function allowQuestion(site) {
  return {
    title: ['Allow pre.dev to use ', { b: site }, ' in this Chrome?'],
    lines: [
      ['A run you started on pre.dev wants to work on ', { b: site }, ', signed in as you.'],
      ['It never types passwords and asks before it sends, posts, buys or deletes.'],
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
 *   askToAllow(site)           ask the person here; true once allowed, false when they said no,
 *                              'no_answer' when nobody answered in time, 'off' when the person turned
 *                              that site off here (then there is no question)
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
    // The site the tab is on now counts only for a call that works on that page. Leaving it (back, forward, another
    // address, closing the tab) needs no yes for it: the page a call ends on is checked after (movedTo).
    const leaves = name === 'chrome_close' || (name === 'chrome_navigate' && args.url && args.url !== 'reload');
    const info = args.tab && !leaves ? tabInfo(args.tab) : null;
    if (info) { const here = await siteFor(hostOf(info.url)); if (here && !wanted.includes(here)) wanted.push(here); }
    for (const site of wanted) {
      if (isAllowed(site)) continue;
      const ok = await askToAllow(site);
      if (ok === 'off') return { ...turnedOff(site), refusal: { kind: 'not_allowed', site } };
      if (ok === 'no_answer') return { ...noAnswer(site), refusal: { kind: 'not_allowed', site, answer: 'none' } };
      if (ok !== true) return { ...notAllowed(site), refusal: { kind: 'not_allowed', site } };
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
      // What the call did is kept (its first lines, such as where a click went); the page it ended on is not shown.
      return text(`${actionLines(result)}Tab ${tab} is now on ${site}, which web runs haven't used in the user's Chrome yet, so its page isn't shown. A call that works on this page asks the user to allow ${site} on their computer first; going back or opening another page needs no answer.`, false);
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

/** A handed task's id as pre.dev sends it. */
export const cleanTaskId = v => String(v || '').replace(/[^a-f0-9]/gi, '').slice(0, 40);
/** A handed task's own guard scope: its tabs are its own. */
export const taskAgent = taskId => `handed:${taskId}`;

/**
 * "Finish in my Chrome" for every client of the computer channel: a cloud Browser Agents task handed
 * to this computer, which pre.dev's cloud run carries on in this Chrome with this computer's rules.
 * On top of createWebCalls' parts, each client passes in:
 *   webCalls                 its createWebCalls(...) (sitesAllowed, movedTo)
 *   tasks                    { list(), save(list) }: where it keeps the handed tasks (no cookie or storage in them)
 *   defaultProfile()         the Chrome profile a task's tab opens in
 *   owned(agent)             the guard's set of tabs an agent opened (tools.mjs)
 *   approved, inflight       the guard's one-approved-control map, and calls in flight per task
 *   refresh()                makes the tab list current before a kept tab is looked up
 *   log(text)
 *   cloudOnly                true when nothing on this computer can take a task over (the extension): it keeps
 *                            only the task's id, site and tab, never its instruction or progress
 */
export function createTaskCalls({ callTool, ctx, tabInfo, isPrivate, siteFor, isAllowed, askToAllow, webCalls, tasks, defaultProfile, owned, approved, inflight, refresh = async () => {}, log = () => {}, cloudOnly = false, busyOf = async () => null }) {
  const handedTask = async taskId => (await tasks.list()).find(t => t.taskId === taskId) || null;

  /** One call from pre.dev's cloud run of a task handed here. It drives only the tabs it opened for that task
   *  (the one opened at hand-off, and its popups), with this computer's rules, and only while no agent here took
   *  the task over. */
  async function taskCall(body) {
    const taskId = cleanTaskId(body?.taskId);
    const name = String(body?.name || '');
    const t = taskId ? await handedTask(taskId) : null;
    // In the extension (cloudOnly) no agent on this computer takes a task over, so a task it no longer has lost its tab:
    // every window of this Chrome was closed, or Chrome restarted. The run stops with its progress saved, to resume in the cloud or here.
    if (!t) return cloudOnly
      ? refusedText("This Chrome doesn't have this task any more: its windows were closed or Chrome restarted, so the run's tab is gone.", { kind: 'tab_closed' })
      : refusedText('This task is not handed to this computer any more.', { kind: 'taken_over' });
    if (t.driver !== 'cloud') return refusedText('An agent on this computer has this task now.', { kind: 'taken_over' });
    // A ping says whether the task's tab is busy: { type } of a dialog open there that only the person may close
    // ('no_answer' when the page doesn't answer, with no dialog), or null. The run's card waits on it.
    if (name === 'ping') return { ...text('ok', false), busy: await busyOf(t.tab).catch(() => null) };
    const agent = taskAgent(taskId);
    const args = callArgs(body);
    args.__agent = agent;
    args.__predev_handoff = true;
    args.__via = 'web';
    // Of chrome_handoff, a handed task's run may: take the tab back after the user had it (a card's Done); hand the
    // user a sign-in step in its own tab without waiting (a passkey: the browser and Touch ID do it, nothing is typed),
    // with a done check from the URL or the page's structure; and run that check. Never a wait, a release of another
    // agent's tab, or any other reason.
    let handoffArgs = null;
    if (name === HANDOFF_TOOL) {
      const base = { tab: args.tab, __agent: agent, __predev_handoff: true, __via: 'web' };
      const kinds = ['url_changes', 'url_leaves', 'element_gone', 'element_present'];
      const done = args.done && typeof args.done === 'object' && kinds.includes(args.done.kind)
        ? { kind: args.done.kind, ...(typeof args.done.value === 'string' ? { value: args.done.value.slice(0, 300) } : {}) } : { kind: 'url_changes' };
      if (!args.tab) return text('A call for this task must name its tab.');
      if (args.reason === 'user_control' && args.resume === true) handoffArgs = { ...base, reason: 'user_control', resume: true };
      // A check for Chrome's own dialog keeps its reason: that check is whether a key reaches the page again.
      else if (args.check === true) handoffArgs = { ...base, check: true, ...(args.reason === 'chrome_dialog' ? { reason: 'chrome_dialog' } : {}) };
      else if ((args.reason === 'login_required' || args.reason === 'step_up') && args.wait === false) handoffArgs = { ...base, reason: args.reason, wait: false, done };
      else return text('Only the hand-back of the tab, a sign-in step handed to the user in it, and its check are available to this run.');
    } else if (!TASK_TOOLS.has(name)) return text(`${name || 'That tool'} isn't available to pre.dev's cloud run of this task.`);
    let reopened = '';
    if (args.tab) {
      // The tab this Chrome opened again for the task (below) answers to the run's old name for it too.
      if (t.was?.some(w => sameTab(args.tab, w))) args.tab = t.tab;
      let info = tabInfo(args.tab);
      if (!info && t.reopen && sameTab(args.tab, t.tab)) {
        reopened = await reopenTab(t, agent);
        if (reopened) { args.tab = reopened; info = tabInfo(reopened); }
      }
      // A tab opened again (above, or in an earlier hand-back of the tab) that asks to sign in: that sign-in lived
      // only in the browser session that ended (a session cookie). The run's next call, other than a hand-back,
      // hands the sign-in to the person, as for any password field, and never takes this page for its result.
      if (info && t.wallCheck && name !== HANDOFF_TOOL && sameTab(args.tab, t.tab)) {
        await clearWallCheck(t);
        if (await signInWall(args.tab, agent)) {
          const site = await siteFor(hostOf(info.url || t.page || '')) || t.site;
          return refusedText(`Every window of this Chrome was closed (or Chrome restarted) while the run had this task, so its tab was opened again as tab ${args.tab}, and the page now asks to sign in on ${site}: a sign-in that lived only in the closed browser session is gone. This page is not the task's result, and pre.dev never types the password: the person signs in again in that tab, then the run reads the page and carries on.`,
            { kind: 'secret', field: 'password', reopened: true });
        }
      }
      if (!info) return refusedText(`Tab ${String(args.tab).slice(0, 12)} is closed.`, { kind: 'tab_closed' });
      if (isPrivate(info.targetId)) return refusedText(PRIVATE_TAB, { kind: 'scope' });
      // The tab opened for this task stays this run's, also after this client restarted (the list says so).
      if (t.tab && info.targetId.toUpperCase().startsWith(String(t.tab).toUpperCase())) owned(agent)?.add(info.targetId);
    } else if (name !== 'chrome_open') return text('A call for this task must name its tab.');
    if (handoffArgs) {
      const r = await callTool(HANDOFF_TOOL, { ...handoffArgs, tab: args.tab }, ctx());
      if (cloudOnly) await notePage(taskId, args.tab, r);
      return withReopened(t, reopened, r);
    }
    if (name === 'chrome_open' && !args.profile) args.profile = defaultProfile();
    const blocked = await webCalls.sitesAllowed(name, args, body);
    if (blocked) return blocked;
    // An approval the person gave on pre.dev's card, for exactly one control (pre.dev checked the card).
    const ok = body?.approved && typeof body.approved === 'object' && typeof body.approved.desc === 'string' && typeof body.approved.page === 'string'
      ? { desc: body.approved.desc.slice(0, 500), page: body.approved.page.slice(0, 2000), at: Date.now() } : null;
    if (ok) approved.set(agent, ok);
    inflight.set(taskId, (inflight.get(taskId) || 0) + 1);
    let result;
    try {
      // Taken over while this call waited (a new site's question): it does not run.
      if ((await handedTask(taskId))?.driver !== 'cloud') return refusedText('An agent on this computer has this task now.', { kind: 'taken_over' });
      result = await callTool(name, args, { ...ctx(), signal: AbortSignal.timeout(callTimeout(body)) });
    } catch (error) {
      return { ...text(`Error: ${error.message}`), ...(error.refusal ? { refusal: error.refusal } : {}) };
    } finally {
      inflight.set(taskId, Math.max(0, (inflight.get(taskId) || 1) - 1));
      if (ok && approved.get(agent) === ok) approved.delete(agent);
    }
    if (cloudOnly) await notePage(taskId, args.tab, result);
    return withReopened(t, reopened, (await webCalls.movedTo(name, args, result)) || result);
  }

  /** A call that opened the task's tab again says so first, so the run reads the page before it acts. */
  const withReopened = (t, tab, out) => (tab ? { ...out, content: [{ type: 'text', text: `Every window of this Chrome was closed (or Chrome restarted) since the run's last call, so the task's tab was opened again on ${t.page} as tab ${tab}, and the page loaded fresh: read it before acting.` }, ...(out?.content || [])] } : out);

  const sameTab = (a, b) => !!a && !!b && String(a).toUpperCase() === String(b).toUpperCase();
  // Where a task's tab was, as origin and path only (no query or fragment, which can carry a token).
  const pageOf = url => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? `${u.origin}${u.pathname}` : ''; } catch { return ''; } };

  /** The extension: the page the task's tab is on after a call, so the tab can be opened there again. */
  async function notePage(taskId, tab, result) {
    const list = await tasks.list();
    const t = list.find(x => x.taskId === taskId);
    const id = tabInResult(result) || tab;
    if (!t || !sameTab(id, t.tab)) return;
    const page = pageOf(tabInfo(id)?.url || '');
    if (page && page !== t.page) { t.page = page; await tasks.save(list); }
  }

  /** The reopened tab's sign-in check is asked once. */
  async function clearWallCheck(t) {
    t.wallCheck = false;
    const list = await tasks.list();
    const now = list.find(x => x.taskId === t.taskId);
    if (now?.wallCheck) { delete now.wallCheck; await tasks.save(list); }
  }

  /** Does this tab show a sign-in form (a password field)? Asked only of a tab just opened again (below). */
  async function signInWall(tab, agent) {
    try {
      const r = await callTool('chrome_wait', { tab, selector: 'input[type=password]', timeout: 3, __agent: agent, __predev_handoff: true, __via: 'web' },
        { ...ctx(), signal: AbortSignal.timeout(15000) });
      return !r?.isError && /Condition met/.test((r?.content || []).map(c => c.text || '').join(' '));
    } catch { return false; }
  }

  /** The extension, after every window of this Chrome closed or Chrome restarted (it marks the task `reopen`): the
   *  task's tab is gone, so it opens again on the page it was on, once, if that site is still allowed. The run's old
   *  name for the tab keeps working. Returns the new tab, or ''. */
  async function reopenTab(t, agent) {
    const page = pageOf(t.page || '');
    const site = page ? await siteFor(hostOf(page)) : '';
    if (!site || !isAllowed(site)) return '';
    let tab = '';
    try {
      const opened = await callTool('chrome_open', { profile: defaultProfile(), url: page, foreground: false, __agent: agent, __predev_handoff: true, __via: 'web' },
        { ...ctx(), signal: AbortSignal.timeout(60000) });
      tab = tabInResult(opened);
    } catch (error) { log(`handed task reopen failed: ${error.message}`); }
    if (!tab) return '';
    const list = await tasks.list();
    const now = list.find(x => x.taskId === t.taskId);
    if (now) { now.was = [...(now.was || []), now.tab].filter(Boolean).slice(-5); now.tab = tab; now.reopen = false; now.wallCheck = true; await tasks.save(list); }
    t.was = now?.was || [t.tab]; t.tab = tab; t.reopen = false; t.wallCheck = true;
    await refresh().catch(() => {});
    log(`task ${t.taskId}: its tab opened again on ${site}`);
    return tab;
  }

  /** pre.dev: the cloud run of a handed task ended (or never started): it comes off the list, or waits for an agent here. */
  async function taskDriver(body) {
    const taskId = cleanTaskId(body?.taskId);
    const list = await tasks.list();
    const t = list.find(x => x.taskId === taskId);
    if (!t) return { ok: true, known: false };
    if (body?.finished === true && t.driver === 'cloud') {
      await tasks.save(list.filter(x => x.taskId !== taskId));
      log(`task ${taskId} finished by pre.dev's cloud run`);
      return { ok: true, removed: true };
    }
    if (body?.driver === 'local' && t.driver === 'cloud') {
      // Nothing here takes a task over (the extension): it comes off the list instead.
      if (cloudOnly) { await tasks.save(list.filter(x => x.taskId !== taskId)); log(`task ${taskId} ended here`); return { ok: true, removed: true }; }
      t.driver = 'local';
      await tasks.save(list);
      log(`task ${taskId} waits for an agent on this computer`);
    }
    return { ok: true, driver: t.driver || 'local' };
  }

  /** A cloud Browser Agents task handed here: keep it (an agent on this computer may take it over, where there is
   *  one), and open the page it stopped on in this Chrome, once the person here allows that site. Nothing in it is
   *  a cookie or storage. */
  async function takeTask(body) {
    const taskId = cleanTaskId(body?.taskId);
    const checkpoint = body?.checkpoint || {};
    const url = String(checkpoint.url || '');
    const host = hostOf(url);
    if (!taskId || !host) return { accepted: false, error: 'a handed-off task needs its id and the http(s) page it stopped on' };
    if (cloudOnly && body?.runner !== 'cloud') return { accepted: false, error: "this Chrome has no agent of its own to take a task over; only pre.dev's cloud run can carry a task on here" };
    const site = (typeof body?.site === 'string' && body.site && host.endsWith(body.site)) ? body.site : await siteFor(host);
    const ok = isAllowed(site) || await askToAllow(site);
    if (ok === 'no_answer') return { accepted: false, error: `no answer from the person at this computer in ${Math.round(ALLOW_WAIT_MS / 60000)} minutes to allow ${site}` };
    if (ok === 'off') return { accepted: false, error: `the person at this computer turned ${site} off for pre.dev runs` };
    if (ok !== true) return { accepted: false, error: `the person at this computer didn't allow ${site}` };
    const before = await tasks.list();
    const prior = before.find(t => t.taskId === taskId);
    const rest = before.filter(t => t.taskId !== taskId);
    let tab = '';
    // Handed here again (the computer was away, and the user chose it once more): the tab it had, if still open.
    if (prior?.tab) await refresh().catch(() => {});
    const kept = prior?.tab ? tabInfo(prior.tab) : null;
    if (kept && !isPrivate(kept.targetId)) tab = prior.tab;
    if (!tab) try {
      const opened = await callTool('chrome_open', { profile: defaultProfile(), url, foreground: false, __agent: taskAgent(taskId), __predev_handoff: true, __via: 'web' },
        { ...ctx(), signal: AbortSignal.timeout(60000) });
      tab = tabInResult(opened);
    } catch (error) { log(`handed task open failed: ${error.message}`); }
    rest.push({
      taskId, batchId: String(body?.batchId || ''), site, tab, at: new Date().toISOString(),
      // 'cloud': pre.dev's cloud carries it on in that tab by itself; else it waits for an agent here.
      driver: body?.runner === 'cloud' ? 'cloud' : 'local',
      // What an agent here needs to take it over (chrome_handed_off): only where one can. The extension keeps the
      // page the tab is on (origin and path), to open it there again after its windows closed.
      ...(cloudOnly ? { page: pageOf(url) } : {
        instruction: String(body?.instruction || '').slice(0, 20000),
        checkpoint: { url, step: Number(checkpoint.step) || 0, reason: String(checkpoint.reason || ''), memory: String(checkpoint.memory || '').slice(0, 8000),
          history: (Array.isArray(checkpoint.history) ? checkpoint.history : []).slice(-60) },
      }),
    });
    await tasks.save(rest.slice(-20));
    log(`task ${taskId} handed to this computer (${site}${body?.runner === 'cloud' ? ', carried on by pre.dev' : ''})`);
    return { accepted: true, ...(tab ? { tab } : {}) };
  }

  /** A new browser session (Chrome restarted, or every window of it closed): the tabs of the tasks handed here are
   *  gone. Each task still marked to reopen opens again now, in the background and never focused, on the page it was
   *  on, so a card that sends the person to "the tab pre.dev opened in your Chrome" finds that tab there. A tab that
   *  can't open again (its site no longer allowed here) stays marked, and the run's next call on it is told the tab
   *  is closed. */
  async function reopenHanded() {
    const out = [];
    for (const t of await tasks.list()) {
      if (!t.reopen || !t.tab || t.driver !== 'cloud' || tabInfo(t.tab)) continue;
      const tab = await reopenTab(t, taskAgent(cleanTaskId(t.taskId))).catch(() => '');
      if (!tab) log(`task ${t.taskId}: its tab could not be opened again`);
      out.push({ taskId: t.taskId, tab });
    }
    return out;
  }

  return { takeTask, taskCall, taskDriver, handedTask, reopenHanded };
}
