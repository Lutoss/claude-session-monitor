// node tests/session-monitor.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isAllowedHost, isValidCacheEntry, lastEntryAt, lastQuestion, loadSessions, openerFor, openSession, parseOpenList, readTranscript, replayPlan, saveDiskCache, turnState, useDiskCache } from '../scripts/session-monitor.mjs';

const SCRIPT = fileURLToPath(new URL('../scripts/session-monitor.mjs', import.meta.url));
const NOW = Date.parse('2026-11-08T12:00:00Z');
const HOUR = 3600 * 1000;

function line(o) { return JSON.stringify(o); }
const ended = line({ type: 'system', subtype: 'stop_hook_summary', timestamp: '2026-11-08T08:00:00Z' });
const user = (text, ts) => line({ type: 'user', timestamp: ts, message: { role: 'user', content: text } });
const tool = (name, input, ts) => line({ type: 'assistant', timestamp: ts, message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', name, input }] } });
const say = (text, ts) => line({ type: 'assistant', timestamp: ts, message: { stop_reason: 'end_turn', content: [{ type: 'text', text }] } });

function fixture(sessions) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-test-'));
  const meta = path.join(root, 'meta', 'acc', 'org');
  const proj = path.join(root, 'projects', 'C--x');
  fs.mkdirSync(meta, { recursive: true });
  fs.mkdirSync(proj, { recursive: true });
  for (const s of sessions) {
    const mdir = s.metaSub ? path.join(meta, s.metaSub) : meta;
    fs.mkdirSync(mdir, { recursive: true });
    fs.writeFileSync(path.join(mdir, `${s.meta.sessionId}.json`), JSON.stringify(s.meta));
    if (s.lines) {
      const pdir = s.projSub ? path.join(root, 'projects', s.projSub) : proj;
      fs.mkdirSync(pdir, { recursive: true });
      const f = path.join(pdir, `${s.meta.cliSessionId}.jsonl`);
      fs.writeFileSync(f, s.lines.join('\n') + '\n');
      const t = new Date(s.mtime ?? NOW - 2 * HOUR);
      fs.utimesSync(f, t, t);
    }
  }
  return { metaDirs: [path.join(root, 'meta')], projectsDir: path.join(root, 'projects') };
}

function m(id, extra = {}) {
  return { sessionId: `local_${id}`, cliSessionId: `cli-${id}`, title: `T ${id}`, cwd: 'C:\\x', isArchived: false,
    lastActivityAt: NOW - 2 * HOUR, lastTurnEdgeAt: NOW - 2 * HOUR, lastAssistantUuid: 'u1', ...extra };
}
const sum = (status_category, needs_action = '', status_detail = '') => ({ status_category, needs_action, status_detail, summarizes_uuid: 'u1' });

test('classification across all buckets', () => {
  const dirs = fixture([
    { meta: m('blocked', { postTurnSummary: sum('blocked', 'Sag A oder B') }), lines: [user('los', '2026-11-08T07:00:00Z'), say('Frage', '2026-11-08T07:10:00Z'), ended] },
    { meta: m('review', { postTurnSummary: sum('review_ready', '', 'fertig zum Ansehen') }), lines: [ended] },
    { meta: m('running', { postTurnSummary: sum('completed') }), lines: [user('los', '2026-11-08T11:55:00Z'), tool('Bash', {}, '2026-11-08T11:56:00Z')], mtime: NOW - 60 * 1000 },
    { meta: m('background', { lastActivityAt: NOW - 60 * 1000, lastTurnEdgeAt: NOW - 20 * 60 * 1000, postTurnSummary: sum('completed') }), lines: [ended] },
    { meta: m('stopped', { postTurnSummary: sum('blocked') }), lines: [user('los', '2026-11-08T07:00:00Z'), user('[Request interrupted by user]', '2026-11-08T07:01:00Z')] },
    { meta: m('hung'), lines: [user('los', '2026-11-08T07:00:00Z'), tool('mcp__ccd_turn__update_plan', { items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }] }, '2026-11-08T07:00:10Z'), tool('Bash', {}, '2026-11-08T07:01:00Z')] },
    { meta: m('openlist', { postTurnSummary: sum('completed') }), lines: [say('Fertig.\n\n**Noch offen bei dir**\n- Mail an X freigeben\n- Datei ansehen', '2026-11-08T07:00:00Z'), ended] },
    { meta: m('ask', { postTurnSummary: sum('completed') }), lines: [user('los', '2026-11-08T07:00:00Z'), tool('mcp__ccd_turn__wrap_up', { recap: 'r', ask: 'Committen?' }, '2026-11-08T07:05:00Z'), ended] },
    { meta: m('nostatus'), lines: [say('hallo', '2026-11-08T07:00:00Z'), ended] },
    { meta: m('done', { postTurnSummary: sum('completed') }), lines: [user('los', '2026-11-08T07:00:00Z'), tool('mcp__ccd_turn__wrap_up', { recap: 'alles fertig' }, '2026-11-08T07:05:00Z'), ended] },
    { meta: m('archived', { isArchived: true, postTurnSummary: sum('blocked', 'x') }), lines: [ended] },
  ]);
  const got = Object.fromEntries(loadSessions({ ...dirs, now: NOW }).map(s => [s.id.replace('local_', ''), s.bucket]));
  assert.deepEqual(got, {
    blocked: 'warten', review: 'pruefen', running: 'laeuft', background: 'laeuft', stopped: 'warten',
    hung: 'unterbrochen', openlist: 'offen', ask: 'offen', nostatus: 'unbekannt', done: 'erledigt',
  });
});

