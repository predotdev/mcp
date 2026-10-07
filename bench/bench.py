#!/usr/bin/env python3
"""Claude in Chrome vs the pre.dev MCP: the same agent on the same browser tasks.

Both arms are Claude Code (`claude -p`) on the same model, with every built-in tool off (--tools "")
and exactly one browser tool set loaded:
  claude-in-chrome  --chrome (the Claude in Chrome extension), no MCP servers
  predev-mcp        --no-chrome, @predotdev/mcp 2.0.2 (Chrome tools only, PREDEV_MCP_CLOUD=off)
Both drive the same real Chrome. The prompt is identical and names no profile, so each side finds
its own way in. Tasks are public and read-only (one submits a form to httpbin, which only echoes it). Runs alternate arm order per repetition. Every run's raw
stream-json is kept in data/runs/, and results.jsonl gets one row per run.

  bench.py pilot <task> <arm>     one run, printed
  bench.py run [reps]              the full matrix (default 3 reps), resumable
"""
import json, os, re, subprocess, sys, time, urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
# BENCH_SETUP=everyday: Claude Code's built-in tools on (only WebFetch, WebSearch and Bash blocked, so the
# agent can't go around the browser) and the pre.dev MCP as setup installs it (cloud tools on).
SETUP = os.environ.get('BENCH_SETUP', 'browser-only')
TAG = '' if SETUP == 'browser-only' else f'-{SETUP}'
RUNS = os.path.join(HERE, f'runs{TAG}')
RESULTS = os.path.join(HERE, os.environ.get('BENCH_RESULTS', f'results{TAG}.jsonl'))
SCRATCH = os.environ['BENCH_SCRATCH']          # holds the MCP configs (the predev one has a key)
MODEL = 'claude-sonnet-5-5'
TIMEOUT_S = 420
PREFIX = 'Use only your browser tools. '
SUFFIX = ' Answer concisely.'


def get(url):
    req = urllib.request.Request(url, headers={'User-Agent': 'predev-bench/1', 'Accept': 'application/json'})
    return json.load(urllib.request.urlopen(req, timeout=30))


def norm(s):
    return re.sub(r'[^a-z0-9]+', ' ', s.lower()).strip()


def check_hn(ans):
    ids = get('https://hacker-news.firebaseio.com/v0/topstories.json')[:12]
    titles = [get(f'https://hacker-news.firebaseio.com/v0/item/{i}.json').get('title', '') for i in ids]
    found = sum(1 for t in titles if norm(t)[:40] and norm(t)[:40] in norm(ans))
    return found >= 4, f'{found} of the current top 12 titles named'


def check_gh(ans):
    tag = get('https://api.github.com/repos/microsoft/playwright/releases/latest')['tag_name']
    ok = tag.lstrip('v') in ans
    return ok, f'latest tag {tag}'


def check_npm(ans):
    v = get('https://registry.npmjs.org/zod')['dist-tags']['latest']
    return v in ans, f'latest version {v}'


def has_all(*needles):
    def check(ans):
        a = ans.lower()
        missing = [n for n in needles if not any(alt.lower() in a for alt in (n if isinstance(n, tuple) else (n,)))]
        return not missing, 'missing: ' + ', '.join(str(m) for m in missing) if missing else 'all expected values present'
    return check


TASKS = [
    dict(id='hn_top5', check=check_hn,
         prompt='Open https://news.ycombinator.com and list the titles and point counts of the top 5 stories.'),
    dict(id='wiki_infobox', check=has_all('1937', ('8,980', '8980', '1.70 mi', '1.7 mi', '2.74 km', '2,737', '2737')),
         prompt='On English Wikipedia, open the article on the Golden Gate Bridge and report its total length and the year it opened, from the infobox.'),
    dict(id='gh_release', check=check_gh,
         prompt='On GitHub, find the latest release of the repository microsoft/playwright on its Releases page: its version tag and release date.'),
    dict(id='dynamic_wait', check=has_all('all buttons clicked'),
         prompt='Go to https://testpages.eviltester.com/styled/dynamic-buttons-simple.html. Click the Start button, then click each new button as it appears, in order, until a message appears. Tell me the exact message.'),
    dict(id='table_read', check=has_all('roland mendel', 'austria'),
         prompt='On https://www.w3schools.com/html/html_tables.asp, in the Customers table, who is the contact for Ernst Handel, and which country is it in?'),
    dict(id='form_fill', check=has_all('ada lovelace', 'medium', 'bacon', 'cheese'),
         prompt='Go to https://httpbin.org/forms/post and fill in the order form: customer name "Ada Lovelace", telephone "555-0100", email "ada@example.com", size Medium, toppings Bacon and Extra Cheese, preferred delivery time 19:30, delivery instructions "Ring twice". Submit it (httpbin only echoes the form back), then report the custname, size and topping values from the JSON response.'),
    dict(id='multi_page', check=has_all('47.82', '20'),
         prompt='On https://books.toscrape.com, go to the Mystery category, open the book "Sharp Objects", and report its price and how many copies are in stock.'),
    dict(id='search_flow', check=check_npm,
         prompt='On https://www.npmjs.com, search for the package "zod", open its package page, and report the current version and the weekly downloads.'),
]
TASK = {t['id']: t for t in TASKS}


