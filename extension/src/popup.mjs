// The pre.dev button in Chrome's toolbar: the paired account, the sites web runs may use here (tick or
// untick), what pre.dev did (Activity), and Pause, Stop and Unpair, which take effect at once.

const $ = id => document.getElementById(id);
const send = msg => chrome.runtime.sendMessage(msg).catch(() => null);
// Five states on the pill: Online, Offline, Paused, Blocked (render), Not paired.
const STATUS = {
  online: ['Online', 'online'], connecting: ['Offline', ''], offline: ['Offline', ''], signed_out: ['Not paired', ''],
  unavailable: ['Not paired', ''], unpaired: ['Not paired', ''], pairing: ['Not paired', ''],
};
const ACTIVITY_SHOWN = 10;

let view = {};
let sites = {};
let log = [];

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else if (v !== false && v != null) node.setAttribute(k, v);
  }
  for (const c of children) node.append(c?.nodeType ? c : document.createTextNode(String(c ?? '')));
  return node;
}

const timeOf = at => new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
// "Task on <host>" (a Browser Agents task handed here) or "Chat run on <host>" (a web run from a chat), on the
// site it used last.
const runName = r => {
  const host = r.hosts?.length ? r.hosts[r.hosts.length - 1] : '';
  const what = String(r.key || '').startsWith('task:') ? 'Task' : 'Chat run';
  return host ? `${what} on ${host}` : what;
};
const endedNote = e => (e.how === 'finished' ? `Finished ${timeOf(e.at)}` : `Moved off this Chrome ${timeOf(e.at)}`);
const stoppedNote = key => (String(key).startsWith('task:') ? 'Stopped by you. Progress kept.' : 'Stopped until your next message');
// An element ref ([e13]) means nothing to the person: the log never shows one.
const noRefs = s => String(s ?? '').replace(/ into \[e\d+\]/g, '').replace(/\s*\[e\d+\]/g, '');

function render() {
  const paired = !!view.account || ['online', 'connecting', 'offline', 'signed_out', 'unavailable'].includes(view.status);
  const [label, cls] = view.devtoolsBlocked ? ['Blocked', 'blocked'] : view.paused && paired ? ['Paused', 'paused'] : STATUS[view.status] || [view.status || '...', ''];
  $('pill').textContent = label;
  $('pill').className = `pill ${cls}`;

  const blocked = !!view.devtoolsBlocked;
  $('blocked').hidden = !blocked;
  $('blocked').textContent = blocked
    ? "Your company turned off developer tools in this Chrome, so pre.dev can't work here. Runs use the cloud browser."
    : '';

  $('unpaired').hidden = view.status !== 'unpaired';
  $('pairing').hidden = view.status !== 'pairing';
  $('paired').hidden = view.status === 'unpaired' || view.status === 'pairing';
  $('code').textContent = view.pairing?.userCode || '';

  const who = view.account?.email || view.account?.name;
  $('account').textContent = who ? `Paired with ${who}` : 'Paired with your pre.dev account';
  // Signed out on pre.dev's side (or its computer channel is off): the pill says Not paired, so no "Paired with".
  $('account').hidden = label === 'Not paired';
  // Blocked: nothing here can work, so neither Pause nor Stop is offered.
  $('pauseRow').hidden = blocked;
  $('pause').textContent = view.paused ? 'Resume' : 'Pause';
  $('pauseNote').textContent = view.paused ? 'Web runs cannot use this Chrome until you resume.' : '';

  const runs = $('runs');
  runs.replaceChildren(...(view.runs || []).filter(r => Date.now() - r.last < 30 * 60000).slice(0, 3).map(r => el('div', { class: 'run' },
    el('div', { class: 'what' }, el('b', {}, runName(r)), el('br'), el('span', { class: 'dim small' }, r.ended
      ? endedNote(r.ended)
      : r.stopped
        ? stoppedNote(r.key)
        : r.active ? 'Working' : `Last step ${timeOf(r.last)}`)),
    // A finished or stopped run has nothing left to stop; a blocked Chrome runs nothing.
    ...(r.stopped || r.ended || blocked ? [] : [el('button', { onclick: () => send({ type: 'stopRun', runKey: r.key }) }, 'Stop')]),
  )));

  const names = Object.keys(sites).sort();
  $('noSites').hidden = names.length > 0;
  $('sites').replaceChildren(...names.map(site => el('li', {},
    el('label', {},
      el('input', { type: 'checkbox', checked: !!sites[site].on, onchange: e => send({ type: 'site', site, on: e.target.checked }) }),
      site),
  )));

  // Activity, collapsed: the last 10 entries, newest first.
  $('activityTitle').textContent = `Activity (${log.length})`;
  $('noLog').hidden = log.length > 0;
  $('log').replaceChildren(...log.slice(-ACTIVITY_SHOWN).reverse().map(e => el('li', {},
    el('time', {}, timeOf(e.at)),
    el('span', { class: e.kind === 'control' ? 'control' : e.ok ? '' : e.outcome === 'error' ? 'failed' : 'refused' },
      noRefs(e.kind === 'control' ? e.text : `${e.what}${e.ok ? '' : `: ${e.text}`}`)),
  )));

  $('error').hidden = !view.error;
  $('error').textContent = view.error || '';
  $('dev').hidden = !view.dev;
  $('dev').textContent = view.dev ? `Development build: ${view.apiUrl}` : '';
}

async function load() {
  const s = await chrome.storage.session.get(['ui', 'log']);
  const l = await chrome.storage.local.get(['sites']);
  view = s.ui || {};
  log = s.log || [];
  sites = l.sites || {};
  render();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'session' && changes.ui) view = changes.ui.newValue || {};
  if (area === 'session' && changes.log) log = changes.log.newValue || [];
  if (area === 'local' && changes.sites) sites = changes.sites.newValue || {};
  render();
});

$('pair').addEventListener('click', () => send({ type: 'pair' }));
$('cancel').addEventListener('click', () => send({ type: 'cancelPair' }));
$('again').addEventListener('click', e => { e.preventDefault(); if (view.pairing?.link) chrome.tabs.create({ url: view.pairing.link }); });
$('pause').addEventListener('click', () => send({ type: 'pause', on: !view.paused }));
$('unpair').addEventListener('click', () => send({ type: 'unpair' }));

void load();
void send({ type: 'refresh' });
