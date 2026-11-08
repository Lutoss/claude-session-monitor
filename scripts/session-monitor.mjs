#!/usr/bin/env node
// session-monitor.mjs: monitor for open Claude Code sessions of the desktop app.
//
// Reads the app's session metadata (%LOCALAPPDATA%\Claude-Data\*\claude-code-sessions\**\local_*.json)
// and the transcripts (~\.claude\projects\**\<cliSessionId>.jsonl) and sorts every session into a
// bucket: waiting on you, ready for review, running, interrupted, open items, no status, done.
//
//   node scripts/session-monitor.mjs                  server on http://localhost:4317 (re-reads on every request)
//   node scripts/session-monitor.mjs --port 5000
//   node scripts/session-monitor.mjs --json           classification as JSON on stdout (used by the pane)
//   node scripts/session-monitor.mjs --html out.html  write a static page
//   node scripts/session-monitor.mjs --open <id>      open session local_… in the desktop app (exit 2 for an invalid ID)
//   Options: --meta-dir <folder> --projects-dir <folder> --all (include archived sessions)
//
// Read-only: writes nothing into the app's or the transcripts' folders.

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const RUNNING_WINDOW_MS = 15 * 60 * 1000; // open turn, transcript last written < 15 min ago
export const BACKGROUND_WINDOW_MS = 5 * 60 * 1000;

// ---------- Locations ----------

export function defaultMetaDirs() {
  const local = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
  const dirs = [];
  const base = path.join(local, 'Claude-Data');
  for (const name of safeReaddir(base)) {
    const d = path.join(base, name, 'claude-code-sessions');
    if (isDir(d)) dirs.push(d);
  }
  return dirs;
}

export function defaultProjectsDir() {
  return path.join(os.homedir(), '.claude', 'projects');
}

function safeReaddir(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}
function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

function compareRank(a, b) {
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
}

function mtimeOf(p) {
  try { return fs.statSync(p).mtimeMs; } catch { return 0; }
}

function walkFiles(dir, accept, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(p, accept, out);
    else if (accept(e.name)) out.push(p);
  }
  return out;
}

// cliSessionId -> transcript path (top level of each project folder only; subagent transcripts sit deeper)
export function indexTranscripts(projectsDir) {
  const map = new Map();
  for (const proj of safeReaddir(projectsDir)) {
    const dir = path.join(projectsDir, proj);
    for (const f of safeReaddir(dir)) {
      if (!f.endsWith('.jsonl')) continue;
      const id = f.slice(0, -6);
      const p = path.join(dir, f);
      // Same ID in two project folders (session moved): the most recently written one wins
      const prev = map.get(id);
      if (prev && mtimeOf(prev) >= mtimeOf(p)) continue;
      map.set(id, p);
    }
  }
  return map;
}

// ---------- Reading a transcript ----------

// Replays the update_plan calls; wrap_up ticks off the whole list (that is how the app behaves).
export function replayPlan(calls) {
  let items = [];
  for (const c of calls) {
    const input = c.input || {};
    if (c.name.endsWith('wrap_up')) {
      items = items.map(i => ({ ...i, status: 'completed' }));
      continue;
    }
    if (!c.name.endsWith('update_plan')) continue;
    if (Array.isArray(input.items)) {
      items = input.items.map(i => ({ content: String(i.content ?? ''), status: i.status || 'pending' }));
      continue;
    }
    if (input.advance) {
      const cur = items.findIndex(i => i.status === 'in_progress');
      if (cur >= 0) items[cur] = { ...items[cur], status: 'completed' };
      const next = items.findIndex(i => i.status === 'pending');
      if (next >= 0) items[next] = { ...items[next], status: 'in_progress' };
    }
    for (const n of input.done || []) {
      if (items[n - 1]) items[n - 1] = { ...items[n - 1], status: 'completed' };
    }
    // start sets only the named step; other running steps stay running (the app answers "steps 1, 4 … in progress")
    if (input.start && items[input.start - 1]) {
      items[input.start - 1] = { ...items[input.start - 1], status: 'in_progress' };
    }
  }
  return items;
}

