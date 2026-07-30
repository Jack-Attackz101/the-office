#!/usr/bin/env node
/**
 * THE OFFICE — local server
 *
 * Zero dependencies. Node 18+. Run:  node server.mjs
 *
 * It does four things:
 *   1. serves the office UI (index.html, sitting next to this file)
 *   2. reads agents.json and builds an adapter for each agent
 *   3. keeps one event log every adapter writes into
 *   4. streams that log to the browser over Server-Sent Events
 *
 * Adapters:
 *   cli  — spawns a coding-agent CLI per message (claude, codex, gemini…)
 *   api  — talks to Anthropic or OpenAI over HTTP
 *   echo — a local stub so you can see the UI work with no keys at all
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { extname, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 4300);
const LOG_PATH = join(__dirname, 'data', 'events.json');
const OVR_PATH = join(__dirname, 'data', 'overrides.json');

/* ------------------------------------------------------------------ */
/* config                                                              */
/* ------------------------------------------------------------------ */
let CONFIG = { agents: [] };
async function loadConfig() {
  const p = join(__dirname, 'agents.json');
  if (!existsSync(p)) {
    const ex = join(__dirname, 'agents.example.json');
    if (existsSync(ex)) {
      await writeFile(p, await readFile(ex, 'utf8'));
      console.log('  created agents.json for you from the example');
    } else {
      console.error('\n  No agents.json and no agents.example.json. Re-download the folder.\n');
      process.exit(1);
    }
  }
  CONFIG = JSON.parse(await readFile(p, 'utf8'));
  for (const a of CONFIG.agents) {
    a.status = a.enabled === false ? 'off' : 'idle';
    a.lastSeen = null;
    a.busy = false;
    a.sessionId = null;
  }
  console.log(`  loaded ${CONFIG.agents.length} agents from agents.json`);
}

/* ------------------------------------------------------------------ */
/* overrides — what you renamed, where you moved people, your groups    */
/* ------------------------------------------------------------------ */
let OVR = { names: {}, floors: {}, groups: [] };
async function loadOvr() {
  try { OVR = { names:{}, floors:{}, groups:[], ...JSON.parse(await readFile(OVR_PATH,'utf8')) }; }
  catch {}
}
async function saveOvr() {
  await mkdir(dirname(OVR_PATH), { recursive: true });
  await writeFile(OVR_PATH, JSON.stringify(OVR, null, 1));
}
function applyOvr() {
  for (const a of CONFIG.agents) {
    if (OVR.names[a.id])  a.name  = OVR.names[a.id];
    if (OVR.floors[a.id]) a.floor = OVR.floors[a.id];
  }
}

/* ------------------------------------------------------------------ */
/* event log                                                           */
/* ------------------------------------------------------------------ */
let EVENTS = [];
let nextId = 1;
const clients = new Set();

async function loadLog() {
  try {
    const raw = JSON.parse(await readFile(LOG_PATH, 'utf8'));
    EVENTS = raw.events || [];
    nextId = (EVENTS.at(-1)?.id || 0) + 1;
    console.log(`  restored ${EVENTS.length} events`);
  } catch { /* first run */ }
}
let saveTimer = null;
function saveLog() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    await mkdir(dirname(LOG_PATH), { recursive: true });
    await writeFile(LOG_PATH, JSON.stringify({ events: EVENTS.slice(-4000) }, null, 1));
  }, 400);
}

/** Every message in the whole system goes through here. */
function emit(ev) {
  const e = { id: nextId++, at: Date.now(), ...ev };
  EVENTS.push(e);
  saveLog();
  const line = `data: ${JSON.stringify(e)}\n\n`;
  for (const res of clients) { try { res.write(line); } catch {} }
  return e;
}

function setStatus(agent, status, note) {
  if (agent.status === status && !note) return;
  agent.status = status;
  agent.lastSeen = Date.now();
  emit({ type: 'status', agent: agent.id, status, note: note || null });
}

/* ------------------------------------------------------------------ */
/* adapter: cli                                                        */
/* ------------------------------------------------------------------ */
/**
 * Spawns the CLI once per message. This is deliberate — interactive TUIs
 * need a pty and spew ANSI escape codes, which is miserable to parse.
 * Continuity comes from the CLI's own resume flag instead.
 */