def arm_cmd(arm, prompt):
    # --setting-sources local: no user CLAUDE.md or settings, so personal instructions can't steer either arm.
    base = ['claude', '-p', '--setting-sources', 'local', '--strict-mcp-config', '--model', MODEL,
            '--output-format', 'stream-json', '--verbose', '--max-turns', '60']
    base += ['--tools', ''] if SETUP == 'browser-only' else ['--disallowedTools', 'WebFetch', 'WebSearch', 'Bash']
    if arm == 'claude-in-chrome':
        return base + ['--chrome', '--mcp-config', os.path.join(SCRATCH, 'empty-mcp.json'),
                       '--allowedTools', 'mcp__claude-in-chrome', '--', prompt]
    cfg = 'predev-mcp.json' if SETUP == 'browser-only' else 'predev-mcp-cloud.json'
    return base + ['--no-chrome', '--mcp-config', os.path.join(SCRATCH, cfg),
                   '--allowedTools', 'mcp__predev', '--', prompt]


def daemon_call(name, args):
    """The pre.dev MCP daemon (already allowed in Chrome) closes test tabs between runs."""
    # The default Chrome's daemon keeps its state in ~/.predev/mcp itself.
    for f in [os.path.expanduser('~/.predev/mcp/daemon.json')]:
        if not os.path.exists(f):
            continue
        st = json.load(open(f))
        req = urllib.request.Request(f'http://127.0.0.1:{st["port"]}/call', method='POST',
                                     data=json.dumps({'name': name, 'args': args}).encode(),
                                     headers={'x-bridge-token': st['token'], 'content-type': 'application/json'})
        try:
            return json.load(urllib.request.urlopen(req, timeout=30))
        except Exception as e:
            print(f'  (tab cleanup skipped: {e})')
            return None
    return None


TEST_HOSTS = ('news.ycombinator.com', 'wikipedia.org', 'github.com', 'testpages.eviltester.com',
              'w3schools.com', 'httpbin.org', 'books.toscrape.com', 'npmjs.com')
BASELINE = set()


def profile_tabs():
    """(tab id, url) for every tab in every Chrome profile."""
    r = daemon_call('chrome_tabs', {})
    if not r:
        return None
    text = '\n'.join(c.get('text', '') for c in r.get('content', []))
    return re.findall(r'^([0-9A-F]{6})\s+.*?\u00b7\s+(\S+)\s*$', text, re.M)


def close_test_tabs():
    """Close only tabs the benchmark opened: not there when it started, and on a test site."""
    tabs = profile_tabs()
    if tabs is None:
        return 0
    n = 0
    for tab, url in tabs:
        if tab in BASELINE or not any(h in url for h in TEST_HOSTS):
            continue
        daemon_call('chrome_close', {'tab': tab})
        n += 1
    return n


def parse(path):
    tools, batched, result, first_ts = {}, {}, {}, None
    for line in open(path):
        try:
            m = json.loads(line)
        except Exception:
            continue
        if m.get('type') == 'assistant':
            for c in m.get('message', {}).get('content', []):
                if c.get('type') == 'tool_use':
                    name = c['name'].split('__')[-1]
                    if name == 'computer':
                        name = f"computer.{c.get('input', {}).get('action', '?')}"
                    tools[name] = tools.get(name, 0) + 1
                    # A batch is one call carrying several actions: count what it carried too.
                    for act in (c.get('input', {}).get('actions') or []) if name == 'browser_batch' else []:
                        inner = act.get('name', '?')
                        if inner == 'computer':
                            inner = f"computer.{(act.get('input') or {}).get('action', '?')}"
                        batched[inner] = batched.get(inner, 0) + 1
        if m.get('type') == 'result':
            result = m
    u = result.get('usage', {}) or {}
    return dict(
        tools=tools, tool_calls=sum(tools.values()), batched=batched, batched_actions=sum(batched.values()),
        screenshots=sum(v for k, v in list(tools.items()) + list(batched.items()) if 'screenshot' in k),
        duration_ms=result.get('duration_ms'), duration_api_ms=result.get('duration_api_ms'),
        num_turns=result.get('num_turns'), cost_usd=result.get('total_cost_usd'),
        input_tokens=u.get('input_tokens', 0), cache_creation=u.get('cache_creation_input_tokens', 0),
        cache_read=u.get('cache_read_input_tokens', 0), output_tokens=u.get('output_tokens', 0),
        is_error=result.get('is_error'), subtype=result.get('subtype'), answer=result.get('result', ''),
    )