test('fields for display', () => {
  const dirs = fixture([
    { meta: m('blocked', { postTurnSummary: sum('blocked', 'Sag A oder B', 'wartet') }), lines: [ended] },
    { meta: m('openlist', { postTurnSummary: sum('completed') }), lines: [say('Text\n\nNoch offen bei dir:\n1. Mail freigeben\n2. Bild prüfen\n\nSchluss', '2026-11-08T07:00:00Z'), ended] },
    { meta: m('hung'), lines: [tool('mcp__ccd_turn__update_plan', { items: [{ content: 'A', status: 'completed' }, { content: 'B', status: 'in_progress' }] }, '2026-11-08T07:00:10Z'), tool('Bash', {}, '2026-11-08T07:01:00Z')] },
  ]);
  const by = Object.fromEntries(loadSessions({ ...dirs, now: NOW }).map(s => [s.id, s]));
  assert.equal(by.local_blocked.needsAction, 'Sag A oder B');
  assert.equal(by.local_blocked.link, 'claude://claude.ai/epitaxy/local_blocked');
  assert.deepEqual(by.local_openlist.openList, ['Mail freigeben', 'Bild prüfen']);
  assert.deepEqual(by.local_hung.openSteps, [{ content: 'B', status: 'in_progress' }]);
});

test('parent session is named by its ID, not by the task title', () => {
  const dirs = fixture([
    { meta: m('parent', { title: 'Planung', postTurnSummary: sum('completed') }), lines: [ended] },
    { meta: m('child', { title: 'Kind', spawnedFrom: { sessionId: 'local_parent', title: 'Kind' }, postTurnSummary: sum('completed') }), lines: [ended] },
  ]);
  const child = loadSessions({ ...dirs, now: NOW }).find(s => s.id === 'local_child');
  assert.deepEqual(child.parent, { id: 'local_parent', title: 'Planung' });
});

