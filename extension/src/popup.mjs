// The pre.dev button in Chrome's toolbar: the paired account, the sites web runs may use here (tick or
// untick), what pre.dev did, and Pause, Stop this run and Unpair, which take effect at once.

const $ = id => document.getElementById(id);
const send = msg => chrome.runtime.sendMessage(msg).catch(() => null);
const STATUS = {
  online: ['Online', 'online'], connecting: ['Connecting', ''], offline: ['Offline', ''], signed_out: ['Signed out', ''],
  unavailable: ['Not available yet', ''], unpaired: ['Not paired', ''], pairing: ['Pairing', ''],
};

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
const runName = key => {
  const parts = String(key || '').split(':');
  if (parts[0] === 'task') return `Browser Agents task ${String(parts[1] || '').slice(-6)}`;
  return parts.length >= 2 ? `Web run in project ${parts[1].slice(0, 6)}` : 'Web run';
};
const stoppedNote = key => (String(key).startsWith('task:')
  ? 'Stopped here: pre.dev keeps its progress.'
  : "Stopped for the rest of this turn: it can use this Chrome again when you send a new message in that chat.");

function render() {
  const paired = !!view.account || ['online', 'connecting', 'offline', 'signed_out', 'unavailable'].includes(view.status);
  const [label, cls] = view.devtoolsBlocked ? ['Blocked', 'blocked'] : view.paused && paired ? ['Paused', 'paused'] : STATUS[view.status] || [view.status || '...', ''];
  $('pill').textContent = label;
  $('pill').className = `pill ${cls}`;

  $('blocked').hidden = !view.devtoolsBlocked;
  $('blocked').textContent = view.devtoolsBlocked
    ? "Your company's Chrome settings turn off developer tools, and pre.dev needs them to work in a tab. pre.dev can't act in this Chrome, so web runs use pre.dev's cloud browser instead. Ask your IT team if you need it here."
    : '';

  $('unpaired').hidden = view.status !== 'unpaired';
  $('pairing').hidden = view.status !== 'pairing';
  $('paired').hidden = view.status === 'unpaired' || view.status === 'pairing';
  $('code').textContent = view.pairing?.userCode || '';

  const who = view.account?.email || view.account?.name;
  $('account').textContent = who ? `Paired with ${who}` : 'Paired with your pre.dev account';
  $('pause').textContent = view.paused ? 'Resume' : 'Pause';
  $('pauseNote').textContent = view.paused ? 'Web runs cannot use this Chrome until you resume.' : '';

  const runs = $('runs');
  runs.replaceChildren(...(view.runs || []).filter(r => Date.now() - r.last < 30 * 60000).slice(0, 3).map(r => el('div', { class: 'run' },
    el('div', { class: 'what' }, el('b', {}, runName(r.key)), el('br'), el('span', { class: 'dim small' }, r.stopped
      ? stoppedNote(r.key)
      : `${r.active ? 'Working now' : `Last step ${timeOf(r.last)}`}${r.hosts?.length ? ` on ${r.hosts.join(', ')}` : ''}`)),
    ...(r.stopped ? [] : [el('button', { onclick: () => send({ type: 'stopRun', runKey: r.key }) }, String(r.key).startsWith('task:') ? 'Stop this task' : 'Stop this run')]),
  )));

  const names = Object.keys(sites).sort();
  $('noSites').hidden = names.length > 0;
  $('sites').replaceChildren(...names.map(site => el('li', {},
    el('label', {},
      el('input', { type: 'checkbox', checked: !!sites[site].on, onchange: e => send({ type: 'site', site, on: e.target.checked }) }),
      site),
  )));

  $('noLog').hidden = log.length > 0;
  $('log').replaceChildren(...log.slice().reverse().slice(0, 80).map(e => el('li', {},
    el('time', {}, timeOf(e.at)),
    el('span', { class: e.kind === 'control' ? 'control' : e.ok ? '' : e.outcome === 'error' ? 'failed' : 'refused' },
      e.kind === 'control' ? e.text : `${e.what}${e.ok ? '' : `: ${e.text}`}`),
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