def run_one(task_id, arm, rep):
    t = TASK[task_id]
    os.makedirs(os.path.join(RUNS, arm), exist_ok=True)
    raw = os.path.join(RUNS, arm, f'{task_id}-r{rep}.jsonl')
    start = time.time()
    with open(raw, 'w') as out:
        p = subprocess.Popen(arm_cmd(arm, PREFIX + t['prompt'] + SUFFIX), stdout=out, stderr=subprocess.DEVNULL,
                             stdin=subprocess.DEVNULL, cwd=SCRATCH)
        try:
            p.wait(timeout=TIMEOUT_S)
            timed_out = False
        except subprocess.TimeoutExpired:
            p.kill()
            p.wait()
            timed_out = True
    wall = time.time() - start
    row = dict(task=task_id, arm=arm, rep=rep, model=MODEL, wall_s=round(wall, 1), timed_out=timed_out,
               at=time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime()), **parse(raw))
    try:
        ok, why = (False, 'timed out') if timed_out else t['check'](row['answer'] or '')
    except Exception as e:
        ok, why = False, f'checker error: {e}'
    row.update(passed=bool(ok), check_note=why)
    row['tabs_closed'] = close_test_tabs()
    return row


def done_keys():
    if not os.path.exists(RESULTS):
        return set()
    return {(r['task'], r['arm'], r['rep']) for r in map(json.loads, open(RESULTS))}


def show(r):
    print(f"{r['arm']:17} {r['task']:13} r{r['rep']} {'PASS' if r['passed'] else 'FAIL'} "
          f"{r['wall_s']:6.1f}s calls={r['tool_calls']:3} shots={r['screenshots']:2} "
          f"in={r['input_tokens'] + r['cache_creation'] + r['cache_read']:>8} out={r['output_tokens']:>6} "
          f"${(r['cost_usd'] or 0):.3f}  {r['check_note']}", flush=True)


if __name__ == '__main__':
    cmd = sys.argv[1]
    if cmd == 'pilot':
        r = run_one(sys.argv[2], sys.argv[3], 0)
        show(r)
        print('answer:', (r['answer'] or '')[:800])
        print('tools:', r['tools'])
    elif cmd == 'regrade':
        # Static checks only (live ones were graded against the value at run time).
        rows = [json.loads(l) for l in open(RESULTS)]
        for r in rows:
            t = TASK[r['task']]
            if t['check'] in (check_hn, check_gh, check_npm) or r['timed_out']:
                continue
            ok, why = t['check'](r['answer'] or '')
            if bool(ok) != r['passed']:
                print(f"regraded {r['arm']} {r['task']} r{r['rep']}: {r['passed']} -> {bool(ok)} ({why})")
            r.update(passed=bool(ok), check_note=why)
        with open(RESULTS + '.tmp', 'w') as f:
            f.writelines(json.dumps(r) + '\n' for r in rows)
        os.replace(RESULTS + '.tmp', RESULTS)
    elif cmd == 'run':
        reps = int(sys.argv[2]) if len(sys.argv) > 2 else 3
        have = done_keys()
        tabs = profile_tabs()
        if tabs is None:
            sys.exit('The pre.dev MCP daemon is not reachable; run one predev-mcp pilot first.')
        BASELINE.update(t for t, _ in tabs)
        print(f'{len(BASELINE)} tabs open before the run are never touched', flush=True)
        arms = ['claude-in-chrome', 'predev-mcp']
        only = sys.argv[3] if len(sys.argv) > 3 else None
        for rep in range(1, reps + 1):
            for i, t in enumerate(TASKS):
                order = arms if (rep + i) % 2 else arms[::-1]
                for arm in order:
                    if (t['id'], arm, rep) in have or (only and arm != only):
                        continue
                    r = run_one(t['id'], arm, rep)
                    with open(RESULTS, 'a') as f:
                        f.write(json.dumps(r) + '\n')
                    show(r)
