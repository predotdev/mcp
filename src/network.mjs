// The cloud browser through this computer's network: for internal sites behind a VPN or an
// office IP allow-list. A pre.dev cloud Browser Agents run that this computer's user started can
// send its connections for the sites they chose ("Reach through my computer") here, and this
// computer opens them on its own network.
//
//   - Only sites on this computer's own list, which only its person adds: `predev-mcp network
//     add <site>` here, or "Reach through my computer" on pre.dev, which asks here first. Each is
//     a registrable site (it and its subdomains) or one exact host, and its site is one of the
//     sites this computer allowed. Anything else is refused here, whatever pre.dev asks.
//   - Never this computer itself (loopback), link-local or multicast addresses.
//   - Bytes only: for https the cloud browser's own TLS goes through untouched, so neither this
//     computer nor pre.dev can read the page. Plain http is the site's own choice.
//   - Limits per run (open connections, connections, bytes), and a log of every connection:
//     host, port, bytes and the run id, never content. pre.dev shows the recent ones.
//
// Turning it off: `predev-mcp network remove <site>`, revoke the site, or unpair.

import dns from 'node:dns';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

const FRAME_NET = 3;
const CHUNK = 64 * 1024;
const CONNECT_TIMEOUT_MS = 10000;
const LOOKUP_TIMEOUT_MS = 8000;
const LOG_MAX_BYTES = 512 * 1024;
const LOG_KEEP_LINES = 1000;
/** This computer's own caps per run (pre.dev's may only be lower). */
const OWN_LIMITS = { maxOpen: 32, maxConnections: 1000, maxBytes: 200 * 1024 * 1024 };

export const networkFiles = stateDir => ({
  sites: path.join(stateDir, 'web-network.json'),
  log: path.join(stateDir, 'network-log.jsonl'),
});

/** The sites runs may reach through this computer: { site: { kind, allowedSite, addedAt } }. */
export function readNetworkSites(stateDir) {
  try { return JSON.parse(fs.readFileSync(networkFiles(stateDir).sites, 'utf8'))?.sites || {}; } catch { return {}; }
}

export function writeNetworkSites(stateDir, sites) {
  const file = networkFiles(stateDir).sites;
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ sites }, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}

/** The last connections this computer opened for runs (newest last). */
export function readNetworkLog(stateDir, n = 20) {
  try {
    const lines = fs.readFileSync(networkFiles(stateDir).log, 'utf8').trim().split('\n').filter(Boolean);
    return lines.slice(-n).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}

/** A host as runs name it: lower case, no brackets, no final dot; '' when it is not a host. */
export function cleanHost(raw) {
  const host = String(raw || '').trim().toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (net.isIP(host)) return host;
  return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/.test(host) ? host : '';
}

/** What someone typed (a site, a host, a URL) as a host, or ''. */
export function hostFromInput(input) {
  const raw = String(input || '').trim().toLowerCase();
  if (!raw) return '';
  try { return cleanHost(new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(raw) ? raw : `http://${raw}`).hostname); } catch { return ''; }
}

/** This computer itself, link-local, unspecified or multicast: never reached for a run. */
export function unreachableAddress(addr) {
  const a = String(addr || '').toLowerCase();
  if (a === 'localhost' || a.endsWith('.localhost')) return true;
  const v = net.isIP(a);
  if (v === 4) return /^(127\.|0\.|169\.254\.|22[4-9]\.|23\d\.|2[45]\d\.)/.test(a);
  if (v === 6) return a === '::1' || a === '::' || /^fe[89ab][0-9a-f]:/.test(a) || /^ff/.test(a) || /^::ffff:(127|0|169\.254)\./.test(a);
  return false;
}

/** Does a list entry cover this host? An exact host, or a site and its subdomains. */
export const covers = (site, entry, host) => (entry?.kind === 'host' ? host === site : host === site || host.endsWith(`.${site}`));

/** The entry for a host: an exact host first, then the site that covers it. */
export function entryFor(sites, host) {
  if (sites[host]?.kind === 'host') return [host, sites[host]];
  for (const [site, entry] of Object.entries(sites)) if (entry?.kind === 'domain' && covers(site, entry, host)) return [site, entry];
  return null;
}

/** A list entry from pre.dev or the CLI, checked: the site's allowed site must contain it. */
export function checkedEntry(value) {
  const site = cleanHost(value?.site);
  const allowedSite = cleanHost(value?.allowedSite) || site;
  const kind = value?.kind === 'domain' && !net.isIP(site) ? 'domain' : 'host';
  if (!site || unreachableAddress(site)) return null;
  if (!(site === allowedSite || site.endsWith(`.${allowedSite}`))) return null;
  return { site, kind, allowedSite };
}

const lookup = host => new Promise((resolve) => {
  const timer = setTimeout(() => resolve([]), LOOKUP_TIMEOUT_MS);
  dns.lookup(host, { all: true, verbatim: true }, (err, addrs) => {
    clearTimeout(timer);
    resolve(err ? [] : (addrs || []).map(a => a.address));
  });
});

