// "Allow pre.dev to use <site> in this Chrome?": the extension's own page, so no web run can see or
// click it. Only a real click answers.

const nonce = location.hash.slice(1);
const main = document.getElementById('main');

function parts(list) {
  const out = document.createDocumentFragment();
  for (const p of list) {
    if (typeof p === 'string') out.append(document.createTextNode(p));
    else { const b = document.createElement('b'); b.textContent = p.b; out.append(b); }
  }
  return out;
}
function line(tag, list, cls) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  node.append(parts(list));
  return node;
}
function done(allowed) {
  main.replaceChildren(line('p', [allowed ? 'Allowed. pre.dev carries on, and this tab closes.' : "Not allowed. pre.dev won't use this site here."]));
}

async function load() {
  const q = await chrome.runtime.sendMessage({ type: 'question', nonce }).catch(() => null);
  if (!q || q.gone) { main.replaceChildren(line('p', ['This question was already answered, or it timed out.'])); return; }
  document.title = `Allow pre.dev to use ${q.site}?`;
  // The title and two lines, nothing else.
  const nodes = [line('h1', q.question.title), ...q.question.lines.map(l => line('p', l))];
  const row = document.createElement('div');
  row.className = 'row';
  for (const [decision, label, cls] of [['allow', 'Allow', 'yes'], ['deny', "Don't allow", 'no']]) {
    const b = document.createElement('button');
    b.className = cls;
    b.textContent = label;
    b.addEventListener('click', async event => {
      if (!event.isTrusted) return;
      const r = await chrome.runtime.sendMessage({ type: 'decide', nonce, decision }).catch(() => null);
      if (r?.ok) done(decision === 'allow');
    });
    row.append(b);
  }
  nodes.push(row);
  main.replaceChildren(...nodes);
}
void load();
