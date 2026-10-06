// pre.dev's hosted MCP tools (cloud Browser Agents, specs, plans), served through this local
// server on the same saved key, so one install gives an agent everything pre.dev offers.
//
// The hosted server (https://api.pre.dev/mcp) speaks streamable HTTP without sessions: every
// request is one POST, and the reply is JSON or a short event stream ending in the result.
// Signed out, or on a plan without the hosted tools, they are still listed (from the public
// /mcp/info) and a call says how to unlock them, so the agent can tell the user.

const LIST_TTL_MS = 10 * 60_000;
/** Kept callable for old prompts, but not listed: the hosted server marks them deprecated. */
const HIDDEN = new Set(['browser_task', 'browser_task_list', 'browser_task_get']);
const SIGN_IN = 'Sign in to pre.dev (free) by running `npx -y @predotdev/mcp login` in a terminal; no restart needed.';

class PlanRequired extends Error {}

export function createRemote({ version }) {
  let cache = { key: null, at: 0, tools: [], locked: null };
  let nextId = 0;
  const base = ctx => (ctx.apiUrl || 'https://api.pre.dev').replace(/\/+$/, '');

  async function rpc(ctx, method, params, timeout) {
    const id = ++nextId;
    const response = await fetch(`${base(ctx)}/mcp`, {
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
    if (response.status === 401) {
      let message = '';
      try { message = JSON.parse(text).message || ''; } catch {}
      // A valid key on a plan without the hosted tools: the message names the subscribe page.
      if (/subscription/i.test(message)) throw new PlanRequired(message);
      throw new Error('pre.dev rejected the saved key. Sign in again by running `npx -y @predotdev/mcp login` in a terminal.');
    }
    const messages = (response.headers.get('content-type') || '').includes('text/event-stream')
      ? text.split('\n').filter(line => line.startsWith('data:')).map(line => { try { return JSON.parse(line.slice(5)); } catch { return null; } })
      : [(() => { try { return JSON.parse(text); } catch { return null; } })()];
    const reply = messages.find(m => m && m.id === id);
    if (!reply) throw new Error(`pre.dev answered ${response.status} without a result.`);
    if (reply.error) throw new Error(reply.error.message || 'pre.dev returned an error.');
    return reply.result;
  }

  // The public catalog: names and descriptions only, listed with a note on what unlocks them.
  async function catalog(ctx, note) {
    const info = await fetch(`${base(ctx)}/mcp/info`, { signal: AbortSignal.timeout(10000) }).then(r => r.json());
    return (info.tools || []).filter(tool => !tool.deprecated && !HIDDEN.has(tool.name)).map(tool => ({
      name: tool.name,
      ...(tool.title ? { title: tool.title } : {}),
      description: `${note} ${tool.description || ''}`.trim(),
      inputSchema: { type: 'object', additionalProperties: true },
    }));
  }

  /** The hosted tools for this key, cached for a while; listed even when locked, so agents can offer them. */
  async function listTools(ctx) {
    const key = ctx.apiKey || '';
    if (cache.key === key && Date.now() - cache.at < LIST_TTL_MS) return cache.tools;
    let tools = [];
    let locked = null;
    try {
      if (!key) {
        locked = SIGN_IN;
        tools = await catalog(ctx, 'Needs a free pre.dev account, not signed in yet.');
      } else {
        const result = await rpc(ctx, 'tools/list', {}, 15000);
        tools = (result?.tools || []).filter(tool => !HIDDEN.has(tool.name) && !tool.name.startsWith('chrome_'));
      }
    } catch (error) {
      if (error instanceof PlanRequired) {
        locked = error.message;
        tools = await catalog(ctx, 'Needs a pre.dev plan; this account does not have one yet.').catch(() => []);
      } else if (cache.key === key) {
        return cache.tools;
      }
    }
    cache = { key, at: Date.now(), tools, locked };
    return tools;
  }

  async function isRemote(ctx, name) {
    if (name.startsWith('chrome_')) return false;
    return HIDDEN.has(name) || (await listTools(ctx)).some(tool => tool.name === name);
  }

  const offer = message => ({
    content: [{ type: 'text', text: `${message}\nTell the user. If they want it, offer to open the link in their Chrome with chrome_open (they finish sign-up or checkout themselves; never enter payment details).` }],
    isError: true,
  });

  // Specs and cloud browser runs can take minutes; the hosted tools return when they are done.
  async function callTool(ctx, name, args) {
    await listTools(ctx);
    if (cache.locked) return offer(cache.locked);
    try {
      return await rpc(ctx, 'tools/call', { name, arguments: args || {} }, 15 * 60_000);
    } catch (error) {
      if (error instanceof PlanRequired) { cache.locked = error.message; return offer(error.message); }
      throw error;
    }
  }

  return { listTools, isRemote, callTool };
}