// Open items from a reply text. The headings are German on purpose (the replies this was built for
// are German): a section "Noch offen bei dir", "Offen", "Für dich" or "Offene Punkte".
// Recognises bullet lists (also with blank lines in between), a paragraph right under the heading
// and the inline form "**Offen:** X". Ticked [x] items and "Keine." do not count.
// Limit: free text without such a heading is only caught by lastQuestion (closing question).
// Real headings/labels only: the word ends there (not "Offenbar"), then at most one bracketed note,
// then a colon or the end of the line (not "Offen ist nichts mehr.", not "Offen und schwach:").
// A comma note before the colon is allowed ("**Offen, nur für Alex:**").
const OPEN_HEAD = /^\s*(?:#{1,6}\s*)?(?:[-*•]\s*)?\**\s*(noch offen(?: bei dir)?|offene punkte|offen|für dich)(?![\p{L}\p{N}])\s*\**\s*(?:(?:\([^)]*\)\s*)?(?::\s*\**|\**\s*$)|,[^:\n]{1,40}?\**:\s*\**)\s*(.*)$/iu;

export function parseOpenList(text) {
  if (!text) return [];
  const lines = String(text).split(/\r?\n/);
  const items = [];
  for (let s = 0; s < lines.length; s++) {
    const head = lines[s].match(OPEN_HEAD);
    if (!head) continue;
    const inline = head[2].replace(/\*\*/g, '').trim();
    // "Noch offen bei dir (note):" is still a heading, the items follow below it
    if (inline && !/:\s*$/.test(inline)) { pushItem(items, inline); continue; }
    let sawBullet = false;
    let para = null;
    for (let i = s + 1; i < lines.length; i++) {
      const l = lines[i];
      if (/^\s*$/.test(l)) {
        if (para !== null) break;
        // Blank line: go on if another bullet follows
        const nextNonEmpty = lines.slice(i + 1).find(x => !/^\s*$/.test(x));
        if (sawBullet && nextNonEmpty && /^\s*(?:[-*•]|\d+[.)])\s+/.test(nextNonEmpty)) continue;
        if (sawBullet) break;
        continue;
      }
      if (/^\s*#{1,6}\s/.test(l) || OPEN_HEAD.test(l)) break;
      const m = l.match(/^\s*(?:[-*•]|\d+[.)])\s+(.*)$/);
      if (m) { sawBullet = true; pushItem(items, m[1]); continue; }
      if (sawBullet && /^\s{2,}\S/.test(l)) { items[items.length - 1] += ' ' + l.trim(); continue; }
      if (sawBullet) break;
      para = para === null ? l.trim() : `${para} ${l.trim()}`;
    }
    if (para) pushItem(items, para);
  }
  return [...new Set(items)];
}

function pushItem(items, raw) {
  const s = String(raw);
  if (/^\s*\[x\]/i.test(s)) return; // ticked off
  const t = s.replace(/\*\*/g, '').replace(/^\s*\[ \]\s*/, '').trim();
  if (!t || /^(keine|keins|nichts|nein|–|-)\.?$/i.test(t)) return;
  items.push(t);
}

// Does the text end with a question to the user? Returns the last sentence ending in "?" from the
// last paragraph. Not counted: stock phrases ("Noch Fragen?"), questions after a colon (delivered
// content, e.g. "Hier die Interviewfrage: Wie geht es dir?") and questions without a German
// du/ich/wir pronoun. Limit: a heuristic; a question without those words goes unnoticed.
export function lastQuestion(text) {
  if (!text) return '';
  const paras = String(text).trim().split(/\n\s*\n/);
  const last = paras[paras.length - 1].replace(/\*\*/g, '').trim();
  if (!/\?\s*$/.test(last)) return '';
  const sentences = last.split(/(?<=[.!?])\s+/);
  const q = sentences[sentences.length - 1].trim();
  if (/^(noch )?(fragen|weitere fragen|alles klar|passt)\?$/i.test(q)) return '';
  if (q.includes(':')) return '';
  if (!/\b(du|dir|dich|dein\w*|ihr|euch|ich|wir|uns)\b/i.test(q)) return '';
  return q.slice(0, 300);
}

const ts = v => (v ? Date.parse(v) || 0 : 0);

// Cache per transcript (size + mtime). In memory for the server, on disk for CLI runs (the pane's --json).
const CACHE_VERSION = 3; // 3: adds lastEntryAt
const transcriptCache = new Map();
let diskCacheFile = null;
let diskCacheDirty = false;

export function useDiskCache(file) {
  diskCacheFile = file;
  try {
    const d = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (d.version === CACHE_VERSION) {
      for (const [k, v] of Object.entries(d.entries || {})) if (isValidCacheEntry(v)) transcriptCache.set(k, v);
    }
  } catch { /* no cache or a broken one: rebuild */ }
}

// Shape check: an entry that parses but is broken is discarded and the transcript read again
export function isValidCacheEntry(e) {
  const v = e?.value;
  return typeof e?.key === 'string' && !!v && typeof v === 'object'
    && Array.isArray(v.plan) && v.plan.every(i => i && typeof i === 'object' && typeof i.content === 'string' && typeof i.status === 'string')
    && typeof v.mtimeMs === 'number' && typeof v.turnEnded === 'boolean'
    && (v.lastEntryAt === null || typeof v.lastEntryAt === 'number');
}

