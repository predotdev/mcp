// The connection tools.mjs drives Chrome through, made from chrome.debugger instead of a remote
// debugging port: the same shape as the daemon's Chrome class (bridge.mjs), so the chrome_* tools and
// their guard run unchanged here. It works when a company turns remote debugging off
// (RemoteDebuggingAllowed), because chrome.debugger is not the debugging port.
//
//   targets   targetId -> { targetId, type: 'page', url, title, browserContextId, openerId }, one per tab
//   sessions  targetId -> the debugger session for it (the targetId itself)
//   send(method, params, session, timeout)   a DevTools command to one tab, or one of the few
//             browser-level Target.* commands tools.mjs uses, done with chrome.tabs
//   session(targetId)                        attach to that tab (Chrome shows its "debugging this
//             browser" bar while any tab is attached; it is never hidden)
//
// Only web pages: chrome.debugger itself refuses chrome:// pages, other extensions and the Web Store,
// and this adapter refuses anything but http(s) and blank pages.

/** The one browser context an extension sees: its own profile. */
export const CONTEXT = 'default';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const ATTACHABLE = /^(https?:|about:blank|$)/;

export function createDebuggerChrome({ log = () => {}, beforeAttach = async () => {}, onDetach = () => {} } = {}) {
  const targets = new Map();
  const sessions = new Map();
  const tabOfTarget = new Map();
  const lastUsed = new Map();
  /** Tabs this adapter opened that no session has used yet: closed again if Chrome won't attach to them. */
  const fresh = new Set();

  function targetOfTab(tabId) {
    for (const [targetId, t] of tabOfTarget) if (t === tabId) return targetId;
    return null;
  }

  function infoOf(tab, targetId, targetOf) {
    return {
      targetId, type: 'page', url: tab.url || tab.pendingUrl || '', title: tab.title || '', browserContextId: CONTEXT,
      ...(tab.openerTabId != null && targetOf(tab.openerTabId) ? { openerId: targetOf(tab.openerTabId) } : {}),
      attached: sessions.has(targetId), tabId: tab.id, windowId: tab.windowId,
    };
  }

  /** Every tab of this profile, by its DevTools target id. */
  async function refresh() {
    const [list, tabs] = await Promise.all([chrome.debugger.getTargets(), chrome.tabs.query({})]);
    const byTab = new Map();
    for (const t of list) if (t.type === 'page' && typeof t.tabId === 'number') byTab.set(t.tabId, t.id);
    const targetOf = tabId => byTab.get(tabId) || null;
    const seen = new Set();
    for (const tab of tabs) {
      const targetId = byTab.get(tab.id);
      if (!targetId) continue;
      seen.add(targetId);
      tabOfTarget.set(targetId, tab.id);
      targets.set(targetId, infoOf(tab, targetId, targetOf));
    }
    for (const targetId of [...targets.keys()]) if (!seen.has(targetId)) { targets.delete(targetId); tabOfTarget.delete(targetId); sessions.delete(targetId); }
  }

  // Keep the list current between calls (a handoff waits on it: a closed tab ends it).
  chrome.tabs.onRemoved.addListener(tabId => {
    const targetId = targetOfTab(tabId);
    if (!targetId) return;
    fresh.delete(targetId);
    targets.delete(targetId);
    tabOfTarget.delete(targetId);
    sessions.delete(targetId);
  });
  chrome.tabs.onUpdated.addListener((tabId, change, tab) => {
    const targetId = targetOfTab(tabId);
    if (!targetId || !targets.has(targetId)) { if (change.url || change.status) void refresh().catch(() => {}); return; }
    const prev = targets.get(targetId);
    targets.set(targetId, { ...prev, url: tab.url || prev.url, title: tab.title ?? prev.title });
  });
  chrome.tabs.onCreated.addListener(() => { void refresh().catch(() => {}); });
  chrome.debugger.onDetach.addListener((source, reason) => {
    const targetId = source.targetId || (source.tabId != null ? targetOfTab(source.tabId) : null);
    if (!targetId) return;
    sessions.delete(targetId);
    // Scripts added for each new document belong to the session that ended: add them again next time.
    conn.__predevHandoff?.watched?.delete(targetId);
    log('debugger', 'detached', reason);
    onDetach(targetId, reason);
  });

  function timed(promise, timeout, method) {
    let timer;
    return Promise.race([
      promise.finally(() => clearTimeout(timer)),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`Chrome did not answer ${method} within ${timeout / 1000}s.`)), timeout); }),
    ]);
  }

  async function tabIdOf(targetId) {
    if (!tabOfTarget.has(targetId)) await refresh();
    const tabId = tabOfTarget.get(targetId);
    if (tabId == null) throw new Error('That tab is closed.');
    return tabId;
  }

  async function createTarget({ url = 'about:blank', background = true } = {}) {
    let windowId;
    try {
      const win = await chrome.windows.getLastFocused({ windowTypes: ['normal'] });
      if (win?.type === 'normal' && !win.incognito) windowId = win.id;
    } catch {}
    if (windowId == null) {
      const made = await chrome.windows.create({ focused: !background, type: 'normal' });
      windowId = made.id;
    }
    const tab = await chrome.tabs.create({ url, active: !background, windowId });
    for (let i = 0; i < 60; i++) {
      await refresh();
      const targetId = targetOfTab(tab.id);
      if (targetId) { fresh.add(targetId); return { targetId }; }
      await sleep(50);
    }
    throw new Error('Chrome did not open the tab.');
  }

  async function browserLevel(method, params) {
    switch (method) {
      case 'Target.getBrowserContexts': return { defaultBrowserContextId: CONTEXT, browserContextIds: [] };
      case 'Target.getTargets': await refresh(); return { targetInfos: [...targets.values()] };
      case 'Target.createTarget': return createTarget(params);
      case 'Target.closeTarget': {
        await chrome.tabs.remove(await tabIdOf(params.targetId));
        return { success: true };
      }
      case 'Target.activateTarget': {
        const tab = await chrome.tabs.update(await tabIdOf(params.targetId), { active: true });
        await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
        return {};
      }
      default: throw new Error(`${method} is not available in the pre.dev extension.`);
    }
  }

  const conn = {
    targets,
    sessions,
    get connected() { return true; },
    async connect() { await refresh(); },
    send(method, params = {}, sessionId, timeout = 15000) {
      if (!sessionId) return timed(browserLevel(method, params), timeout, method);
      lastUsed.set(sessionId, Date.now());
      return timed(chrome.debugger.sendCommand({ targetId: sessionId }, method, params), timeout, method);
    },
    async session(targetId) {
      lastUsed.set(targetId, Date.now());
      const existing = sessions.get(targetId);
      if (existing) return existing;
      if (!targets.has(targetId)) await refresh();
      const info = targets.get(targetId);
      if (!info) throw new Error('That tab is closed.');
      if (!ATTACHABLE.test(info.url)) throw new Error('pre.dev works only on web pages (http and https) in this Chrome.');
      await beforeAttach(targetId);
      try {
        await chrome.debugger.attach({ targetId }, '1.3');
      } catch (error) {
        // Ours already (a session this worker lost track of): carry on with it.
        const mine = /already attached/i.test(String(error?.message)) && (await chrome.debugger.getTargets()).find(t => t.id === targetId);
        if (!mine?.attached) {
          // A tab opened for this call that Chrome won't let us use: don't leave it behind.
          if (fresh.delete(targetId)) await chrome.tabs.remove(await tabIdOf(targetId)).catch(() => {});
          error.attachFailed = true;
          throw error;
        }
      }
      fresh.delete(targetId);
      sessions.set(targetId, targetId);
      // Background tabs are throttled or frozen; keep them responsive while a run drives them.
      await conn.send('Page.setWebLifecycleState', { state: 'active' }, targetId).catch(() => {});
      await conn.send('Emulation.setFocusEmulationEnabled', { enabled: true }, targetId).catch(() => {});
      return targetId;
    },
    /** Let one tab go (Chrome's bar goes away once no tab is attached). */
    async detach(targetId) {
      if (!sessions.has(targetId)) return;
      sessions.delete(targetId);
      conn.__predevHandoff?.watched?.delete(targetId);
      await chrome.debugger.detach({ targetId }).catch(() => {});
    },
    async detachAll() { await Promise.all([...sessions.keys()].map(id => conn.detach(id))); },
    /** Tabs attached but unused for this long, and not held for a handoff. */
    idle(ms) {
      const held = conn.__predevHandoff?.handoff;
      return [...sessions.keys()].filter(id => Date.now() - (lastUsed.get(id) || 0) > ms && !held?.has(id));
    },
    tabInfo(tab) {
      const wanted = String(tab || '').trim().toUpperCase();
      if (!wanted) return null;
      const hits = [...targets.values()].filter(t => t.targetId.toUpperCase().startsWith(wanted));
      return hits.length === 1 ? hits[0] : null;
    },
    targetOfTab,
    tabIdOf,
    refresh,
  };
  return conn;
}