test('displayed time: last entry with a timestamp, not the file date', () => {
  // As when a session is loaded: bookkeeping lines without a timestamp, file just written
  const tail = [line({ type: 'last-prompt', lastPrompt: 'x' }), line({ type: 'cost-state', totalCostUSD: 1 })];
  const dirs = fixture([{ meta: m('old', { lastActivityAt: NOW - 50 * HOUR, postTurnSummary: sum('completed') }),
    lines: [user('los', '2026-11-06T10:00:00.000Z'), say('fertig', '2026-11-06T10:49:00.000Z'), ended.replace('2026-11-08T08:00:00Z', '2026-11-06T10:49:14.000Z'), ...tail],
    mtime: NOW - 60 * 1000 }]);
  const s = bucketOf(loadSessions({ ...dirs, now: NOW }), 'old');
  assert.equal(new Date(s.lastActivityAt).toISOString(), '2026-11-06T10:49:14.000Z');
  assert.equal(lastEntryAt(['{"timestamp":"2026-01-01T00:00:00Z"}', '{"type":"x"}', 'kaputt{', ''].join('\n')), Date.parse('2026-01-01T00:00:00Z'));
  assert.equal(lastEntryAt('{"type":"x"}\n'), null);
  // Many bookkeeping lines and a trailing newline do not hide the entry
  const many = ['{"timestamp":"2026-11-06T10:49:14.000Z","type":"system"}', ...Array.from({ length: 500 }, () => '{"type":"cost-state"}'), ''].join('\n');
  assert.equal(lastEntryAt(many), Date.parse('2026-11-06T10:49:14.000Z'));
  assert.equal(lastEntryAt(many.replace(/\n/g, '\r\n')), Date.parse('2026-11-06T10:49:14.000Z'));
});

test('a timestamp in the future is capped at now', () => {
  const dirs = fixture([{ meta: m('future', { lastActivityAt: NOW - 50 * HOUR, postTurnSummary: sum('completed') }),
    lines: [say('fertig', '2099-01-01T00:00:00.000Z'), ended.replace('2026-11-08T08:00:00Z', '2099-01-01T00:00:01Z')], mtime: NOW - HOUR }]);
  assert.equal(bucketOf(loadSessions({ ...dirs, now: NOW }), 'future').lastActivityAt, NOW);
});

test('parent chain: root first, through archived links, a cycle stops it', () => {
  const dirs = fixture([
    { meta: m('root', { title: 'Garden planner', isArchived: true, postTurnSummary: sum('completed') }), lines: [ended] },
    { meta: m('mid', { title: 'Seed list', spawnedFrom: { sessionId: 'local_root', title: 'x' }, postTurnSummary: sum('completed') }), lines: [ended] },
    { meta: m('leaf', { title: 'Price check', spawnedFrom: { sessionId: 'local_mid', title: 'x' }, postTurnSummary: sum('completed') }), lines: [ended] },
    { meta: m('a', { title: 'A', spawnedFrom: { sessionId: 'local_b', title: 'x' }, postTurnSummary: sum('completed') }), lines: [ended] },
    { meta: m('b', { title: 'B', spawnedFrom: { sessionId: 'local_a', title: 'x' }, postTurnSummary: sum('completed') }), lines: [ended] },
    { meta: m('orphan', { title: 'O', spawnedFrom: { sessionId: 'local_gone', title: 'x' }, postTurnSummary: sum('completed') }), lines: [ended] },
  ]);
  const by = Object.fromEntries(loadSessions({ ...dirs, now: NOW }).map(s => [s.id, s]));
  assert.deepEqual(by.local_leaf.ancestors.map(a => a.title), ['Garden planner', 'Seed list']);
  assert.deepEqual(by.local_mid.ancestors.map(a => a.title), ['Garden planner']);
  assert.deepEqual(by.local_a.ancestors.map(a => a.title), ['B']);
  assert.deepEqual(by.local_orphan.ancestors, []);
  assert.equal(by.local_root, undefined); // archived: not listed, but still a link of the chain
});

test('a wrap-up question no longer holds after a new prompt', () => {
  const dirs = fixture([
    { meta: m('stale', { postTurnSummary: sum('completed') }), lines: [
      tool('mcp__ccd_turn__wrap_up', { recap: 'r', ask: 'Committen?' }, '2026-11-08T07:05:00Z'),
      user('ja, committe', '2026-11-08T07:06:00Z'), say('Erledigt.', '2026-11-08T07:07:00Z'), ended] },
  ]);
  const [s] = loadSessions({ ...dirs, now: NOW });
  assert.equal(s.wrapAsk, '');
  assert.equal(s.bucket, 'erledigt');
});