function runCli(agent, prompt, threadId) {
  return new Promise((resolve) => {
    const cfg = agent.cli;
    const args = [];

    // first message vs continuing an existing conversation
    if (agent.sessionId && cfg.resumeArgs) {
      for (const a of cfg.resumeArgs) args.push(a.replace('{session}', agent.sessionId));
    } else if (cfg.args) {
      args.push(...cfg.args);
    }
    if (cfg.promptAsArg !== false) args.push(prompt);

    const child = spawn(cfg.command, args, {
      cwd: cfg.cwd ? cfg.cwd.replace('~', process.env.HOME) : process.cwd(),
      env: { ...process.env, ...(cfg.env || {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    if (cfg.promptAsArg === false) { child.stdin.write(prompt + '\n'); child.stdin.end(); }
    else child.stdin.end();

    let out = '', err = '', streamed = false;

    child.stdout.on('data', (buf) => {
      const chunk = buf.toString();
      out += chunk;
      // stream-json: one JSON object per line
      if (cfg.streamJson) {
        for (const line of chunk.split('\n')) {
          const s = line.trim(); if (!s.startsWith('{')) continue;
          try {
            const j = JSON.parse(s);
            // Claude Code hands back session_id; Codex uses `exec resume --last`
            if (j.session_id) agent.sessionId = j.session_id;
            if (j.type === 'thread.started' && j.thread_id) agent.sessionId = j.thread_id;
            const text = extractText(j);
            if (text) { streamed = true; emit({ type: 'msg', agent: agent.id, thread: threadId, role: 'agent', text }); }
          } catch {}
        }
      }
    });
    child.stderr.on('data', (b) => { err += b.toString(); });

    child.on('error', (e) => {
      setStatus(agent, 'error', e.code === 'ENOENT'
        ? `command not found: ${cfg.command}`
        : e.message);
      emit({ type: 'msg', agent: agent.id, thread: threadId, role: 'system',
             text: e.code === 'ENOENT'
               ? `\`${cfg.command}\` is not on this machine's PATH. Install it, or fix "command" in agents.json.`
               : e.message });
      resolve();
    });

    child.on('close', (code) => {
      if (!streamed) {
        const text = cleanCli(out) || cleanCli(err) || `(${cfg.command} exited with code ${code} and said nothing)`;
        emit({ type: 'msg', agent: agent.id, thread: threadId, role: 'agent', text });
      }
      if (code !== 0 && err.trim()) {
        emit({ type: 'msg', agent: agent.id, thread: threadId, role: 'system',
               text: `exit ${code}: ${cleanCli(err).slice(0, 400)}` });
      }
      resolve();
    });
  });
}

/**
 * Pull assistant text out of whatever shape the CLI's JSON uses.
 * Claude Code, Codex and Gemini all emit NDJSON but with different schemas.
 */
function extractText(j) {
  // Codex:  {"type":"item.completed","item":{"type":"agent_message","text":"…"}}
  if (j.type === 'item.completed' && j.item?.type === 'agent_message') return j.item.text || '';
  if (j.type === 'item.completed' && j.item?.type === 'command_execution') return '';
  // Claude Code:  {"type":"assistant","message":{"content":[{"type":"text",…}]}}
  if (j.type === 'assistant' && j.message?.content) {
    return j.message.content.filter(c => c.type === 'text').map(c => c.text).join('');
  }
  // Claude Code final:  {"type":"result","result":"…","session_id":"…"}
  if (j.type === 'result' && typeof j.result === 'string') return j.result;
  // Gemini:  {"type":"message","text":"…"} / {"response":"…"}
  if (j.type === 'message' && typeof j.text === 'string') return j.text;
  if (typeof j.response === 'string') return j.response;
  // don't double-print token deltas — we only take whole messages
  return '';
}

/** strip ANSI + spinner junk so the chat bubble is readable */
function cleanCli(s) {
  return s
    .replace(/\u001b\[[0-9;?]*[A-Za-z]/g, '')
    .replace(/\r/g, '')
    .replace(/^[\s·✢✳✶✻*|/\\-]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ */
/* adapter: api                                                        */
/* ------------------------------------------------------------------ */
const HISTORY = new Map(); // agentId -> [{role,content}]

async function runApi(agent, prompt, threadId) {
  const cfg = agent.api;
  const key = process.env[cfg.keyEnv];
  if (!key) {
    emit({ type: 'msg', agent: agent.id, thread: threadId, role: 'system',
           text: `No API key. Set ${cfg.keyEnv} in your environment and restart.` });
    setStatus(agent, 'error', `${cfg.keyEnv} not set`);
    return;
  }
  const hist = HISTORY.get(agent.id) || [];
  hist.push({ role: 'user', content: prompt });

  try {
    let text = '';
    if (cfg.provider === 'anthropic') {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({
          model: cfg.model, max_tokens: cfg.maxTokens || 1200,
          system: agent.persona || undefined, messages: hist.slice(-20),
        }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    } else {
      const r = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: cfg.model, max_tokens: cfg.maxTokens || 1200,
          messages: [...(agent.persona ? [{ role: 'system', content: agent.persona }] : []), ...hist.slice(-20)],
        }),
      });
      const j = await r.json();
      if (j.error) throw new Error(j.error.message);
      text = j.choices?.[0]?.message?.content || '';
    }
    hist.push({ role: 'assistant', content: text });
    HISTORY.set(agent.id, hist);
    emit({ type: 'msg', agent: agent.id, thread: threadId, role: 'agent', text });
  } catch (e) {
    emit({ type: 'msg', agent: agent.id, thread: threadId, role: 'system', text: 'API error: ' + e.message });
    setStatus(agent, 'error', e.message.slice(0, 80));
  }
}


/* ------------------------------------------------------------------ */
/* adapter: aside                                                      */
/* ------------------------------------------------------------------ */
/**
 * The real Aside agent.
 *
 * Instead of a hand-written persona that goes stale, this reads Jack's actual
 * Aside memory and recent session activity off disk every time he sends a
 * message, and hands it to the model as live context. So it genuinely knows
 * what his projects are and what was worked on last, rather than guessing.
 */
const ASIDE_ROOT = join(process.env.HOME || '', '.aside', 'u', '0');

async function asideContext() {
  const parts = [];
  for (const f of ['memory/USER.md', 'memory/MEMORY.md']) {
    try {
      parts.push('### ' + f + '\n' + (await readFile(join(ASIDE_ROOT, f), 'utf8')).slice(0, 6000));
    } catch {}
  }
  // most recent session folders, newest first, as a rough activity trail
  try {
    const dirs = (await readdir(join(ASIDE_ROOT, 'sessions'))).sort().reverse().slice(0, 8);
    if (dirs.length) parts.push('### recent Aside sessions\n' + dirs.join('\n'));
  } catch {}
  // today's episodic memory, if one has been written yet
  try {
    const d = new Date().toISOString().slice(0, 10);
    const ep = await readFile(join(ASIDE_ROOT, 'memory', 'episodic', d + '.md'), 'utf8');
    parts.push('### today (' + d + ')\n' + ep.slice(0, 4000));
  } catch {}
  return parts.join('\n\n');
}

async function runAside(agent, prompt, threadId) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    emit({ type: 'msg', agent: agent.id, thread: threadId, role: 'system',
           text: 'No ANTHROPIC_API_KEY set, so Aside cannot answer. Set it and restart the server.' });
    setStatus(agent, 'error', 'ANTHROPIC_API_KEY not set');
    return;
  }
  const ctx = await asideContext();
  const hist = HISTORY.get(agent.id) || [];
  hist.push({ role: 'user', content: prompt });

  const system =
    (agent.persona || "You are Aside, Jack's chief of staff.") +
    '\n\nBelow is your real memory and recent activity, read from disk just now. ' +
    'Use it. If it contradicts something you would otherwise have assumed, trust the memory. ' +
    'Never claim to have done something that is not reflected here.\n\n' + ctx;

  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: agent.model || 'claude-sonnet-4-6',
        max_tokens: 1600,
        system,
        messages: hist.slice(-20),
      }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    const text = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
    hist.push({ role: 'assistant', content: text });
    HISTORY.set(agent.id, hist);
    emit({ type: 'msg', agent: agent.id, thread: threadId, role: 'agent', text });
  } catch (e) {
    emit({ type: 'msg', agent: agent.id, thread: threadId, role: 'system', text: 'Aside error: ' + e.message });
    setStatus(agent, 'error', e.message.slice(0, 80));
  }
}

/* ------------------------------------------------------------------ */
/* dispatch                                                            */
/* ------------------------------------------------------------------ */
async function dispatch(agent, prompt, threadId) {
  if (agent.enabled === false) {
    emit({ type: 'msg', agent: agent.id, thread: threadId, role: 'system',
           text: 'This agent is switched off in agents.json.' });
    return;
  }
  agent.busy = true;
  setStatus(agent, 'working');
  const t0 = Date.now();
  try {
    if (agent.kind === 'cli') await runCli(agent, prompt, threadId);
    else if (agent.kind === 'api') await runApi(agent, prompt, threadId);
    else if (agent.kind === 'aside') await runAside(agent, prompt, threadId);
    else {
      await new Promise(r => setTimeout(r, 600));
      emit({ type: 'msg', agent: agent.id, thread: threadId, role: 'agent',
             text: `(echo) ${prompt}` });
    }
  } finally {
    agent.busy = false;
    setStatus(agent, 'idle', `${((Date.now() - t0) / 1000).toFixed(1)}s`);
  }
}

/* ------------------------------------------------------------------ */
/* health checks — is each CLI actually installed?                      */
/* ------------------------------------------------------------------ */
function which(cmd) {
  return new Promise((resolve) => {
    const c = spawn(process.platform === 'win32' ? 'where' : 'which', [cmd]);
    let out = '';
    c.stdout.on('data', b => out += b);
    c.on('error', () => resolve(null));
    c.on('close', code => resolve(code === 0 ? out.trim().split('\n')[0] : null));
  });
}

async function healthCheck() {
  for (const a of CONFIG.agents) {
    if (a.enabled === false) { a.health = 'off'; continue; }
    if (a.kind === 'cli') {
      const p = await which(a.cli.command);
      a.health = p ? 'ok' : 'missing';
      a.healthNote = p || `${a.cli.command} not found on PATH`;
      if (!p) a.status = 'error';
    } else if (a.kind === 'api') {
      a.health = process.env[a.api.keyEnv] ? 'ok' : 'missing';
      a.healthNote = process.env[a.api.keyEnv] ? `${a.api.keyEnv} is set` : `${a.api.keyEnv} not set`;
      if (a.health === 'missing') a.status = 'error';
    } else if (a.kind === 'aside') {
      const hasKey = !!process.env.ANTHROPIC_API_KEY;
      let hasMem = false;
      try { await readFile(join(ASIDE_ROOT, 'memory', 'USER.md'), 'utf8'); hasMem = true; } catch {}
      a.health = hasKey ? 'ok' : 'missing';
      a.healthNote = (hasKey ? 'ANTHROPIC_API_KEY set' : 'ANTHROPIC_API_KEY not set') +
                     (hasMem ? ' \u00b7 reading live Aside memory' : ' \u00b7 no Aside memory found');
      if (!hasKey) a.status = 'error';
    } else { a.health = 'ok'; a.healthNote = 'local stub'; }
  }
}

/* ------------------------------------------------------------------ */
/* http                                                                */
/* ------------------------------------------------------------------ */
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css',
               '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

function json(res, code, body) {
  res.writeHead(code, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'content-type',
                         'access-control-allow-methods': 'GET,POST' });
    return res.end();
  }

  /* --- api --- */
  if (path === '/api/agents') {
    await healthCheck();
    return json(res, 200, {
      ok: true,
      groups: OVR.groups,
      agents: CONFIG.agents.map(a => ({
        id: a.id, name: a.name, role: a.role, kind: a.kind, seat: a.seat, floor: a.floor ?? 1,
        shirt: a.shirt, hair: a.hair, status: a.status, health: a.health, healthNote: a.healthNote,
        enabled: a.enabled !== false, hasSession: !!a.sessionId,
      })),
    });
  }

  if (path === '/api/events') {
    const since = Number(url.searchParams.get('since') || 0);
    return json(res, 200, { ok: true, events: EVENTS.filter(e => e.id > since) });
  }

  if (path === '/api/stream') {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache',
                         connection: 'keep-alive', 'access-control-allow-origin': '*' });
    res.write(': connected\n\n');
    clients.add(res);
    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
    req.on('close', () => { clearInterval(ping); clients.delete(res); });
    return;
  }

  if (path === '/api/send' && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    let p; try { p = JSON.parse(body); } catch { return json(res, 400, { ok: false, error: 'bad json' }); }
    const thread = p.thread || 'main';
    const text = String(p.text || '').trim();
    if (!text) return json(res, 400, { ok: false, error: 'empty' });

    emit({ type: 'msg', agent: 'you', thread, role: 'you', text });

    // "@all", an array of ids (group chat), or a single agent
    let targets;
    if (p.to === '@all') targets = CONFIG.agents.filter(a => a.enabled !== false);
    else if (Array.isArray(p.to)) targets = CONFIG.agents.filter(a => p.to.includes(a.id));
    else targets = CONFIG.agents.filter(a => a.id === p.to);
    if (!targets.length) return json(res, 404, { ok: false, error: 'no such agent' });

    for (const a of targets) dispatch(a, text, thread);   // fire and forget; results stream
    return json(res, 200, { ok: true, dispatched: targets.map(a => a.id) });
  }

  if (path === '/api/rename' && req.method === 'POST') {
    let body=''; for await (const c of req) body += c;
    const { id, name } = JSON.parse(body || '{}');
    const a = CONFIG.agents.find(x => x.id === id);
    if (!a || !name) return json(res, 400, { ok:false, error:'need id and name' });
    OVR.names[id] = String(name).slice(0, 18);
    a.name = OVR.names[id]; await saveOvr();
    emit({ type:'meta', agent:id, name:a.name });
    return json(res, 200, { ok:true, name:a.name });
  }

  if (path === '/api/move' && req.method === 'POST') {
    let body=''; for await (const c of req) body += c;
    const { id, floor } = JSON.parse(body || '{}');
    const a = CONFIG.agents.find(x => x.id === id);
    if (!a || !floor) return json(res, 400, { ok:false, error:'need id and floor' });
    OVR.floors[id] = Number(floor);
    a.floor = Number(floor); await saveOvr();
    emit({ type:'meta', agent:id, floor:a.floor });
    return json(res, 200, { ok:true, floor:a.floor });
  }

  if (path === '/api/groups') {
    if (req.method === 'POST') {
      let body=''; for await (const c of req) body += c;
      const gr = JSON.parse(body || '{}');
      if (gr.remove) { OVR.groups = OVR.groups.filter(x => x.id !== gr.remove); }
      else {
        if (!gr.id || !Array.isArray(gr.members)) return json(res,400,{ok:false});
        OVR.groups = OVR.groups.filter(x => x.id !== gr.id);
        OVR.groups.push({ id: gr.id, name: gr.name || gr.id, members: gr.members });
      }
      await saveOvr();
      return json(res, 200, { ok:true, groups: OVR.groups });
    }
    return json(res, 200, { ok:true, groups: OVR.groups });
  }

  if (path === '/api/reset' && req.method === 'POST') {
    for (const a of CONFIG.agents) { a.sessionId = null; HISTORY.delete(a.id); }
    emit({ type: 'status', agent: 'you', status: 'idle', note: 'conversations reset' });
    return json(res, 200, { ok: true });
  }

  /* --- static --- */
  let file = path === '/' ? '/index.html' : path;
  if (/\.(mjs|json)$/.test(file)) { res.writeHead(403); return res.end('no'); }  // never serve config or source
  const full = join(__dirname, file);
  if (!full.startsWith(__dirname)) { res.writeHead(403); return res.end('no'); }
  try {
    const buf = await readFile(full);
    res.writeHead(200, { 'content-type': MIME[extname(full)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404); res.end('not found');
  }
});

/* ------------------------------------------------------------------ */
await loadConfig();
await loadOvr();
applyOvr();
await loadLog();
await healthCheck();

server.listen(PORT, () => {
  console.log(`\n  THE OFFICE  →  http://localhost:${PORT}\n`);
  for (const a of CONFIG.agents) {
    const mark = a.health === 'ok' ? 'ok  ' : a.health === 'off' ? 'off ' : 'MISS';
    console.log(`   [${mark}] ${a.name.padEnd(14)} ${a.kind.padEnd(4)} ${a.healthNote || ''}`);
  }
  const missing = CONFIG.agents.filter(a => a.health === 'missing');
  if (missing.length) {
    console.log(`\n  ${missing.length} agent(s) not ready. They'll show red in the office until fixed.`);
  }
  console.log('');
});