export function saveDiskCache(liveFiles) {
  if (!diskCacheFile || !diskCacheDirty) return;
  const entries = {};
  for (const [k, v] of transcriptCache) if (!liveFiles || liveFiles.has(k)) entries[k] = v;
  const tmp = `${diskCacheFile}.${process.pid}.${Date.now()}.tmp`; // a temp file of its own per run
  try {
    fs.writeFileSync(tmp, JSON.stringify({ version: CACHE_VERSION, entries }));
    fs.renameSync(tmp, diskCacheFile);
  } catch {
    try { fs.unlinkSync(tmp); } catch { /* the cache is optional */ }
  }
}

// Timestamp of the last transcript entry that has one. When a session is loaded, Claude Code appends
// bookkeeping lines without a timestamp (last-prompt, cost-state, tools-used); they change the file
// date but are no chat activity (otherwise a chat from two days ago would show "vor 5 Min.").
export function lastEntryAt(content) {
  let end = content.length;
  // No line limit: many bookkeeping lines at the end must not hide the last real entry.
  // JSON.parse only for lines containing "timestamp"; the result is kept in the transcript cache.
  while (end > 0) {
    const start = content.lastIndexOf('\n', end - 1);
    const line = content.slice(start + 1, end).trim();
    end = start < 0 ? 0 : start;
    if (!line || !line.includes('"timestamp"')) continue;
    try {
      const t = Date.parse(JSON.parse(line).timestamp);
      if (Number.isFinite(t)) return t;
    } catch { /* skip a broken line */ }
  }
  return null;
}

export function readTranscript(file) {
  let st;
  try { st = fs.statSync(file); } catch { return null; }
  const key = `${st.size}:${st.mtimeMs}`;
  const hit = transcriptCache.get(file);
  if (hit && hit.key === key) return hit.value;

  const content = fs.readFileSync(file, 'utf8');
  const turnCalls = [];
  const failedIds = new Set();
  let lastWrapUp = null;
  let lastWrapUpAt = null;
  let lastPlanAt = null;
  let lastUserAt = null;
  let lastAssistantText = null;
  let lastAssistantAt = null;

  let pos = 0;
  while (pos < content.length) {
    let end = content.indexOf('\n', pos);
    if (end < 0) end = content.length;
    const line = content.slice(pos, end);
    pos = end + 1;
    const isTurn = line.includes('mcp__ccd_turn__');
    const isError = line.includes('"is_error":true');
    const maybeUser = line.startsWith('{"') && line.includes('"type":"user"') && !line.includes('"isSidechain":true');
    const maybeText = line.includes('"type":"assistant"') && line.includes('"type":"text"');
    if (!isTurn && !isError && !maybeUser && !maybeText) continue;
    let d;
    try { d = JSON.parse(line); } catch { continue; }
    if (d.isSidechain) continue;
    if (d.type === 'user') {
      if (isHumanPrompt(d)) lastUserAt = ts(d.timestamp);
      const c = d.message?.content;
      if (Array.isArray(c)) for (const b of c) if (b?.type === 'tool_result' && b.is_error) failedIds.add(b.tool_use_id);
      continue;
    }
    if (d.type !== 'assistant') continue;
    for (const b of d.message?.content || []) {
      if (b.type === 'tool_use' && typeof b.name === 'string' && b.name.startsWith('mcp__ccd_turn__')) {
        turnCalls.push({ id: b.id, name: b.name, input: b.input, at: ts(d.timestamp) });
      }
      if (b.type === 'text' && b.text && b.text.trim()) { lastAssistantText = b.text; lastAssistantAt = ts(d.timestamp); }
    }
  }

  // Calls the app refused (tool_result with is_error) do not count
  const okCalls = turnCalls.filter(c => !failedIds.has(c.id));
  for (const c of okCalls) {
    if (c.name.endsWith('wrap_up')) { lastWrapUp = c.input || {}; lastWrapUpAt = c.at; }
    if (c.name.endsWith('update_plan')) lastPlanAt = c.at;
  }

  const value = {
    mtimeMs: st.mtimeMs,
    ...turnState(content.slice(Math.max(0, content.length - 512 * 1024))),
    plan: replayPlan(okCalls),
    lastWrapUp,
    lastWrapUpAt,
    lastPlanAt,
    lastUserAt,
    lastAssistantText,
    lastAssistantAt,
    lastEntryAt: lastEntryAt(content),
  };
  transcriptCache.set(file, { key, value });
  diskCacheDirty = true;
  return value;
}