test('replayPlan: advance, done, start and wrap_up', () => {
  const plan = replayPlan([
    { name: 'mcp__ccd_turn__update_plan', input: { items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }, { content: 'C', status: 'pending' }] } },
    { name: 'mcp__ccd_turn__update_plan', input: { advance: true } },
  ]);
  assert.deepEqual(plan.map(i => i.status), ['completed', 'in_progress', 'pending']);
  const jumped = replayPlan([
    { name: 'mcp__ccd_turn__update_plan', input: { items: [{ content: 'A', status: 'in_progress' }, { content: 'B', status: 'pending' }, { content: 'C', status: 'pending' }] } },
    { name: 'mcp__ccd_turn__update_plan', input: { done: [1], start: 3 } },
  ]);
  assert.deepEqual(jumped.map(i => i.status), ['completed', 'pending', 'in_progress']);
  const wrapped = replayPlan([
    { name: 'mcp__ccd_turn__update_plan', input: { items: [{ content: 'A', status: 'in_progress' }] } },
    { name: 'mcp__ccd_turn__wrap_up', input: { recap: 'x' } },
  ]);
  assert.deepEqual(wrapped.map(i => i.status), ['completed']);
});

test('parseOpenList: inline form and end of the list', () => {
  assert.deepEqual(parseOpenList('**Noch offen bei dir:** Variante B freigeben'), ['Variante B freigeben']);
  assert.deepEqual(parseOpenList('## Noch offen bei dir\n\n- [ ] A\n  weiter\n- B\nkein Punkt'), ['A weiter', 'B']);
  assert.deepEqual(parseOpenList('Nichts offen.'), []);
});

test('turnState detects open and finished turns', () => {
  assert.deepEqual(turnState(ended), { turnEnded: true, interruptedByUser: false, errored: false });
  assert.deepEqual(turnState(tool('Bash', {}, 't')), { turnEnded: false, interruptedByUser: false, errored: false });
  assert.deepEqual(turnState(user('[Request interrupted by user]', 't')), { turnEnded: true, interruptedByUser: true, errored: false });
  assert.deepEqual(turnState(say('x', 't')), { turnEnded: true, interruptedByUser: false, errored: false });
});

// ---------- Regressions ----------

const result = (id, isError, ts) => line({ type: 'user', timestamp: ts, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: 'x' }] } });
const toolId = (id, name, input, ts) => line({ type: 'assistant', timestamp: ts, message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id, name, input }] } });
const bucketOf = (sessions, id) => sessions.find(s => s.id === `local_${id}`);

test('R1: the cut app report does not displace the full reply text', () => {
  const long = 'x'.repeat(500) + '\n\n**Noch offen bei dir**\n- Account-Upload machen';
  const dirs = fixture([{ meta: m('trunc', { lastTurnReport: long.slice(0, 400), postTurnSummary: sum('completed') }), lines: [user('los', '2026-11-08T07:00:00.000Z'), say(long, '2026-11-08T07:05:00.000Z'), ended] }]);
  const s = bucketOf(loadSessions({ ...dirs, now: NOW }), 'trunc');
  assert.deepEqual([s.bucket, s.openList], ['offen', ['Account-Upload machen']]);
});

test('R2: a new unanswered prompt after a completed summary counts as interrupted', () => {
  const dirs = fixture([{ meta: m('newprompt', { postTurnSummary: sum('completed') }), lines: [
    user('erst', '2026-11-08T09:00:00.000Z'), say('fertig', '2026-11-08T10:00:00.000Z'), ended,
    user('und noch das', '2026-11-08T11:00:00.000Z')] }]);
  assert.equal(bucketOf(loadSessions({ ...dirs, now: NOW }), 'newprompt').bucket, 'unterbrochen');
});