/**
 * The tunnel side (channel.mjs hands it the edge's messages for run connections).
 *   ctx: { stateDir, log, allowedSites(), send(data), report(events) }
 */
export function createNetwork(ctx) {
  const { stateDir, log } = ctx;
  const files = networkFiles(stateDir);
  /** Open connections: id -> { socket, run, host, port, up, down, at, opened }. */
  const conns = new Map();
  /** Per run: { open, total, bytes }. */
  const runs = new Map();
  let limits = { ...OWN_LIMITS };
  let pending = [];
  let flushTimer = null;

  const sites = () => readNetworkSites(stateDir);
  const useOf = run => {
    let u = runs.get(run);
    if (!u) { u = { open: 0, total: 0, bytes: 0 }; runs.set(run, u); if (runs.size > 200) runs.delete(runs.keys().next().value); }
    return u;
  };
  const frame = (id, bytes) => {
    const out = Buffer.alloc(5 + bytes.length);
    out[0] = FRAME_NET;
    out.writeUInt32BE(id >>> 0, 1);
    bytes.copy(out, 5);
    return out;
  };
  const sendJson = value => { try { ctx.send(JSON.stringify(value)); } catch {} };

  /** The log: one line per connection, host, port, bytes and run id. Never content. */
  function record(event) {
    try {
      fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
      fs.appendFileSync(files.log, `${JSON.stringify(event)}\n`, { mode: 0o600 });
      if (fs.statSync(files.log).size > LOG_MAX_BYTES) {
        const keep = fs.readFileSync(files.log, 'utf8').trim().split('\n').slice(-LOG_KEEP_LINES).join('\n');
        const tmp = `${files.log}.${process.pid}`;
        fs.writeFileSync(tmp, `${keep}\n`, { mode: 0o600 });
        fs.renameSync(tmp, files.log);
      }
    } catch (error) { log('network', 'log write failed', error.message); }
    pending.push(event);
    if (pending.length > 200) pending = pending.slice(-200);
    scheduleFlush();
  }

  /** pre.dev keeps the same record (Integrations > Your computers shows the recent ones). */
  function scheduleFlush() {
    if (flushTimer || !pending.length) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const events = pending.splice(0, 50);
      void Promise.resolve(ctx.report(events)).catch(error => log('network', 'use report failed', error.message));
      scheduleFlush();
    }, 3000);
    flushTimer.unref?.();
  }

  function refuse(m, why, message, extra = {}) {
    sendJson({ t: 'net-refused', id: m.id, why, message });
    record({ at: Date.now(), run: String(m.run || '').slice(0, 64), host: String(m.host || '').slice(0, 253), port: Number(m.port) || 0, up: 0, down: 0, ms: 0, result: why, ...extra });
    log('network', `refused ${String(m.host || '').slice(0, 80)}:${Number(m.port) || 0} (${why})`);
  }

  /** The edge asks to open a connection for a run. */
  async function open(m) {
    if (!Number.isInteger(m?.id)) return;
    const run = String(m.run || '').replace(/[^A-Za-z0-9_-]/g, '').slice(0, 64);
    const host = cleanHost(m.host);
    const port = Number(m.port);
    if (!run || !host) return refuse(m, 'bad_request', 'That connection request is not valid.');
    const list = sites();
    const hit = entryFor(list, host);
    // This computer's own list decides, whatever pre.dev asked.
    if (!hit) return refuse(m, 'not_listed', `${host} isn't one of the sites this computer lets pre.dev runs reach.`);
    const [, entry] = hit;
    if (!ctx.allowedSites()[entry.allowedSite]) return refuse(m, 'not_allowed', `${entry.allowedSite} isn't allowed on this computer any more.`);
    if (!Number.isInteger(port) || port < 1 || port > 65535 || (port < 1024 && port !== 80 && port !== 443)) {
      return refuse(m, 'port', `Runs reach ${host} through this computer on ports 80, 443 and 1024 and up only.`);
    }
    if (unreachableAddress(host)) return refuse(m, 'address', `${host} is this computer itself.`);
    const use = useOf(run);
    if (use.open >= limits.maxOpen || use.total >= limits.maxConnections || use.bytes >= limits.maxBytes) {
      return refuse(m, 'limit', 'This run used all the connections or data it may send through this computer.');
    }
    // Resolved here, on this computer's network (its VPN and DNS), and connected to the address
    // that was checked, so a name can't point somewhere else in between.
    const addrs = net.isIP(host) ? [host] : await lookup(host);
    if (!addrs.length) return refuse(m, 'dns', `${host} couldn't be found on this computer's network.`);
    const addr = addrs.find(a => !unreachableAddress(a));
    if (!addr) return refuse(m, 'address', `${host} points at this computer itself or a link-local address.`);
    use.open++;
    use.total++;
    const started = Date.now();
    const conn = { socket: null, run, host, port, up: 0, down: 0, at: started, opened: false, done: false };
    conns.set(m.id, conn);
    const socket = net.connect({ host: addr, port });
    conn.socket = socket;
    socket.setNoDelay(true);
    const timer = setTimeout(() => socket.destroy(new Error('connect timeout')), CONNECT_TIMEOUT_MS);
    const finish = (result) => {
      if (conn.done) return;
      conn.done = true;
      clearTimeout(timer);
      conns.delete(m.id);
      use.open = Math.max(0, use.open - 1);
      if (conn.opened) sendJson({ t: 'net-close', id: m.id });
      else sendJson({ t: 'net-refused', id: m.id, why: 'connect', message: `${host}:${port} didn't answer on this computer's network.` });
      record({ at: started, run, host, port, up: conn.up, down: conn.down, ms: Date.now() - started, result: conn.opened ? result : 'connect_failed' });
      socket.destroy();
    };
    socket.once('connect', () => {
      clearTimeout(timer);
      conn.opened = true;
      sendJson({ t: 'net-opened', id: m.id });
    });
    socket.on('data', chunk => {
      conn.down += chunk.length;
      use.bytes += chunk.length;
      if (use.bytes > limits.maxBytes) return finish('limit');
      for (let at = 0; at < chunk.length; at += CHUNK) {
        try { ctx.send(frame(m.id, chunk.subarray(at, at + CHUNK))); } catch { return finish('tunnel_closed'); }
      }
    });
    socket.on('error', () => finish('error'));
    socket.on('close', () => finish('ok'));
  }

  /** A run's bytes for one of its connections. */
  function data(id, bytes) {
    const conn = conns.get(id);
    if (!conn?.opened) { if (!conn) sendJson({ t: 'net-close', id }); return; }
    conn.up += bytes.length;
    const use = useOf(conn.run);
    use.bytes += bytes.length;
    if (use.bytes > limits.maxBytes) { conn.socket.destroy(); return; }
    conn.socket.write(bytes);
  }

  return {
    open,
    data,
    /** A binary frame from the tunnel: true when it was a run connection's. */
    frame(raw) {
      const bytes = Buffer.from(raw);
      if (bytes.length < 5 || bytes[0] !== FRAME_NET) return false;
      data(bytes.readUInt32BE(1), bytes.subarray(5));
      return true;
    },
    close(id) { conns.get(id)?.socket?.destroy(); },
    /** The tunnel went away: every run connection ends with it. */
    closeAll() { for (const conn of [...conns.values()]) conn.socket?.destroy(); },
    /** pre.dev's limits for runs (lower than this computer's own only). */
    setLimits(l) {
      if (!l || typeof l !== 'object') return;
      for (const k of Object.keys(OWN_LIMITS)) if (Number(l[k]) > 0) limits[k] = Math.min(OWN_LIMITS[k], Number(l[k]));
    },
    sites,
    list: () => Object.keys(sites()),
    add(value) {
      const entry = checkedEntry(value);
      if (!entry) return null;
      const list = sites();
      list[entry.site] = { kind: entry.kind, allowedSite: entry.allowedSite, addedAt: new Date().toISOString() };
      writeNetworkSites(stateDir, list);
      log('network', `reach ${entry.site} (${entry.kind}) through this computer`);
      return entry;
    },
    remove(site) {
      const list = sites();
      const key = cleanHost(site) || String(site || '');
      if (!list[key]) return false;
      delete list[key];
      writeNetworkSites(stateDir, list);
      // Connections already open for it end now.
      for (const conn of [...conns.values()]) if (covers(key, { kind: 'domain' }, conn.host) && !entryFor(list, conn.host)) conn.socket?.destroy();
      log('network', `no longer reach ${key} through this computer`);
      return true;
    },
    /** An allowed site was revoked: the network sites in it go too. */
    dropForAllowedSite(allowedSite) {
      const list = sites();
      let dropped = 0;
      for (const [site, entry] of Object.entries(list)) if (entry?.allowedSite === allowedSite) { delete list[site]; dropped++; }
      if (dropped) writeNetworkSites(stateDir, list);
      return dropped;
    },
    /** pre.dev's list at (re)connect: one removed there while this computer was away drops here. */
    keepOnly(atPredev) {
      if (!Array.isArray(atPredev)) return;
      const keep = new Set(atPredev.map(e => (typeof e === 'string' ? e : e?.site)).filter(Boolean));
      const list = sites();
      let dropped = 0;
      for (const site of Object.keys(list)) if (!keep.has(site)) { delete list[site]; dropped++; }
      if (dropped) { writeNetworkSites(stateDir, list); log('network', `dropped ${dropped} network site(s) removed at pre.dev`); }
    },
    recent: n => readNetworkLog(stateDir, n),
  };
}