// Does the transcript end with a finished turn? Finished: a system entry (stop_hook_summary and others)
// or an assistant entry with stop_reason end_turn/stop_sequence/max_tokens. Open: tool_use, tool_result, task notice.
export function turnState(tail) {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i];
    if (!l.startsWith('{')) continue;
    let d;
    try { d = JSON.parse(l); } catch { continue; }
    if (d.isSidechain || !['user', 'assistant', 'system'].includes(d.type)) continue;
    if (d.type === 'system') {
      if (d.subtype === 'stop_hook_summary' || d.subtype === 'turn_duration') return { turnEnded: true, interruptedByUser: false, errored: false };
      if (d.subtype === 'api_error' || d.level === 'error') return { turnEnded: true, interruptedByUser: false, errored: true };
      continue; // compact_boundary, informational and others say nothing about the end of the turn
    }
    if (d.type === 'assistant') {
      const r = d.message?.stop_reason;
      return { turnEnded: r === 'end_turn' || r === 'stop_sequence' || r === 'max_tokens', interruptedByUser: false, errored: false };
    }
    const c = d.message?.content;
    const text = typeof c === 'string' ? c : Array.isArray(c) ? c.map(b => b?.text || '').join(' ') : '';
    if (/^\[Request interrupted by user/.test(text.trim())) return { turnEnded: true, interruptedByUser: true, errored: false };
    return { turnEnded: false, interruptedByUser: false, errored: false };
  }
  return { turnEnded: true, interruptedByUser: false, errored: false };
}

function isHumanPrompt(d) {
  if (d.isMeta || d.toolUseResult) return false;
  const c = d.message?.content;
  if (typeof c === 'string') return !c.startsWith('<');
  if (!Array.isArray(c)) return false;
  return c.some(b => b.type === 'text' && b.text && !b.text.startsWith('<')) && !c.some(b => b.type === 'tool_result');
}

// ---------- Classification ----------

export const BUCKETS = [
  { id: 'warten', label: 'Wartet auf dich', hint: 'Die Session braucht eine Entscheidung, Freigabe oder Handlung von dir.' },
  { id: 'pruefen', label: 'Zum Prüfen', hint: 'Ergebnis liegt vor und will angesehen werden.' },
  { id: 'laeuft', label: 'Läuft gerade', hint: 'Turn läuft noch oder die Session arbeitet im Hintergrund.' },
  { id: 'unterbrochen', label: 'Unterbrochen', hint: 'Turn abgebrochen oder hängengeblieben, oder die Task-Liste blieb ohne Abschluss offen.' },
  { id: 'offen', label: 'Offene Punkte', hint: 'Als fertig gemeldet, nennt aber noch offene Punkte oder eine Frage.' },
  { id: 'unbekannt', label: 'Ohne Status', hint: 'Die App hat für diese Session keine Einschätzung gespeichert (meist alt).' },
  { id: 'erledigt', label: 'Erledigt', hint: 'Abgeschlossen ohne offene Punkte.' },
];