test('R3: more open-item formats and a closing question', () => {
  assert.deepEqual(parseOpenList('Offen:\nDer Desktop-Spieltest ist ungeklärt.\n\nSonst nichts.'), ['Der Desktop-Spieltest ist ungeklärt.']);
  assert.deepEqual(parseOpenList('**Noch offen bei dir**\n- A\n\n- B\n\nEnde'), ['A', 'B']);
  assert.deepEqual(parseOpenList('**Noch offen bei dir:** Keine.'), []);
  assert.deepEqual(parseOpenList('## Noch offen bei dir\n- [x] erledigt\n- [ ] offen'), ['offen']);
  assert.equal(lastQuestion('Alles gebaut.\n\nSoll ich die mit committen oder erstmal so liegen lassen?'), 'Soll ich die mit committen oder erstmal so liegen lassen?');
  assert.equal(lastQuestion('Was meinst du? Ich habe es gebaut.'), '');
  const dirs = fixture([{ meta: m('q'), lines: [user('los', '2026-11-08T07:00:00.000Z'), say('Fertig.\n\nSoll ich committen?', '2026-11-08T07:05:00.000Z'), ended] }]);
  const s = bucketOf(loadSessions({ ...dirs, now: NOW }), 'q');
  assert.deepEqual([s.bucket, s.wrapAsk], ['offen', 'Soll ich committen?']);
});

test('R4: start sets only the named step, other running steps stay running', () => {
  const plan = replayPlan([
    { name: 'mcp__ccd_turn__update_plan', input: { items: ['1', '2', '3', '4', '5'].map((c, i) => ({ content: c, status: i < 3 ? 'in_progress' : 'pending' })) } },
    { name: 'mcp__ccd_turn__update_plan', input: { done: [2, 3], start: 4 } },
  ]);
  assert.deepEqual(plan.map(i => i.status), ['in_progress', 'completed', 'completed', 'in_progress', 'pending']);
});

test('R5: refused update_plan calls do not count', () => {
  const dirs = fixture([{ meta: m('rejected'), lines: [
    toolId('t1', 'mcp__ccd_turn__update_plan', { items: [{ content: 'A', status: 'in_progress' }] }, '2026-11-08T07:00:00.000Z'),
    result('t1', true, '2026-11-08T07:00:01.000Z'),
    say('ok', '2026-11-08T07:01:00.000Z'), ended] }]);
  assert.deepEqual(bucketOf(loadSessions({ ...dirs, now: NOW }), 'rejected').openSteps, []);
});

test('R6: timestamps with and without milliseconds compare numerically', () => {
  const dirs = fixture([{ meta: m('ms', { postTurnSummary: sum('completed') }), lines: [
    user('los', '2026-11-08T11:00:00Z'),
    tool('mcp__ccd_turn__wrap_up', { recap: 'r', ask: 'Committen?' }, '2026-11-08T11:00:00.100Z'), ended] }]);
  const s = bucketOf(loadSessions({ ...dirs, now: NOW }), 'ms');
  assert.deepEqual([s.bucket, s.wrapAsk], ['offen', 'Committen?']);
});

test('R7: api_error interrupts, compact_boundary is skipped', () => {
  const apiErr = line({ type: 'system', subtype: 'api_error', level: 'error' });
  const compact = line({ type: 'system', subtype: 'compact_boundary', level: 'info' });
  assert.deepEqual(turnState(apiErr), { turnEnded: true, interruptedByUser: false, errored: true });
  assert.deepEqual(turnState([tool('Bash', {}, 't'), compact].join('\n')), { turnEnded: false, interruptedByUser: false, errored: false });
  const dirs = fixture([{ meta: m('err', { postTurnSummary: sum('completed') }), lines: [user('los', '2026-11-08T07:00:00.000Z'), say('teil', '2026-11-08T07:01:00.000Z'), apiErr] }]);
  assert.equal(bucketOf(loadSessions({ ...dirs, now: NOW }), 'err').bucket, 'unterbrochen');
});

