// pre.dev's hosted MCP tools (cloud Browser Agents, specs, plans), served through this local
// server on the same saved key, so one install gives an agent everything pre.dev offers.
//
// The hosted server (https://api.pre.dev/mcp) speaks streamable HTTP without sessions: every
// request is one POST, and the reply is JSON or a short event stream ending in the result.

const LIST_TTL_MS = 10 * 60_000;
/** Kept callable for old prompts, but not listed: the hosted server marks them deprecated. */
const HIDDEN = new Set(['browser_task', 'browser_task_list', 'browser_task_get']);

export function createRemote({ version }) {
  let cache = { key: '', at: 0, tools: [] };
  let nextId = 0;

  async function rpc(ctx, method, params, timeout) {
    const id = ++nextId;
    const response = await fetch(`${(ctx.apiUrl || 'https://api.pre.dev').replace(/\/+$/, '')}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.apiKey}`,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2025-06-18',
        'User-Agent': `predev-mcp/${version}`,
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: AbortSignal.timeout(timeout),
    });
    const text = await response.text();
    if (response.status === 401) throw new Error('pre.dev rejected the saved key. Sign in again by running `npx -y @predotdev/mcp login` in a terminal.');
    const messages = (response.headers.get('content-type') || '').includes('text/event-stream')
      ? text.split('\n').filter(line => line.startsWith('data:')).map(line => { try { return JSON.parse(line.slice(5)); } catch { return null; } })
      : [(() => { try { return JSON.parse(text); } catch { return null; } })()];
    const reply = messages.find(m => m && m.id === id);
    if (!reply) throw new Error(`pre.dev answered ${response.status} without a result.`);
    if (reply.error) throw new Error(reply.error.message || 'pre.dev returned an error.');
    return reply.result;
  }

  /** The hosted tools for this key, cached for a while; none when signed out or unreachable. */
  async function listTools(ctx) {
    if (!ctx.apiKey) return [];
    if (cache.key === ctx.apiKey && Date.now() - cache.at < LIST_TTL_MS) return cache.tools;
    try {
      const result = await rpc(ctx, 'tools/list', {}, 15000);
      const tools = (result?.tools || []).filter(tool => !HIDDEN.has(tool.name) && !tool.name.startsWith('chrome_'));
      cache = { key: ctx.apiKey, at: Date.now(), tools };
      return tools;
    } catch {
      return cache.key === ctx.apiKey ? cache.tools : [];
    }
  }

  async function isRemote(ctx, name) {
    if (name.startsWith('chrome_')) return false;
    return HIDDEN.has(name) || (await listTools(ctx)).some(tool => tool.name === name);
  }

  // Specs and cloud browser runs can take minutes; the hosted tools return when they are done.
  function callTool(ctx, name, args) {
    return rpc(ctx, 'tools/call', { name, arguments: args || {} }, 15 * 60_000);
  }

  return { listTools, isRemote, callTool };
}
