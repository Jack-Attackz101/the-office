# The Office

An isometric pixel office where every character is one of your real AI agents.
Hover to see what someone's doing, click to talk to them.

**Zero dependencies. No `npm install`. Needs Node 18 or newer.**

---

## Get it running (2 minutes)

```bash
cd the-office
cp agents.example.json agents.json
node server.mjs
```

Open **http://localhost:4300**.

The server prints a readiness line per agent before it starts:

```
  THE OFFICE  →  http://localhost:4300

   [ok  ] CLAUDE         cli  /usr/local/bin/claude
   [MISS] CODEX          cli  codex not found on PATH
   [off ] GEMINI         cli
   [ok  ] SONNET         api  ANTHROPIC_API_KEY is set
   [MISS] GPT            api  OPENAI_API_KEY not set
   [ok  ] ECHO           echo local stub
```

`MISS` agents still get a desk — they just sit there with a red bead over their head until you fix them. Nothing crashes.

---

## Prove it works before touching any keys

Click **ECHO**, in the bottom-right cubicle. Send it anything. It replies instantly with no key, no CLI, no network.

If Echo answers, the whole loop works: browser → server → adapter → event log → back to the browser over SSE. Everything after this is just configuration.

---

## Wiring the CLIs

These commands are the verified non-interactive ones. **Run each in your own terminal first** — if it works there, it'll work in the office.

### Claude Code

```bash
which claude
claude --print "say hi in five words"
```

Already configured in `agents.example.json` as:

```
claude --print --output-format stream-json --verbose "<your message>"
```

Continuity is handled with `--resume <session_id>`. The server captures the `session_id` from the first reply and reuses it, so Claude remembers the conversation between messages. The **MEMORY** chip appears on the hover card once a session exists.

Auth: whichever you already use. Your existing `claude login` works, or set `ANTHROPIC_API_KEY`.

**Point it at a project** by setting `cwd` in `agents.json`:

```json
"cwd": "~/conductor/repos/eyerest"
```

Then it can actually read and edit that code. Leave it as `~` if you just want to chat.

### Codex

```bash
which codex
codex exec "say hi in five words"
```

Configured as:

```
codex exec --json --skip-git-repo-check "<your message>"
```

Two things to know:

- **Codex refuses to run outside a git repo** by default, which is why `--skip-git-repo-check` is there. If you set `cwd` to a real repo you can drop that flag.
- **It's read-only by default.** To let it edit files, add `"--sandbox", "workspace-write"` to `args` and `resumeArgs`.

Continuity uses `codex exec resume --last`.

Auth: `codex login`, or `CODEX_API_KEY`. Note that's **not** `OPENAI_API_KEY` — Codex uses its own variable.

### Gemini

Off by default (`"enabled": false`) because `--output-format` errors on some published builds. Test it first:

```bash
gemini --output-format json -p "hi"
```

If that works, flip `enabled` to `true`.

---

## Wiring the APIs

Set the keys in the same terminal you start the server from:

```bash
export ANTHROPIC_API_KEY=sk-ant-...
export OPENAI_API_KEY=sk-...
node server.mjs
```

Those two agents (SONNET and GPT) are plain chat agents — no file access, no tools. Give each one a personality by editing `persona` in `agents.json`. That's how you make an agent that argues about pricing, or one that only writes copy.

---

## Adding your own agent

Add an object to `agents.json`, restart, and a new character sits down.

```json
{
  "id": "critic",
  "name": "CRITIC",
  "role": "Tells me my ideas are bad",
  "kind": "api",
  "floor": 2,
  "seat": [5, 9],
  "shirt": "#ef4444",
  "hair": "curly",
  "persona": "You are blunt. Find the weakest part of any idea Jack describes and say it in two sentences. Never be encouraging.",
  "api": { "provider": "anthropic", "model": "claude-sonnet-4-6", "keyEnv": "ANTHROPIC_API_KEY" }
}
```

- `seat` is `[column, row]` on the office grid — column 0–16, row 0–11.
- `floor` is `1` (open floor) or `2` (the loft: meeting room, lounge, server room).
- `hair` is one of `dark`, `fade`, `long`, `curly`, `short`, `cap`.
- `shirt` is any hex colour.

---

## Talking to everyone at once

Pick **ALL-HANDS** at the top of the conversation rail. One message goes to every enabled agent, and their replies land in the same thread with their names above them — the shared-conversation model, so you can watch two agents disagree.

---

## How it fits together

```
browser  ──POST /api/send──▶  server.mjs  ──▶  adapter
                                  │              ├─ cli   spawn(claude|codex|gemini)
                                  │              ├─ api   fetch(anthropic|openai)
                                  │              └─ echo  local stub
                                  ▼
                             event log  ──SSE──▶  browser
```

Every message from every agent lands in **one event log**. The office reads only from that log, never from adapters directly. That's the bit that makes ten different transports feel like one room.

The log persists to `data/events.json`, so your history survives a restart.

### Why spawn a process per message instead of keeping one alive

The interactive versions of these CLIs are full-screen terminal UIs. Automating them means a pty, an ANSI parser, and screen-scraping that breaks on every update. All three vendors ship a proper headless mode with JSON output and a resume flag precisely so you don't have to do that. So: fresh process per message, continuity via `--resume`. More reliable, easier to time out, and it can't wedge.

---

## Troubleshooting

**"no server" in the top right** — `server.mjs` isn't running, or it's on a different port. It only serves `localhost:4300` by default; change with `PORT=5000 node server.mjs`.

**An agent says `command not found`** — the CLI isn't on the PATH that the server inherited. Run `which claude` in the same terminal, then put that full path in `command`, e.g. `/opt/homebrew/bin/claude`.

**An agent replies with terminal junk** — it printed something the JSON parser didn't recognise. The server strips ANSI codes and spinner characters, but if a CLI changes its output shape, set `"streamJson": false` to fall back to raw stdout.

**Codex errors about a git repo** — either keep `--skip-git-repo-check` or point `cwd` at a real repo.

**Replies are slow** — that's the CLI thinking, not the office. The character shows a thought bubble and the chat shows typing dots the whole time.

---

## What's deliberately not here

- **No auth.** This runs on your machine and talks to your CLIs. Don't expose it to the internet.
- **No Slack bridge yet.** That's the next adapter, and it's the one that brings Viktor and the Relevance agents in. Same shape: `send` posts to a channel, `poll` reads the thread.
- **No GUI automation.** Clicky and Conductor have no API. Driving their windows would be brittle enough to not be worth it.


## Live activity

CLI agents show what they are actually doing, not just "working".

Claude Code writes every session to disk as JSONL at
`~/.claude/projects/<cwd-with-dashes>/<session-id>.jsonl`, and each assistant
line contains a `tool_use` block naming the tool it just reached for. The
server tails that file while an agent is busy and maps the tool onto something
the character can visibly do:

| tool | what you see |
| --- | --- |
| Read, Glob, Grep | holds a page up, label "reading <file>" |
| Edit, Write | hands tap the keyboard, label "editing <file>" |
| Bash | hands tap, label "running <cmd>" |
| Task | label "delegating" |
| WebFetch, WebSearch | holds a page up, label "looking up <host>" |
| TodoWrite | label "planning" |
| extended thinking | label "thinking" |

Nothing is written and Claude Code is not modified, so this is purely
observational. Anthropic documents this file as internal and says its shape can
change between releases, so every read is defensive: if parsing fails the
character simply falls back to plain "working" instead of erroring.

Turn it off for an agent with `"cli": { "watchTranscript": false }`, or move
the folder with `CLAUDE_CONFIG_DIR`.