test('R8: the newest metadata version counts before the archive filter, the newest transcript wins', () => {
  const dirs = fixture([
    { meta: m('dup', { lastActivityAt: NOW - 5 * HOUR, postTurnSummary: sum('blocked', 'alt') }), metaSub: 'a', lines: [ended] },
    { meta: m('dup', { lastActivityAt: NOW - 1 * HOUR, isArchived: true }), metaSub: 'b' },
    { meta: m('moved', { postTurnSummary: sum('completed') }), projSub: 'old', lines: [say('nichts', '2026-11-08T07:00:00.000Z'), ended], mtime: NOW - 5 * HOUR },
    { meta: m('moved', { postTurnSummary: sum('completed') }), projSub: 'new', metaSub: 'c', lines: [say('**Noch offen bei dir:** neu', '2026-11-08T08:00:00.000Z'), ended], mtime: NOW - 1 * HOUR },
  ]);
  const all = loadSessions({ ...dirs, now: NOW });
  assert.equal(bucketOf(all, 'dup'), undefined);
  assert.deepEqual(bucketOf(all, 'moved').openList, ['neu']);
});

test('R9: the server accepts localhost hosts only', () => {
  assert.equal(isAllowedHost('localhost:4317', 4317), true);
  assert.equal(isAllowedHost('127.0.0.1:4317', 4317), true);
  assert.equal(isAllowedHost('review-attacker.invalid:4317', 4317), false);
  assert.equal(isAllowedHost(undefined, 4317), false);
});

test('R10: heading with a note and a trailing colon, items below', () => {
  assert.deepEqual(parseOpenList('**Noch offen bei dir** (beide auch im Tracker):\n- Upload\n- Anmeldung'), ['Upload', 'Anmeldung']);
});

test('A1: "Keine." in the full text is not overruled by the cut report', () => {
  const full = 'x'.repeat(374) + '\n\nNoch offen bei dir: Keine.';
  const dirs = fixture([{ meta: m('keine', { lastTurnReport: full.slice(0, 400), postTurnSummary: sum('completed') }), lines: [user('los', '2026-11-08T07:00:00.000Z'), say(full, '2026-11-08T07:05:00.000Z'), ended] }]);
  const s = bucketOf(loadSessions({ ...dirs, now: NOW }), 'keine');
  assert.deepEqual([s.bucket, s.openList], ['erledigt', []]);
});

test('A2: "Offenbar", "Offen ist …" and "Offen und schwach:" are no headings', () => {
  assert.deepEqual(parseOpenList('Offenbar ist alles erledigt.'), []);
  assert.deepEqual(parseOpenList('Offen ist nichts mehr.'), []);
  assert.deepEqual(parseOpenList('Offen und schwach:\n- Kanal B'), []);
  assert.deepEqual(parseOpenList('**Offen:** Spieltest'), ['Spieltest']);
  assert.deepEqual(parseOpenList('### Offen\n- Spieltest'), ['Spieltest']);
});

test('A3: stock phrases and delivered questions do not count as a question to the user', () => {
  assert.equal(lastQuestion('Fertig.\n\nHier die gewünschte Interviewfrage: Wie geht es dir?'), '');
  assert.equal(lastQuestion('Fertig.\n\nNoch Fragen?'), '');
  assert.equal(lastQuestion('Fertig.\n\nWas ist die Hauptstadt von Frankreich?'), '');
  assert.equal(lastQuestion('Fertig.\n\nSoll ich das committen?'), 'Soll ich das committen?');
});

test('A4: with equal lastActivityAt the most recently written metadata file wins', () => {
  const dirs = fixture([
    { meta: m('tie', { postTurnSummary: sum('blocked', 'x') }), metaSub: 'a', lines: [ended] },
    { meta: m('tie', { isArchived: true }), metaSub: 'b' },
  ]);
  const older = path.join(dirs.metaDirs[0], 'acc', 'org', 'a', 'local_tie.json');
  fs.utimesSync(older, new Date(NOW - 9 * HOUR), new Date(NOW - 9 * HOUR));
  assert.equal(bucketOf(loadSessions({ ...dirs, now: NOW }), 'tie'), undefined);
});