export function classify(meta, tr, now = Date.now()) {
  const s = meta.postTurnSummary || null;
  const category = s?.status_category || null;
  const needsAction = (s?.needs_action || '').trim();
  const plan = tr?.plan || [];
  const openSteps = plan.filter(i => i.status !== 'completed');
  // Full transcript text before the app's report: lastTurnReport is cut to 400 characters
  const fullText = tr?.lastAssistantText || '';
  const textCurrent = !!fullText && !(tr.lastUserAt > (tr.lastAssistantAt || 0));
  // The cut report only when there is no current full text (otherwise it turns "Keine." into "Kein")
  const openList = textCurrent ? parseOpenList(fullText) : parseOpenList(meta.lastTurnReport || '');
  const wrap = tr?.lastWrapUp || null;
  // A wrap-up holds only if no new prompt came after it
  const wrapCurrent = wrap && (!tr.lastUserAt || !tr.lastWrapUpAt || tr.lastWrapUpAt >= tr.lastUserAt);
  // A new prompt with no answer after it
  const promptUnanswered = !!tr?.lastUserAt && tr.lastUserAt > Math.max(tr.lastAssistantAt || 0, tr.lastWrapUpAt || 0);
  const wrapAsk = wrapCurrent ? (wrap.ask || '').trim() : '';
  const wrapBlocked = wrapCurrent && wrap.blocked === true;
  const lastWrite = Math.max(tr?.mtimeMs || 0, meta.lastActivityAt || 0);
  // Displayed time: last real activity (app metadata, last entry with a timestamp), not the file
  // date; the file date only when neither exists.
  // Cap timestamps in the future (wrong clock) at now: otherwise they would pin a mark forever
  const lastActive = Math.min(Math.max(meta.lastActivityAt || 0, tr?.lastEntryAt || 0) || tr?.mtimeMs || 0, now);
  const turnOpen = !!tr && tr.turnEnded === false;
  // Background work: the app reports activity after the last end of a turn
  const background = meta.lastActivityAt && meta.lastTurnEdgeAt && meta.lastActivityAt - meta.lastTurnEdgeAt > 30000
    && now - meta.lastActivityAt < BACKGROUND_WINDOW_MS;
  const running = (turnOpen && now - lastWrite < RUNNING_WINDOW_MS) || background;
  const promptAfterWrap = tr?.lastUserAt && (!tr.lastWrapUpAt || tr.lastUserAt > tr.lastWrapUpAt);
  // The app's verdict "completed" for the last assistant entry beats an open transcript end (old app versions)
  const summaryCurrent = !!s && (!meta.lastAssistantUuid || s.summarizes_uuid === meta.lastAssistantUuid);
  const trustCompleted = category === 'completed' && summaryCurrent && !promptUnanswered;
  const interrupted = !running && (
    (turnOpen && !trustCompleted) || tr?.interruptedByUser || tr?.errored ||
    (promptUnanswered && !trustCompleted) ||
    (openSteps.length > 0 && (!tr.lastWrapUpAt || tr.lastPlanAt > tr.lastWrapUpAt)));
  const question = !wrapAsk && textCurrent ? lastQuestion(fullText) : '';

  const reasons = [];
  let bucket;
  if (running) {
    bucket = 'laeuft';
  } else if (category === 'blocked' || needsAction || meta.interruptedAwaitingPerson || wrapBlocked) {
    bucket = 'warten';
  } else if (category === 'review_ready') {
    bucket = 'pruefen';
  } else if (interrupted) {
    bucket = 'unterbrochen';
  } else if (openList.length || wrapAsk || question || (category && category !== 'completed')) {
    bucket = 'offen';
  } else if (!category) {
    bucket = promptAfterWrap && openSteps.length ? 'unterbrochen' : 'unbekannt';
  } else {
    bucket = 'erledigt';
  }
  if (category) reasons.push(`App-Status: ${category}`);
  if (meta.interruptedAwaitingPerson) reasons.push('Turn wartet auf dich');
  if (wrapBlocked) reasons.push('Wrap-up: blockiert');

  return {
    id: meta.sessionId,
    cliSessionId: meta.cliSessionId || null,
    title: meta.title || '(ohne Titel)',
    cwd: meta.cwd || '',
    createdAt: meta.createdAt || null,
    lastActivityAt: lastActive || null,
    archived: !!meta.isArchived,
    parent: meta.spawnedFrom?.sessionId ? { id: meta.spawnedFrom.sessionId, title: null } : null,
    link: `claude://claude.ai/epitaxy/${meta.sessionId}`,
    bucket,
    category,
    detail: s?.status_detail || '',
    needsAction,
    summary: meta.turnWrapUp?.description || (wrapCurrent ? wrap.recap || '' : ''),
    wrapAsk: wrapAsk || question,
    openList,
    openSteps,
    reasons,
    hasTranscript: !!tr,
  };
}

// Chain of parent sessions, root first, direct parent last (archived links included).
// At most 10 links, cycles stop it; an unknown link without metadata ends the chain.
function ancestorsOf(s, seen) {
  const chain = [];
  const visited = new Set([s.id]);
  let id = s.parent?.id;
  while (id && !visited.has(id) && chain.length < 10) {
    visited.add(id);
    const meta = seen.get(id)?.meta;
    if (!meta) break;
    chain.unshift({ id, title: meta.title || '(ohne Titel)' });
    id = meta.spawnedFrom?.sessionId;
  }
  return chain;
}

