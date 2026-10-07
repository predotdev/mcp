#!/usr/bin/env python3
"""Summarize data/results.jsonl (one row per run) and write chart specs + summary.json.

Every number in the post comes from here. Medians per task, then the median of task medians per arm
(so one slow task can't dominate), plus totals across all runs.
  analyze.py            print the tables, write data/summary.json and charts/*.json
"""
import json, os, statistics as st

HERE = os.path.dirname(os.path.abspath(__file__))
SETUP = os.environ.get('BENCH_SETUP', 'browser-only')
TAG = '' if SETUP == 'browser-only' else f'-{SETUP}'
ROWS = [json.loads(l) for l in open(os.path.join(HERE, f'results{TAG}.jsonl'))]
ARMS = ['claude-in-chrome', 'predev-mcp']
NAME = {'claude-in-chrome': 'Claude in Chrome', 'predev-mcp': 'pre.dev MCP'}
TASKS = []
for r in ROWS:
    if r['task'] not in TASKS:
        TASKS.append(r['task'])
LABEL = {'hn_top5': 'Read a list (HN top 5)', 'wiki_infobox': 'Find facts (Wikipedia)',
         'gh_release': 'Find a release (GitHub)', 'dynamic_wait': 'Click as buttons appear',
         'table_read': 'Read a table', 'form_fill': 'Fill and submit a form',
         'multi_page': 'Browse 3 pages (books)', 'search_flow': 'Search, open, read (npm)'}


def tokens(r):
    return r['input_tokens'] + r['cache_creation'] + r['cache_read']


def med(xs):
    return st.median(xs) if xs else None


METRICS = {
    'wall_s': lambda r: r['wall_s'],
    'tokens': tokens,
    'cost_usd': lambda r: r['cost_usd'] or 0,
    'tool_calls': lambda r: r['tool_calls'],
    'screenshots': lambda r: r['screenshots'],
    'output_tokens': lambda r: r['output_tokens'],
}

summary = {'runs': len(ROWS), 'tasks': TASKS, 'per_task': {}, 'per_arm': {}}
for t in TASKS:
    summary['per_task'][t] = {}
    for a in ARMS:
        rs = [r for r in ROWS if r['task'] == t and r['arm'] == a]
        if not rs:
            continue
        summary['per_task'][t][a] = dict(
            n=len(rs), passed=sum(r['passed'] for r in rs),
            **{k: med([f(r) for r in rs]) for k, f in METRICS.items()})
for a in ARMS:
    rs = [r for r in ROWS if r['arm'] == a]
    if not rs:
        continue
    pt = [summary['per_task'][t][a] for t in TASKS if a in summary['per_task'][t]]
    summary['per_arm'][a] = dict(
        runs=len(rs), passed=sum(r['passed'] for r in rs), pass_rate=sum(r['passed'] for r in rs) / len(rs),
        timed_out=sum(r['timed_out'] for r in rs),
        total_wall_s=sum(r['wall_s'] for r in rs), total_cost_usd=sum(r['cost_usd'] or 0 for r in rs),
        total_tokens=sum(tokens(r) for r in rs), total_tool_calls=sum(r['tool_calls'] for r in rs),
        total_screenshots=sum(r['screenshots'] for r in rs),
        **{f'median_task_{k}': med([p[k] for p in pt]) for k in METRICS})

json.dump(summary, open(os.path.join(HERE, f'summary{TAG}.json'), 'w'), indent=2)

print(f"{'arm':18} runs pass  med_s  med_tok  med_$   calls shots   total_s  total_$")
for a, s in summary['per_arm'].items():
    print(f"{a:18} {s['runs']:4} {s['passed']:4} {s['median_task_wall_s']:6.1f} {s['median_task_tokens']:8.0f} "
          f"{s['median_task_cost_usd']:.3f} {s['median_task_tool_calls']:5.1f} {s['median_task_screenshots']:5.1f} "
          f"{s['total_wall_s']:8.0f} {s['total_cost_usd']:7.2f}")
print()
print(f"{'task':14} " + ' | '.join(f'{NAME[a]:>34}' for a in ARMS))
for t in TASKS:
    cells = []
    for a in ARMS:
        p = summary['per_task'][t].get(a)
        cells.append(f"{p['passed']}/{p['n']} {p['wall_s']:6.1f}s {p['tokens']:7.0f}t {p['tool_calls']:4.1f}c {p['screenshots']:3.1f}ss" if p else ' ' * 34)
    print(f'{t:14} ' + ' | '.join(f'{c:>34}' for c in cells))