test('A5: structurally broken cache entries are discarded', () => {
  assert.equal(isValidCacheEntry({ key: '1:2' }), false);
  assert.equal(isValidCacheEntry({ key: '1:2', value: { plan: {}, mtimeMs: 1, turnEnded: true } }), false);
  const dirs = fixture([{ meta: m('cache', { postTurnSummary: sum('completed') }), lines: [say('**Noch offen bei dir:** X', '2026-11-08T07:00:00.000Z'), ended] }]);
  const tfile = path.join(dirs.projectsDir, 'C--x', 'cli-cache.jsonl');
  const st = fs.statSync(tfile);
  const cacheFile = path.join(path.dirname(dirs.projectsDir), 'cache.json');
  fs.writeFileSync(cacheFile, JSON.stringify({ version: 3, entries: { [tfile]: { key: `${st.size}:${st.mtimeMs}`, value: { plan: {} } } } }));
  useDiskCache(cacheFile);
  const s = bucketOf(loadSessions({ ...dirs, now: NOW }), 'cache');
  assert.deepEqual([s.hasTranscript, s.openList], [true, ['X']]);
});

test('A6: the cache is written through a temp file of its own and stays readable', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-cache-'));
  const dirs = fixture([{ meta: m('c2'), lines: [ended] }]);
  const cacheFile = path.join(dir, 'cache.json');
  useDiskCache(cacheFile);
  readTranscript(path.join(dirs.projectsDir, 'C--x', 'cli-c2.jsonl'));
  saveDiskCache();
  assert.equal(JSON.parse(fs.readFileSync(cacheFile, 'utf8')).version, 3);
  assert.deepEqual(fs.readdirSync(dir).filter(f => f.endsWith('.tmp')), []);
});

test('C1: a label with a comma note ("**Offen, nur für Alex:**") is recognised, running text is not', () => {
  assert.deepEqual(parseOpenList('**Offen, nur für Alex:**\n- Plan wählen\n- Trace melden'), ['Plan wählen', 'Trace melden']);
  assert.deepEqual(parseOpenList('Offen, wie besprochen, bleibt nur der Test.'), []);
  assert.deepEqual(parseOpenList('Offen und schwach:\n- Kanal B'), []);
});

test('C2: a cache entry with invalid plan items is discarded', () => {
  assert.equal(isValidCacheEntry({ key: '1:2', value: { plan: [null], mtimeMs: 1, turnEnded: true } }), false);
  assert.equal(isValidCacheEntry({ key: '1:2', value: { plan: [{ content: 'A', status: 'pending' }], mtimeMs: 1, turnEnded: true, lastEntryAt: null } }), true);
  // Entries from cache version 2 without lastEntryAt are read again instead of taken with a wrong time
  assert.equal(isValidCacheEntry({ key: '1:2', value: { plan: [], mtimeMs: 1, turnEnded: true } }), false);
});

// ---------- Opening a session (--open) ----------

test('--open: an invalid ID exits with 2 and opens nothing', () => {
  for (const bad of [['--open', 'local_x; calc'], ['--open', 'https://example.invalid'], ['--open', 'local_'], ['--open']]) {
    const r = spawnSync(process.execPath, [SCRIPT, ...bad], { encoding: 'utf8' });
    assert.equal(r.status, 2, `${bad.join(' ')}: ${r.stderr}`);
  }
});

test('openSession: valid ID hands the deep link to the platform opener, without a shell', () => {
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, args]); return 0; };
  assert.equal(openSession('local_ab-12', { platform: 'win32', run }), 0);
  assert.equal(openSession('local_ab-12', { platform: 'darwin', run }), 0);
  assert.equal(openSession('local_ab-12', { platform: 'linux', run }), 0);
  const url = 'claude://claude.ai/epitaxy/local_ab-12';
  assert.deepEqual(calls, [
    ['rundll32.exe', ['url.dll,FileProtocolHandler', url]],
    ['open', [url]],
    ['xdg-open', [url]],
  ]);
  assert.deepEqual(openerFor(url, 'freebsd'), ['xdg-open', [url]]);
});

test('openSession: an invalid ID throws before anything runs; the opener\'s exit code is passed on', () => {
  const calls = [];
  const run = (cmd, args) => { calls.push([cmd, args]); return 3; };
  assert.throws(() => openSession('local_x&calc', { platform: 'win32', run }), RangeError);
  assert.throws(() => openSession(42, { platform: 'win32', run }), RangeError);
  assert.deepEqual(calls, []);
  assert.equal(openSession('local_ok', { platform: 'linux', run }), 3);
});