export function loadSessions({ metaDirs = defaultMetaDirs(), projectsDir = defaultProjectsDir(), includeArchived = false, now = Date.now() } = {}) {
  const transcripts = indexTranscripts(projectsDir);
  const seen = new Map();
  for (const dir of metaDirs) {
    for (const file of walkFiles(dir, n => n.startsWith('local_') && n.endsWith('.json'))) {
      let meta;
      try { meta = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
      if (!meta.sessionId) continue;
      // Newest version: lastActivityAt, on a tie the most recently written file, then archived before active
      const rank = [meta.lastActivityAt || 0, mtimeOf(file), meta.isArchived ? 1 : 0];
      const prev = seen.get(meta.sessionId);
      if (prev && compareRank(prev.rank, rank) >= 0) continue;
      seen.set(meta.sessionId, { meta, rank });
    }
  }
  // First pick the authoritative (newest) version per ID, then apply the archive filter
  const out = [];
  for (const { meta } of seen.values()) {
    if (meta.isArchived && !includeArchived) continue;
    const tfile = transcripts.get(meta.lastAssistantCliSessionId) || transcripts.get(meta.cliSessionId);
    let tr = null;
    if (tfile) { try { tr = readTranscript(tfile); } catch { tr = null; } }
    out.push(classify(meta, tr, now));
  }
  // spawnedFrom.title is the child's task title, not the parent session's title
  for (const s of out) {
    if (s.parent) s.parent.title = seen.get(s.parent.id)?.meta.title || null;
    s.ancestors = ancestorsOf(s, seen);
  }
  out.sort((a, b) => (b.lastActivityAt || 0) - (a.lastActivityAt || 0));
  return out;
}

// ---------- Web page ----------

export function renderPage(data, { live = false } = {}) {
  const json = JSON.stringify(data).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="de">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Session-Monitor</title>
<style>
:root{--bg:#f6f5f2;--card:#fff;--ink:#1d1d1b;--muted:#6b6a65;--line:#e4e2dc;--accent:#c2410c;
--warten:#b42318;--pruefen:#7c3aed;--laeuft:#0e7490;--unterbrochen:#b45309;--offen:#a16207;--unbekannt:#6b7280;--erledigt:#15803d;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#161614;--card:#21211e;--ink:#ecebe6;--muted:#9c9a92;--line:#33322e;
--warten:#f97066;--pruefen:#a78bfa;--laeuft:#22d3ee;--unterbrochen:#fbbf24;--offen:#facc15;--unbekannt:#9ca3af;--erledigt:#4ade80;color-scheme:dark}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:980px;margin:0 auto;padding:20px 16px 60px}
header{display:flex;flex-wrap:wrap;align-items:baseline;gap:8px 16px;margin-bottom:14px}
h1{font-size:22px;margin:0}
.stamp{color:var(--muted);font-size:13px}
.counts{display:flex;flex-wrap:wrap;gap:8px;margin:0 0 18px}
.count{border:1px solid var(--line);background:var(--card);border-radius:999px;padding:4px 12px;font-size:13px;cursor:pointer;color:var(--ink)}
.count b{color:var(--c)}
.tools{display:flex;flex-wrap:wrap;gap:10px 18px;font-size:13px;color:var(--muted);margin-bottom:16px;align-items:center}
.tools input[type=search]{font:inherit;padding:5px 10px;border:1px solid var(--line);border-radius:8px;background:var(--card);color:var(--ink);min-width:220px}
section{margin-bottom:22px}
section>h2{font-size:15px;margin:0 0 2px;display:flex;gap:8px;align-items:center}
section>h2::before{content:"";width:10px;height:10px;border-radius:50%;background:var(--c)}
section>p.hint{margin:0 0 8px;color:var(--muted);font-size:13px}
details>summary{cursor:pointer;list-style:none}
details>summary::-webkit-details-marker{display:none}
details>summary h2{display:inline-flex}
.card{background:var(--card);border:1px solid var(--line);border-left:4px solid var(--c);border-radius:10px;padding:10px 14px;margin:8px 0}
.top{display:flex;gap:10px;align-items:baseline;flex-wrap:wrap}
.top a{font-weight:600;color:var(--ink);text-decoration:none}
.top a:hover{text-decoration:underline}
.meta{color:var(--muted);font-size:12.5px}
.act{margin:6px 0 0;padding:6px 10px;border-radius:8px;background:color-mix(in srgb,var(--c) 10%,transparent)}
.act b{color:var(--c)}
.detail{margin:4px 0 0;color:var(--muted);font-size:13.5px}
ul{margin:4px 0 0;padding-left:20px}
li{margin:1px 0}
li.ip::marker{content:"▶ "}
.hide{margin-left:auto;font:inherit;font-size:12px;border:1px solid var(--line);background:transparent;color:var(--muted);border-radius:6px;padding:1px 8px;cursor:pointer}
.hide:hover{color:var(--ink)}
.empty{color:var(--muted);font-size:13px}
</style>
</head>
<body>
<main>
<header><h1>Offene Claude-Code-Sessions</h1><span class="stamp" id="stamp"></span></header>
<div class="counts" id="counts"></div>
<div class="tools">
<input type="search" id="q" placeholder="Filtern nach Titel, Ordner, Text">
<label><input type="checkbox" id="showHidden"> ausgeblendete zeigen</label>
<label><input type="checkbox" id="showAll"> auch Ohne Status und Erledigt aufklappen</label>
</div>
<div id="list"></div>
</main>
<script>
const LIVE=${live ? 'true' : 'false'};
const BUCKETS=${JSON.stringify(BUCKETS)};
let DATA=${json};
const store={get(k){try{return JSON.parse(localStorage.getItem(k)||'null')}catch{return null}},set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch{}}};
let hidden=store.get('sm-hidden')||{};
const $=s=>document.querySelector(s);
const esc=s=>String(s??'').replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function ago(ms){if(!ms)return'';const m=Math.round((Date.now()-ms)/60000);if(m<1)return'gerade eben';if(m<60)return'vor '+m+' Min.';const h=Math.round(m/60);if(h<36)return'vor '+h+' Std.';const d=Math.round(h/24);return'vor '+d+' Tagen'}
function shortCwd(c){return String(c||'').replace(/^C:\\\\Users\\\\[^\\\\]+\\\\Documents\\\\Projects\\\\/i,'Projects\\\\')}
const hideKey=s=>s.id+'@'+(s.lastActivityAt||0);
function isHidden(s){return !!hidden[hideKey(s)]}
function card(s){
  const parts=[];
  if(s.needsAction) parts.push('<div class="act"><b>Für dich:</b> '+esc(s.needsAction)+'</div>');
  else if(s.wrapAsk) parts.push('<div class="act"><b>Frage:</b> '+esc(s.wrapAsk)+'</div>');
  const det=s.detail||s.summary; if(det) parts.push('<p class="detail">'+esc(det)+'</p>');
  if(s.openList.length) parts.push('<div class="detail"><b>Noch offen bei dir:</b><ul>'+s.openList.map(i=>'<li>'+esc(i)+'</li>').join('')+'</ul></div>');
  if(s.openSteps.length && s.bucket!=='erledigt') parts.push('<div class="detail"><b>Offene Schritte der Task-Liste:</b><ul>'+s.openSteps.map(i=>'<li class="'+(i.status==='in_progress'?'ip':'')+'">'+esc(i.content)+'</li>').join('')+'</ul></div>');
  const meta=[ago(s.lastActivityAt), shortCwd(s.cwd)];
  if(s.parent&&s.parent.title) meta.push('gestartet aus „'+s.parent.title+'“');
  return '<div class="card" style="--c:var(--'+s.bucket+')"><div class="top"><a href="'+esc(s.link)+'" title="In der Claude-App öffnen">'+esc(s.title)+'</a><span class="meta">'+meta.map(esc).join(' · ')+'</span><button class="hide" data-k="'+esc(hideKey(s))+'">'+(isHidden(s)?'einblenden':'ausblenden')+'</button></div>'+parts.join('')+'</div>';
}
function render(){
  const q=$('#q').value.trim().toLowerCase();
  const showHidden=$('#showHidden').checked, showAll=$('#showAll').checked;
  const rows=DATA.sessions.filter(s=>(showHidden||!isHidden(s))&&(!q||JSON.stringify([s.title,s.cwd,s.detail,s.needsAction,s.summary,s.openList,s.openSteps]).toLowerCase().includes(q)));
  $('#stamp').textContent='Stand '+new Date(DATA.generatedAt).toLocaleTimeString('de-DE',{hour:'2-digit',minute:'2-digit'})+(LIVE?' · aktualisiert sich alle 30 s':'')+' · '+DATA.sessions.length+' Sessions';
  const by={};for(const b of BUCKETS)by[b.id]=[];for(const s of rows)by[s.bucket].push(s);
  $('#counts').innerHTML=BUCKETS.map(b=>'<button class="count" style="--c:var(--'+b.id+')" data-go="'+b.id+'"><b>'+by[b.id].length+'</b> '+esc(b.label)+'</button>').join('');
  const open=new Set(['warten','pruefen','laeuft','unterbrochen','offen']);
  $('#list').innerHTML=BUCKETS.map(b=>{
    const list=by[b.id]; if(!list.length&&!open.has(b.id))return'';
    const body=list.length?list.map(card).join(''):'<p class="empty">Nichts.</p>';
    const head='<h2>'+esc(b.label)+' ('+list.length+')</h2>';
    if(open.has(b.id)||showAll) return '<section id="b-'+b.id+'" style="--c:var(--'+b.id+')">'+head+'<p class="hint">'+esc(b.hint)+'</p>'+body+'</section>';
    return '<section id="b-'+b.id+'" style="--c:var(--'+b.id+')"><details><summary>'+head+'</summary><p class="hint">'+esc(b.hint)+'</p>'+body+'</details></section>';
  }).join('');
}
document.addEventListener('click',e=>{
  const h=e.target.closest('.hide'); if(h){const k=h.dataset.k; if(hidden[k])delete hidden[k]; else hidden[k]=Date.now(); store.set('sm-hidden',hidden); render(); return}
  const g=e.target.closest('[data-go]'); if(g){const sec=document.getElementById('b-'+g.dataset.go); if(sec){const d=sec.querySelector('details'); if(d)d.open=true; sec.scrollIntoView({behavior:'smooth'})}}
});
for(const id of ['q','showHidden','showAll'])$('#'+id).addEventListener('input',render);
render();
if(LIVE)setInterval(async()=>{try{const r=await fetch('/api/sessions',{cache:'no-store'});if(r.ok){DATA=await r.json();render()}}catch{}},30000);
</script>
</body>
</html>`;
}

// ---------- Opening a session ----------

// Only IDs of the app's form local_… become a deep link (the pane checks the same pattern).
export const SESSION_ID = /^local_[A-Za-z0-9-]+$/;

// Program and arguments that hand a URL to the system's handler, per platform. No shell is involved.
export function openerFor(url, platform = process.platform) {
  if (platform === 'win32') return ['rundll32.exe', ['url.dll,FileProtocolHandler', url]];
  if (platform === 'darwin') return ['open', [url]];
  return ['xdg-open', [url]];
}

function runOpener(cmd, args) {
  const r = spawnSync(cmd, args, { stdio: 'ignore', timeout: 10_000, windowsHide: true });
  if (r.error) throw r.error;
  return r.status ?? 1;
}

// Opens the session in the desktop app. Returns the opener's exit code; throws for an invalid ID
// before anything runs. `run` is replaceable so tests open nothing.
export function openSession(id, { platform = process.platform, run = runOpener } = {}) {
  if (typeof id !== 'string' || !SESSION_ID.test(id)) throw new RangeError(`Ungültige Session-ID: ${String(id)}`);
  const [cmd, args] = openerFor(`claude://claude.ai/epitaxy/${id}`, platform);
  return run(cmd, args);
}

// ---------- CLI ----------

function parseArgs(argv) {
  const a = { port: 4317, json: false, html: null, open: null, metaDir: null, projectsDir: null, all: false };
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--port') a.port = Number(argv[++i]);
    else if (k === '--json') a.json = true;
    else if (k === '--open') a.open = argv[++i] ?? '';
    else if (k === '--html') a.html = argv[++i];
    else if (k === '--meta-dir') a.metaDir = argv[++i];
    else if (k === '--projects-dir') a.projectsDir = argv[++i];
    else if (k === '--all') a.all = true;
    else { console.error(`Unbekannte Option: ${k}`); process.exit(2); }
  }
  return a;
}

