// pre.dev's hosted MCP tools (cloud Browser Agents, specs, plans), served through this local
// server on the same saved key, so one install gives an agent everything pre.dev offers.
//
// The hosted server (https://api.pre.dev/mcp) speaks streamable HTTP without sessions: every
// request is one POST, and the reply is JSON or a short event stream ending in the result.
// Signed out, or on a plan without the hosted tools, they are still listed (from the public
// /mcp/info) and a call says how to unlock them, so the agent can tell the user.

const LIST_TTL_MS = 10 * 60_000;
const PROFILES_TTL_MS = 60_000;
/** Kept callable for old prompts, but not listed: the hosted server marks them deprecated. */
const HIDDEN = new Set(['browser_task', 'browser_task_list', 'browser_task_get']);
const SIGN_IN = 'Sign in to pre.dev (free) by running `npx -y @predotdev/mcp login` in a terminal; no restart needed.';

class PlanRequired extends Error {}

export function createRemote({ version }) {
  let cache = { key: null, at: 0, tools: [], locked: null };
  let profiles = { key: null, at: 0, value: null };
  let nextId = 0;
  const base = ctx => (ctx.apiUrl || 'https://api.pre.dev').replace(/\/+$/, '');

  // Browser profiles: the user's own signed-in sessions in pre.dev's cloud browsers. pre.dev offers them only to
  // accounts it has turned them on for, and then the hosted browser_agent takes a `profile`. This server never
  // fills `profile` by itself, except "auto" when the user turned on "Use my logins automatically" (read from the
  // profile listing); pre.dev then picks the profile that covers each task's site, or none.
  const takesProfile = tool => tool?.name === 'browser_agent' && !!tool.inputSchema?.properties?.profile;
  async function profileListing(ctx) {
    const key = ctx.apiKey || '';
    if (profiles.key === key && Date.now() - profiles.at < PROFILES_TTL_MS) return profiles.value;
    let value = null;
    try {
      const response = await fetch(`${base(ctx)}/browser-profiles`, {
        headers: { Authorization: `Bearer ${ctx.apiKey}`, 'User-Agent': `predev-mcp/${version}`, 'x-predev-client': 'mcp' },
        signal: AbortSignal.timeout(8000),
      });
      if (response.ok) {
        const body = await response.json();
        if (body?.enabled) {
          value = {
            auto: body.useLoginsAutomatically === true,
            profiles: (body.profiles || []).map(p => ({ name: String(p.name || ''), isDefault: !!p.isDefault, sites: (p.sites || []).map(s => s.domain).filter(Boolean) })),
          };
        }
      }
    } catch {}
    profiles = { key, at: Date.now(), value };
    return value;
  }
  /** browser_agent's description, with the user's profiles and whether "auto" is on, so the agent knows what to name. */
  function withProfiles(tool, listing) {
    if (!listing) return tool;
    const names = listing.profiles.slice(0, 20).map(p => `${p.name}${p.isDefault ? ' (default)' : ''}: ${p.sites.slice(0, 12).join(', ') || 'no sites yet'}`);
    const note = [
      names.length ? `The user's browser profiles: ${names.join('; ')}.` : 'The user has no browser profiles yet.',
      listing.auto
        ? 'Their "Use my logins automatically" is on: a call that names no profile runs each task with the profile that covers its site, or signed out when none does.'
        : 'Pass profile (a name, or "default") only for a task that needs the user signed in; without it the task runs signed out.',
    ].join(' ');
    return { ...tool, description: `${tool.description || ''} ${note}`.trim() };
  }

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
        if (tools.some(takesProfile)) {
          const listing = await profileListing(ctx);
          tools = tools.map(tool => (takesProfile(tool) ? withProfiles(tool, listing) : tool));
        }
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
    const tools = await listTools(ctx);
    if (cache.locked) return offer(cache.locked);
    // "Use my logins automatically" on: a browser_agent call that names no profile for the batch asks for "auto"
    // (tasks that name their own profile keep it).
    if (name === 'browser_agent' && args && args.profile === undefined && tools.some(takesProfile)) {
      const listing = await profileListing(ctx);
      if (listing?.auto) args = { ...args, profile: 'auto' };
    }
    try {
      return await rpc(ctx, 'tools/call', { name, arguments: args || {} }, 15 * 60_000);
    } catch (error) {
      if (error instanceof PlanRequired) { cache.locked = error.message; return offer(error.message); }
      throw error;
    }
  }

  return { listTools, isRemote, callTool };
}
