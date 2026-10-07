#!/usr/bin/env python3
"""Where the time and tokens go, from the raw stream-json of every run in results.jsonl."""
import json, os, glob, statistics as st, collections
HERE = os.path.dirname(os.path.abspath(__file__))
SETUP = os.environ.get('BENCH_SETUP', 'browser-only')
TAG = '' if SETUP == 'browser-only' else f'-{SETUP}'
rows = [json.loads(l) for l in open(os.path.join(HERE, f'results{TAG}.jsonl'))]
out = {}
for arm in ['claude-in-chrome', 'predev-mcp']:
    first_ctx, per_call_ctx, result_chars, images, tool_mix = [], [], collections.Counter(), 0, collections.Counter()
    result_sizes = collections.defaultdict(list)
    for r in [x for x in rows if x['arm'] == arm]:
        path = os.path.join(HERE, f'runs{TAG}', arm, f"{r['task']}-r{r['rep']}.jsonl")
        names = {}
        calls = []
        for line in open(path):
            m = json.loads(line)
            if m.get('type') == 'assistant':
                u = m['message'].get('usage') or {}
                ctx = u.get('input_tokens', 0) + u.get('cache_creation_input_tokens', 0) + u.get('cache_read_input_tokens', 0)
                mid = m['message'].get('id')
                calls.append((mid, ctx))
                for c in m['message']['content']:
                    if c.get('type') == 'tool_use':
                        n = c['name'].split('__')[-1]
                        if n == 'computer':
                            n = 'computer.' + c.get('input', {}).get('action', '?')
                        names[c['id']] = n
                        tool_mix[n] += 1
            elif m.get('type') == 'user':
                for c in m['message'].get('content', []):
                    if isinstance(c, dict) and c.get('type') == 'tool_result':
                        cc = c.get('content')
                        parts = cc if isinstance(cc, list) else [{'type': 'text', 'text': cc or ''}]
                        chars = sum(len(p.get('text', '')) for p in parts if p.get('type') == 'text')
                        imgs = sum(1 for p in parts if p.get('type') == 'image')
                        images += imgs
                        result_sizes[names.get(c['tool_use_id'], '?')].append(chars)
        # one entry per API call (stream-json repeats the message id for each content block)
        seen, ordered = set(), []
        for mid, ctx in calls:
            if mid not in seen:
                seen.add(mid); ordered.append(ctx)
        if ordered:
            first_ctx.append(ordered[0]); per_call_ctx += ordered
    out[arm] = dict(
        first_call_context_median=st.median(first_ctx), api_calls=len(per_call_ctx),
        per_call_context_median=st.median(per_call_ctx), images_returned=images,
        tool_mix=dict(tool_mix.most_common()),
        result_chars_median={k: st.median(v) for k, v in sorted(result_sizes.items(), key=lambda kv: -len(kv[1]))})
json.dump(out, open(os.path.join(HERE, f'deep{TAG}.json'), 'w'), indent=2)
for arm, d in out.items():
    print(f"== {arm}: first-call context median {d['first_call_context_median']:.0f} tok, per-call median {d['per_call_context_median']:.0f}, API calls {d['api_calls']}, images returned {d['images_returned']}")
    print('   tools:', d['tool_mix'])
    print('   median result chars:', {k: int(v) for k, v in d['result_chars_median'].items()})