function snapshot(a) {
  const metaDirs = a.metaDir ? [a.metaDir] : defaultMetaDirs();
  const projectsDir = a.projectsDir || defaultProjectsDir();
  const sessions = loadSessions({ metaDirs, projectsDir, includeArchived: a.all });
  return { generatedAt: Date.now(), metaDirs, sessions };
}

// Only requests to localhost/127.0.0.1 on our own port (guards against DNS rebinding)
export function isAllowedHost(host, port) {
  return [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(String(host || '').toLowerCase());
}

function main() {
  const a = parseArgs(process.argv.slice(2));
  if (a.open !== null) {
    if (!SESSION_ID.test(a.open)) { console.error(`Ungültige Session-ID: ${a.open}`); process.exit(2); }
    let code;
    try { code = openSession(a.open); } catch (err) { console.error(String(err?.message || err)); process.exit(1); }
    if (code !== 0) { console.error(`Öffnen fehlgeschlagen (Exit-Code ${code})`); process.exit(1); }
    return;
  }
  if (a.json || a.html) {
    useDiskCache(path.join(os.tmpdir(), 'session-monitor-cache.json'));
    const snap = snapshot(a);
    saveDiskCache(new Set(indexTranscripts(a.projectsDir || defaultProjectsDir()).values()));
    if (a.json) process.stdout.write(JSON.stringify(snap, null, 2) + '\n');
    else { fs.writeFileSync(a.html, renderPage(snap), 'utf8'); console.log(`geschrieben: ${a.html}`); }
    return;
  }
  const server = http.createServer((req, res) => {
    try {
      if (!isAllowedHost(req.headers.host, a.port)) { res.writeHead(403); res.end(); return; }
      if (req.url.startsWith('/api/sessions')) {
        res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(snapshot(a)));
      } else if (req.url === '/' || req.url.startsWith('/?')) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
        res.end(renderPage(snapshot(a), { live: true }));
      } else { res.writeHead(404); res.end(); }
    } catch (err) {
      res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(String(err?.stack || err));
    }
  });
  server.on('error', err => {
    if (err.code === 'EADDRINUSE') { console.log(`Port ${a.port} belegt, Session-Monitor läuft vermutlich schon: http://localhost:${a.port}`); process.exit(0); }
    throw err;
  });
  server.listen(a.port, '127.0.0.1', () => console.log(`Session-Monitor: http://localhost:${a.port}`));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
