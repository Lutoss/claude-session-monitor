import { expect, mock, test } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'

import { BUCKETS, ago, renderSafely, shortProject, slim } from '../hooks/register'
import type { PaneCtx } from '../hooks/types'

const PANE = {
  plugin: 'session-monitor',
  component: 'Pane',
  requestId: 'session-monitor',
  props: {
    title: 'Sessions',
    isFocused: false,
    bodyColumns: 60,
    placement: 'dock',
    scroll: { offset: 0, bodyRows: 40 },
    view: {},
  },
} as const

const NOW = Date.parse('2026-11-08T12:00:00Z')

const DATA = {
  generatedAt: NOW,
  sessions: [
    {
      id: 'local_a', title: 'Release planen', cwd: 'C:\\Users\\alex\\Documents\\Projects\\recipe-book',
      lastActivityAt: NOW - 3 * 3600_000, bucket: 'warten', needsAction: 'Termin für den Release festlegen',
      wrapAsk: '', detail: 'wartet', openList: [], openSteps: [], parent: null,
    },
    {
      id: 'local_b', title: 'Website', cwd: 'C:\\Work', lastActivityAt: NOW - 86400_000 * 2,
      bucket: 'offen', needsAction: '', wrapAsk: 'Soll ich committen?', detail: '',
      openList: ['Bild prüfen'], openSteps: [{ content: 'Deploy', status: 'in_progress' }],
      parent: { id: 'local_a', title: 'Release planen' },
    },
    {
      id: 'local_c', title: 'Alt und fertig', cwd: 'C:\\Work', lastActivityAt: NOW - 86400_000 * 9,
      bucket: 'erledigt', needsAction: '', wrapAsk: '', detail: 'fertig', openList: [], openSteps: [], parent: null,
    },
  ],
}

// The script path is "<plugin root>/scripts/session-monitor.mjs"; the root differs per machine.
const SCRIPT_PATH = /^(?:[A-Za-z]:)?[\\/](?!.*\.claude-plugin).*[\\/]scripts\/session-monitor\.mjs$/

type Run = { exitCode: number; stdout: string; stderr: string }

function engineBeneath(
  on: Parameters<TestBody>[1],
  runs: string[][],
  store: Record<string, unknown> = {},
  opened: string[] = [],
  data: object = DATA,
  answer: (argv: string[]) => Run | null = () => null,
) {
  const clock = mock.clock(on, { now: NOW })
  // The store as a stand-in, so the test can read what the mod keeps across sessions
  on('store.get', async (_, e) => {
    if (store['__failGet']) throw new Error('store.get broken (test)')
    // A test can hold a read back to stage a race: store.__hold = { key, promise }
    const hold = store['__hold'] as { key: string; promise: Promise<void>; reached?: () => void } | undefined
    if (hold && hold.key === e.key) { hold.reached?.(); await hold.promise }
    return { value: store[e.key] }
  })
  on('store.set', (_, e) => {
    if (store['__failSet']) throw new Error('store.set broken (test)')
    store[e.key] = e.value
    return { value: undefined }
  })
  on('store.delete', (_, e) => {
    delete store[e.key]
    return { value: undefined }
  })
  on('store.keys', () => {
    if (store['__failKeys']) throw new Error('store.keys broken (test)')
    return { value: Object.keys(store) }
  })
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', (_, e) => {
    opened.push(e.id)
    return { value: { isPlaced: true } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', (_, e) => {
    runs.push([...e.argv])
    const r = answer([...e.argv]) ?? { exitCode: 0, stdout: e.argv.includes('--json') ? JSON.stringify(data) : '', stderr: '' }
    return { value: { ...r, isStdoutTruncated: false, isStderrTruncated: false } }
  })
  return clock
}

const openCall = (runs: string[][], id: string) => ['node', runs[0]?.[1] ?? '?', '--open', id]

test('slim, ago and shortProject', async () => {
  const s = slim(DATA)
  expect(s.rows.map(r => [r.id, r.bucket, r.project, r.parentTitle])).toEqual([
    ['local_a', 'warten', 'recipe-book', null],
    ['local_b', 'offen', 'Work', 'Release planen'],
    ['local_c', 'erledigt', 'Work', null],
  ])
  expect(ago(NOW - 5 * 60_000, NOW)).toBe('vor 5 Min.')
  expect(ago(NOW - 3 * 3600_000, NOW)).toBe('vor 3 Std.')
  expect(ago(NOW - 2 * 86400_000, NOW)).toBe('vor 2 Tagen')
  expect(shortProject('C:/Users/x/Documents/Projects/web/app')).toBe('web\\app')
  expect(shortProject('C:\\Users\\x\\Documents\\Projects\\skills\\')).toBe('skills')
  expect(shortProject('C:\\Work')).toBe('Work')
  expect(shortProject('')).toBe('')
  expect(shortProject('C:/Users/x/Documents/Projects/skills//')).toBe('skills')
  expect(shortProject('C:/Users/x/Documents/Projects/web//app')).toBe('web\\app')
  expect(shortProject('C:/Users/x/Documents/Projects//')).toBe('Projects')
  // Any folder named Projects counts, not only one under Documents
  expect(shortProject('/home/alex/projects/web/app')).toBe('web\\app')
  expect(shortProject('D:\\Projects\\tools')).toBe('tools')
  expect(shortProject('Projects/tools')).toBe('tools')
  // A folder that merely ends in "Projects" does not
  expect(shortProject('C:\\MyProjects\\tools')).toBe('tools')
  expect(shortProject('C:\\MyProjects\\a\\b')).toBe('b')
})

for (const surface of ['terminal', 'desktop'] as const) {
  test(`pane shows every session, nothing hidden (${surface})`, { timeoutMs: 20_000 }, async ($, on) => {
    const runs: string[][] = []
    const store: Record<string, unknown> = {}
    engineBeneath(on, runs, store)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })

    expect(runs[0]?.length).toBe(3)
    expect([runs[0]?.[0], runs[0]?.[2]]).toEqual(['node', '--json'])
    expect(runs[0]?.[1]).toMatch(SCRIPT_PATH)
    expect((await ui.find({ type: 'Box', key: 's-local_a' }))?.key).toBe('s-local_a')
    expect((await ui.find({ type: 'Text', text: /^Wartet auf dich$/ }))?.text).toBe('Wartet auf dich')
    expect((await ui.find({ type: 'Text', text: /^Release planen$/, in: 'card-local_a' }))?.text).toBe('Release planen')
    expect((await ui.find({ type: 'Text', text: /Termin für den Release/, in: 'card-local_a' }))?.text).toBe('Termin für den Release festlegen')
    expect((await ui.find({ type: 'Text', text: /Soll ich committen/, in: 'card-local_b' }))?.text).toBe('Soll ich committen?')
    expect((await ui.find({ type: 'Text', text: /^Bild prüfen$/, in: 'card-local_b' }))?.text).toBe('Bild prüfen')
    expect((await ui.find({ type: 'Text', text: /^Deploy$/, in: 'card-local_b' }))?.text).toBe('Deploy')
    // "Erledigt" is collapsed: card not visible, after expanding it is
    expect(await ui.find({ type: 'Box', key: 's-local_c' })).toBeUndefined()
    await ui.press({ key: 'toggle-erledigt' })
    expect((await ui.find({ type: 'Text', text: /Alt und fertig/, in: 'card-local_c' }))?.text).toBe('Alt und fertig')
    // No hide button: the monitor shows every session
    expect(await ui.find({ key: 'hide-local_a' })).toBeUndefined()
    expect(await ui.find({ key: 'unhide-all' })).toBeUndefined()
    await ui.unmount()
  })
}

test('the open button opens the session through the script', async ($, on) => {
  const runs: string[][] = []
  engineBeneath(on, runs)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'open-local_b' })
  expect(runs.at(-1)).toEqual(openCall(runs, 'local_b'))
  await ui.unmount()
})

test('a failed open shows a toast with the script\'s message', { timeoutMs: 20_000 }, async ($, on) => {
  const runs: string[][] = []
  const toasts: string[] = []
  engineBeneath(on, runs, {}, [], DATA, argv => (argv.includes('--open') ? { exitCode: 1, stdout: '', stderr: 'no handler for claude://' } : null))
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await ui.press({ key: 'open-local_a' })
  expect(toasts).toEqual(['Session ließ sich nicht öffnen: no handler for claude://'])
  await ui.unmount()
})

test('a script error appears in the pane', async ($, on) => {
  mock.clock(on, { now: NOW })
  mock.store(on)
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({
    value: { exitCode: 1, stdout: '', stderr: 'node: not found', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Text', text: /node: not found/ }))?.text).toContain('node: not found')
  await ui.unmount()
})

// The mod loads in every session: no unrequested opening, no script run before /sessions
for (const surface of [null, 'desktop', 'terminal'] as const) {
  test(`start opens nothing and runs no script (${String(surface)})`, async ($, on) => {
    const opened: string[] = []
    const runs: string[][] = []
    engineBeneath(on, runs, {}, opened)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    expect([opened, runs]).toEqual([[], []])
  })
}

test('/sessions opens the pane and starts refreshing', async ($, on) => {
  const opened: string[] = []
  const runs: string[][] = []
  engineBeneath(on, runs, {}, opened)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const r = await $.command.run({ command: 'sessions', args: '' } as never)
  expect(opened).toEqual(['session-monitor'])
  expect(runs.length).toBeGreaterThan(0)
  expect(runs[0]?.at(-1)).toBe('--json')
  expect(JSON.stringify(r)).toContain('Session-Monitor geöffnet')
})

test('when the app draws the pane by itself, refreshing starts right after', { timeoutMs: 20_000 }, async ($, on) => {
  const runs: string[][] = []
  const clock = engineBeneath(on, runs)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  expect(runs).toEqual([])
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await clock.advance(10)
  expect(runs.length).toBeGreaterThan(0)
  await ui.unmount()
})

test('unrelated store keys hide nothing', { timeoutMs: 20_000 }, async ($, on) => {
  const store: Record<string, unknown> = {
    hidden: { 'local_x@1': 5 },
    [`hidden:local_a@${NOW - 3 * 3600_000}`]: 6,
    variant: 'something-else',
  }
  engineBeneath(on, [], store)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Text', text: /^Release planen$/, in: 'card-local_a' }))?.text).toBe('Release planen')
  expect((await ui.find({ type: 'Box', key: 's-local_a' }))?.key).toBe('s-local_a')
  await ui.unmount()
})

test('truncated script output reports a clear error', async ($, on) => {
  mock.clock(on, { now: NOW })
  on('store.get', () => ({ value: undefined }))
  on('command.register', () => ({ value: { command: 'sessions' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: '{"sessions":[{"id":"loc', stderr: '', isStdoutTruncated: true, isStderrTruncated: false },
  }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Text', text: /über 4 MiB/ }))?.text).toContain('über 4 MiB')
  await ui.unmount()
})

test('session.attach does not open the pane', async ($, on) => {
  const opened: string[] = []
  engineBeneath(on, [], {}, opened)
  on('session.attach', (_, e) => ({ clientId: e.clientId }))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.session.attach({ surface: 'desktop', clientId: 'c1', viewport: { columns: 200, rows: 50 } })
  expect(opened).toEqual([])
})

for (const surface of ['desktop', 'terminal'] as const) {
  test(`pane draws the required elements (${surface})`, { timeoutMs: 20_000 }, async ($, on) => {
    const runs: string[][] = []
    engineBeneath(on, runs)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    for (const key of ['open-local_a', 'open-local_b', 'toggle-warten', 'toggle-offen', 'toggle-erledigt']) {
      expect((await ui.find({ key }))?.key).toBe(key)
    }
    expect(await ui.find({ key: 'hide-local_a' })).toBeUndefined()
    expect(await ui.find({ text: /ausblenden/i })).toBeUndefined()
    expect((await ui.find({ text: /^Release planen$/, in: 'card-local_a' }))?.text).toBe('Release planen')
    expect((await ui.find({ text: /Termin für den Release festlegen/, in: 'card-local_a' }))?.text).toContain('Termin für den Release festlegen')
    expect((await ui.find({ text: /Bild prüfen/, in: 'card-local_b' }))?.text).toContain('Bild prüfen')
    expect((await ui.find({ text: /Soll ich committen/, in: 'card-local_b' }))?.text).toContain('Soll ich committen?')
    expect((await ui.find({ text: /Deploy/, in: 'card-local_b' }))?.text).toContain('Deploy')
    // Time as its own Text (top right in the box), not appended to the project or origin
    expect((await ui.find({ type: 'Text', text: /^vor 3 Std\.$/, in: 'card-local_a' }))?.text).toBe('vor 3 Std.')
    // Every session is a framed Box; in the default scheme "Ruhig" only "Wartet" carries the accent
    // (claude), "Offene Punkte" is neutral grey; the card itself (key s-<id>), not some inner line
    const cardOf = async (id: string) => (await ui.findAll({ type: 'Box' })).find(b => b.key === `s-${id}`)
    for (const [id, color] of [['local_a', 'claude'], ['local_b', '#8b949e66']] as const) {
      const c = await cardOf(id)
      expect(Boolean(c?.props['borderStyle'])).toBe(true)
      expect(c?.props['borderColor']).toBe(color)
    }
    await ui.press({ key: 'open-local_b' })
    expect(runs.at(-1)).toEqual(openCall(runs, 'local_b'))
    await ui.unmount()
  })
}

test('sub-session: the footer shows only the main session next to the folder', { timeoutMs: 20_000 }, async ($, on) => {
  engineBeneath(on, [], {}, [], { generatedAt: NOW, sessions: [
    { ...DATA.sessions[0], id: 'local_k2', title: 'Benchmark', parent: { id: 'p', title: 'Seed list' }, ancestors: [{ id: 'r', title: 'Garden planner' }, { id: 'p', title: 'Seed list' }] },
    { ...DATA.sessions[0], id: 'local_k3', title: 'Tief', ancestors: [{ id: 'r', title: 'Wurzel' }, { id: 'm', title: 'Mitte' }, { id: 'p', title: 'Eltern' }] },
    { ...DATA.sessions[0], id: 'local_k0', title: 'Allein', parent: null },
  ] })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  // Footer outside the card: folder, next to it the main session, then the buttons in the same row
  const all = await ui.findAll({})
  const at = (pred: (e: { type: string; key?: string; text: string }) => boolean) => all.findIndex(pred)
  const footerOf = (id: string) => {
    const btn = at(e => e.type === 'Button' && e.key === `open-${id}`)
    // Texts between the previous open button (or the start) and this one
    const prev = all.slice(0, btn).map((e, i) => (e.type === 'Button' && e.key?.startsWith('open-') ? i : -1)).filter(i => i >= 0).at(-1) ?? -1
    return all.slice(prev + 1, btn).filter(e => e.type === 'Text').map(e => e.text)
  }
  expect(footerOf('local_k2').slice(-2)).toEqual(['recipe-book', 'Garden planner'])
  expect(footerOf('local_k3').slice(-2)).toEqual(['recipe-book', 'Wurzel'])
  // Not a sub-session: only the folder
  expect(footerOf('local_k0').at(-1)).toBe('recipe-book')
  expect(footerOf('local_k0').some(t => t === 'Wurzel' || t === 'Garden planner')).toBe(false)
  // Folder and main session in the same font size as the buttons (body), not small
  const proj = all.find(e => e.type === 'Text' && e.text === 'Garden planner')
  expect(proj?.props['size']).toBe('body')
  // The main session appears exactly once per card, none of it inside the card itself
  const inCard = async (id: string) => (await ui.findAll({ type: 'Text', in: `card-${id}` })).map(t => t.text)
  const k2 = await inCard('local_k2')
  const k3 = await inCard('local_k3')
  expect([...k2, ...k3].some(t => t.includes('Garden planner') || t.includes('Wurzel') || t === 'recipe-book')).toBe(false)
  expect(all.filter(e => e.type === 'Text' && e.text.includes('Garden planner')).length).toBe(1)
  expect(all.some(e => e.type === 'Text' && (e.text.startsWith('↳ ') || e.text.includes('Sub-Session') || e.text.includes('aus „')))).toBe(false)
  await ui.unmount()
})

test('slim: chain from ancestors, else falls back to the direct parent', () => {
  const rows = slim({ sessions: [
    { id: 'a', ancestors: [{ id: 'r', title: 'R' }, { id: 'p', title: 'P' }], parent: { id: 'p', title: 'P' } },
    { id: 'b', parent: { id: 'p', title: 'P' } },
    { id: 'c', parent: null },
  ] }).rows
  expect(rows.map(r => r.ancestors)).toEqual([['R', 'P'], ['P'], []])
  expect(slim({ sessions: [{ id: 'd', ancestors: [{ id: 'r', title: '  ' }, { id: 'p', title: 'P' }] }] }).rows[0]?.ancestors).toEqual(['(ohne Titel)', 'P'])
})

test('renderSafely: a throwing drawing shows only an error line', () => {
  const el = Object.fromEntries(['Box', 'Text', 'Button', 'Select', 'Svg', 'Markdown', 'Link', 'Code', 'Input'].map(n => [n, (props: object) => ({ el: n, props })]))
  const rows = slim(DATA).rows
  const ctx = {
    el, surface: 'desktop', width: 60, now: NOW, generatedAt: NOW, isLoading: false, error: null,
    buckets: [{ id: 'warten', label: 'Wartet auf dich', open: true }],
    byBucket: { warten: rows.filter(r => r.bucket === 'warten') }, isOpen: () => true,
    dropped: 0, ago: () => 'vor 1 Min.', markOf: () => null,
    actions: { open: () => {}, mark: () => {}, toggleBucket: () => {}, refresh: () => {} },
  } as unknown as PaneCtx
  const out = JSON.stringify(renderSafely(ctx, () => { throw new Error('boom') }))
  expect(out).toContain('Die Pane konnte nicht gezeichnet werden: boom')
  expect(out).not.toContain('Release planen')
})

// ---------- Pause / finish ----------
const cardOpen = async (ui: { find: (q: object) => Promise<{ key?: string } | undefined> }, id: string) =>
  Boolean(await ui.find({ type: 'Box', key: `s-${id}` }))

test('pause, finish and reopen move the card and land in the store', { timeoutMs: 30_000 }, async ($, on) => {
  const store: Record<string, unknown> = {}
  engineBeneath(on, [], store)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  // Start: local_a is waiting (expanded), buttons at the bottom right
  expect(await cardOpen(ui, 'local_a')).toBe(true)
  for (const key of ['open-local_a', 'pause-local_a', 'done-local_a']) expect((await ui.find({ key }))?.key).toBe(key)

  await ui.press({ key: 'pause-local_a' })
  expect(store['mark:local_a']).toEqual({ kind: 'pausiert', at: NOW - 3 * 3600_000 })
  // "Pausiert" is collapsed: card gone, group there
  expect(await cardOpen(ui, 'local_a')).toBe(false)
  await ui.press({ key: 'toggle-pausiert' })
  expect(await cardOpen(ui, 'local_a')).toBe(true)
  expect((await ui.find({ key: 'resume-local_a' }))?.key).toBe('resume-local_a')
  expect(await ui.find({ key: 'pause-local_a' })).toBeUndefined()

  await ui.press({ key: 'done-local_a' })
  expect(store['mark:local_a']).toEqual({ kind: 'erledigt', at: NOW - 3 * 3600_000 })
  await ui.press({ key: 'toggle-erledigt' })
  expect(await cardOpen(ui, 'local_a')).toBe(true)
  expect(await ui.find({ key: 'done-local_a' })).toBeUndefined()

  await ui.press({ key: 'resume-local_a' })
  expect(store['mark:local_a']).toBeUndefined()
  expect((await ui.find({ key: 'pause-local_a' }))?.key).toBe('pause-local_a')
  await ui.unmount()
})

test('a stored mark holds at start; new activity after it clears it', { timeoutMs: 20_000 }, async ($, on) => {
  const store: Record<string, unknown> = {
    'mark:local_a': { kind: 'erledigt', at: NOW - 3 * 3600_000 }, // holds: no activity since
    'mark:local_b': { kind: 'pausiert', at: NOW - 3 * 86400_000 }, // stale: local_b ran on 2 days ago
    'mark:broken': { kind: 'gone', at: 'x' },
  }
  engineBeneath(on, [], store)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect(await cardOpen(ui, 'local_a')).toBe(false) // in "Erledigt", collapsed
  expect(await cardOpen(ui, 'local_b')).toBe(true) // back in "Offene Punkte"
  expect((await ui.find({ key: 'pause-local_b' }))?.key).toBe('pause-local_b')
  await ui.press({ key: 'toggle-erledigt' })
  expect((await ui.find({ key: 'resume-local_a' }))?.key).toBe('resume-local_a')
  // A session the script detected as done (local_c): neither pause nor finish
  expect(await ui.find({ key: 'pause-local_c' })).toBeUndefined()
  expect(await ui.find({ key: 'done-local_c' })).toBeUndefined()
  await ui.unmount()
})

test('the title is its own Text (bold, large) outside a Button; the task is not bold', { timeoutMs: 20_000 }, async ($, on) => {
  engineBeneath(on, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  const title = await ui.find({ type: 'Text', text: /^Release planen$/, in: 'card-local_a' })
  expect([title?.props['weight'], title?.props['size']]).toEqual(['bold', 'title'])
  const task = await ui.find({ type: 'Text', text: /^Termin für den Release festlegen$/, in: 'card-local_a' })
  expect(task?.props['weight']).toBe('regular')
  await ui.unmount()
})

test('a click anywhere on the card opens the chat', { timeoutMs: 20_000 }, async ($, on) => {
  const runs: string[][] = []
  engineBeneath(on, runs)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  const before = runs.length
  // In the middle of local_b's card (row 2), not on the title
  await ui.pointer({ type: 'down', x: 5, y: 2, button: 'left', in: 'card-local_b' })
  expect(runs.length).toBe(before) // only the release opens
  await ui.pointer({ type: 'up', x: 5, y: 2, button: 'left', in: 'card-local_b' })
  expect(runs.at(-1)).toEqual(openCall(runs, 'local_b'))
  // A right click opens nothing
  const n = runs.length
  await ui.pointer({ type: 'up', x: 1, y: 0, button: 'right', in: 'card-local_a' })
  expect(runs.length).toBe(n)
  await ui.unmount()
})

test('ui.message opens valid session IDs only', { timeoutMs: 20_000 }, async ($, on) => {
  const runs: string[][] = []
  engineBeneath(on, runs)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  const n = runs.length
  await ui.post({ open: 'local_x; calc' }, { in: 'card-local_a' })
  await ui.post({ open: 42 }, { in: 'card-local_a' })
  expect(runs.length).toBe(n)
  await ui.unmount()
})

test('slim: marked sessions are not cut from the closed buckets', () => {
  const sessions = Array.from({ length: 30 }, (_, i) => ({ id: `local_u${i}`, bucket: 'unbekannt', lastActivityAt: 100 }))
  const plain = slim({ sessions })
  expect([plain.rows.length, plain.dropped]).toEqual([25, 5])
  expect(plain.rows.some(r => r.id === 'local_u28')).toBe(false)
  const kept = slim({ sessions }, { local_u28: { kind: 'pausiert', at: 100 } })
  expect(kept.rows.some(r => r.id === 'local_u28')).toBe(true)
  expect([kept.rows.length, kept.dropped]).toEqual([26, 4])
  // A stale mark (the session ran on afterwards) does not protect it
  const stale = slim({ sessions }, { local_u28: { kind: 'pausiert', at: 50 } })
  expect(stale.rows.some(r => r.id === 'local_u28')).toBe(false)
})

test('card click: only press and release inside open', { timeoutMs: 20_000 }, async ($, on) => {
  const runs: string[][] = []
  engineBeneath(on, runs)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  await ui.resize({ columns: 60, rows: 8, in: 'card-local_b' })
  const n = runs.length
  // Press inside, release outside (dragged): nothing
  await ui.pointer({ type: 'down', x: 5, y: 2, button: 'left', in: 'card-local_b' })
  await ui.pointer({ type: 'up', x: -4, y: 2, button: 'left', in: 'card-local_b' })
  await ui.pointer({ type: 'down', x: 5, y: 2, button: 'left', in: 'card-local_b' })
  await ui.pointer({ type: 'up', x: 5, y: 9, button: 'left', in: 'card-local_b' })
  // Release without a press before it: nothing
  await ui.pointer({ type: 'up', x: 5, y: 2, button: 'left', in: 'card-local_b' })
  expect(runs.length).toBe(n)
  // A real click inside: opens
  await ui.pointer({ type: 'down', x: 59, y: 7, button: 'left', in: 'card-local_b' })
  await ui.pointer({ type: 'up', x: 59, y: 7, button: 'left', in: 'card-local_b' })
  expect(runs.at(-1)).toEqual(openCall(runs, 'local_b'))
  await ui.unmount()
})

test('the card cuts very long texts and lists', { timeoutMs: 20_000 }, async ($, on) => {
  engineBeneath(on, [], {}, [], { generatedAt: NOW, sessions: [
    { ...DATA.sessions[0], id: 'local_big', title: 'T'.repeat(5000), needsAction: '', wrapAsk: '', detail: 'd'.repeat(50_000),
      openList: Array.from({ length: 60 }, (_, i) => `Punkt ${i} ` + 'x'.repeat(2000)) },
  ] })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  const texts = (await ui.findAll({ type: 'Text', in: 'card-local_big' })).map(t => t.text)
  expect(Math.max(...texts.map(t => t.length))).toBeLessThanOrEqual(1000)
  expect(texts.filter(t => t.startsWith('Punkt ')).length).toBe(20)
  expect(texts.some(t => t.startsWith('T'.repeat(299)) && t.endsWith('…'))).toBe(true)
  await ui.unmount()
})

test('marking: if only the reload fails, the change itself still holds', { timeoutMs: 20_000 }, async ($, on) => {
  const store: Record<string, unknown> = {}
  engineBeneath(on, [], store)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  store['__failKeys'] = true // from now on store.keys fails (reload), store.set works
  await ui.press({ key: 'pause-local_a' })
  expect(store['mark:local_a']).toEqual({ kind: 'pausiert', at: NOW - 3 * 3600_000 })
  expect(await ui.find({ type: 'Box', key: 's-local_a' })).toBeUndefined() // moved to "Pausiert"
  await ui.press({ key: 'toggle-pausiert' })
  expect((await ui.find({ key: 'resume-local_a' }))?.key).toBe('resume-local_a')
  await ui.unmount()
})

const PILLS = [
  // [palette, borders of Öffnen / Pausieren / Abschließen, fills of the same]
  ['ruhig', ['#8b949e66', '#8b949e66', '#8b949e66'], [undefined, undefined, undefined]],
  ['ampel', ['#8b949e66', '#8b949e66', '#2ea043b3'], [undefined, undefined, undefined]],
  ['flaechen', ['#8b949e26', '#8b949e26', '#8b949e26'], ['#8b949e26', '#8b949e26', '#8b949e26']],
] as const
for (const [paletteId, borders, fills] of PILLS) test(`buttons as framed pills; "jetzt" does not shrink (${paletteId})`, { timeoutMs: 20_000 }, async ($, on) => {
  engineBeneath(on, [], { palette: paletteId }, [], { generatedAt: NOW, sessions: [
    { ...DATA.sessions[0], id: 'local_j', needsAction: 'Bild prüfen und freigeben', openList: ['Bild prüfen und freigeben, ' + 'sehr lang '.repeat(30)] },
  ] })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  const boxes = await ui.findAll({ type: 'Box' })
  const pill = (k: string) => boxes.find(b => b.key === `pill-${k}`)?.props
  expect([pill('open-local_j')?.['borderColor'], pill('pause-local_j')?.['borderColor'], pill('done-local_j')?.['borderColor']]).toEqual([...borders])
  // Exact fill and frame, the button inside without chrome of its own
  expect([pill('open-local_j')?.['backgroundColor'], pill('pause-local_j')?.['backgroundColor'], pill('done-local_j')?.['backgroundColor']])
    .toEqual([...fills])
  expect(pill('done-local_j')?.['borderStyle']).toBe('round')
  const btns = await ui.findAll({ type: 'Button' })
  expect(btns.find(b => b.key === 'done-local_j')?.props['plain']).toBe(true)
  // The footer stays one row: no wrapping, long names are truncated
  const footRow = boxes.find(b => b.props['justifyContent'] === 'space-between' && b.props['columnGap'] === 2 && b.props['alignItems'] === 'center')
  expect(footRow?.props['flexWrap']).toBeUndefined()
  const proj = (await ui.findAll({ type: 'Text' })).find(t => t.text === 'recipe-book')
  expect(proj?.props['wrap']).toBe('truncate-end')
  // Frame as large as the button's hover area: no padding
  expect([pill('done-local_j')?.['padding'], pill('done-local_j')?.['paddingX']]).toEqual([0, undefined])
  // "jetzt" sits in a Box that does not shrink
  const els = await ui.findAll({ in: 'card-local_j' })
  const i = els.findIndex(e => e.type === 'Text' && e.text === 'jetzt')
  expect(i).toBeGreaterThan(0)
  expect([els[i - 1]?.type, els[i - 1]?.props['flexShrink']]).toEqual(['Box', 0])
  await ui.unmount()
})

test('bucket order: "Offene Punkte" comes second', async ($, on) => {
  expect(BUCKETS.map(b => b.id)).toEqual(['warten', 'offen', 'pruefen', 'laeuft', 'unterbrochen', 'pausiert', 'unbekannt', 'erledigt'])
  engineBeneath(on, [])
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  const heads = (await ui.findAll({ type: 'Text' })).map(t => t.text).filter(t => ['Wartet auf dich', 'Offene Punkte', 'Erledigt'].includes(t))
  expect(heads).toEqual(['Wartet auf dich', 'Offene Punkte', 'Erledigt'])
  await ui.unmount()
})

// ---------- Colour schemes ----------
// More buckets than DATA: "Läuft gerade" with a current and an open step, "Zum Prüfen" with a current
// open item ("jetzt") and one that is not.
const DATA_ALL = {
  generatedAt: NOW,
  sessions: [
    ...DATA.sessions,
    {
      id: 'local_r', title: 'Build läuft', cwd: 'C:\\Work', lastActivityAt: NOW - 10 * 60_000, bucket: 'laeuft',
      needsAction: '', wrapAsk: '', detail: '', openList: [],
      openSteps: [{ content: 'Kompilieren', status: 'in_progress' }, { content: 'Nachtest', status: 'pending' }], parent: null,
    },
    {
      id: 'local_p', title: 'Bericht', cwd: 'C:\\Work', lastActivityAt: NOW - 30 * 60_000, bucket: 'pruefen',
      needsAction: 'Bericht gegenlesen', wrapAsk: '', detail: '', openList: ['Bericht gegenlesen lassen', 'Zahlen prüfen'],
      openSteps: [], parent: null,
    },
  ],
}

type Ui = { findAll: (q: object) => Promise<{ type: string; key?: string; text: string; props: Record<string, unknown> }[]> }
const cardProps = async (ui: Ui, id: string) => (await ui.findAll({ type: 'Box' })).find(b => b.key === `s-${id}`)?.props
const pillProps = async (ui: Ui, key: string) => (await ui.findAll({ type: 'Box' })).find(b => b.key === `pill-${key}`)?.props
const frameOf = async (ui: Ui, id: string) => {
  const p = await cardProps(ui, id)
  return [p?.['borderColor'], p?.['backgroundColor']]
}

async function mountWith($: Parameters<TestBody>[0], on: Parameters<TestBody>[1], store: Record<string, unknown>, data: object = DATA_ALL) {
  engineBeneath(on, [], store, [], data)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  return ui
}

for (const surface of ['desktop', 'terminal'] as const) {
  test(`the picker switches the colour scheme and stores it (${surface})`, { timeoutMs: 20_000 }, async ($, on) => {
    const store: Record<string, unknown> = {}
    engineBeneath(on, [], store)
    await $.session.start({ cwd: '/', surface, isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface })
    await ui.press({ key: 'refresh' })
    const pick = async () => (await ui.find({ type: 'Select', key: 'palette-select' }))?.props
    expect([(await pick())?.['label'], (await pick())?.['value']]).toEqual(['Farben', 'ruhig'])
    expect((await pick())?.['options']).toEqual([
      { value: 'ruhig', label: 'Ruhig' },
      { value: 'ampel', label: 'Ampel' },
      { value: 'flaechen', label: 'Flächen' },
    ])
    expect((await cardProps(ui, 'local_a'))?.['borderColor']).toBe('claude')

    await ui.select({ key: 'palette-select', value: 'ampel' })
    expect(store['palette']).toBe('ampel')
    expect((await pick())?.['value']).toBe('ampel')
    expect((await cardProps(ui, 'local_a'))?.['borderColor']).toBe('#e5603cb3')

    await ui.select({ key: 'palette-select', value: 'flaechen' })
    expect(store['palette']).toBe('flaechen')
    expect(await frameOf(ui, 'local_a')).toEqual(['#8b949e33', '#d9775724'])
    await ui.unmount()
  })
}

test('a stored colour scheme applies at start and a newer one at refresh', { timeoutMs: 20_000 }, async ($, on) => {
  const store: Record<string, unknown> = { palette: 'flaechen' }
  engineBeneath(on, [], store, [], DATA_ALL)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  // Before any refresh: the start already read the store
  expect((await ui.find({ type: 'Select', key: 'palette-select' }))?.props['value']).toBe('flaechen')
  await ui.press({ key: 'refresh' })
  expect(await frameOf(ui, 'local_a')).toEqual(['#8b949e33', '#d9775724'])
  // Picked in another session (the store is shared): the next refresh takes it over
  store['palette'] = 'ampel'
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Select', key: 'palette-select' }))?.props['value']).toBe('ampel')
  expect(await frameOf(ui, 'local_r')).toEqual(['#4189f099', undefined])
  await ui.unmount()
})

for (const stored of ['neon', 42, { id: 'ampel' }] as const) {
  test(`an unknown stored colour scheme falls back to "ruhig" (${JSON.stringify(stored)})`, { timeoutMs: 20_000 }, async ($, on) => {
    const ui = await mountWith($, on, { palette: stored })
    expect((await ui.find({ type: 'Select', key: 'palette-select' }))?.props['value']).toBe('ruhig')
    expect(await frameOf(ui, 'local_a')).toEqual(['claude', undefined])
    expect(await frameOf(ui, 'local_b')).toEqual(['#8b949e66', undefined])
    await ui.unmount()
  })
}

test('a broken store takes neither the start nor the pane down; a failed save shows a toast', { timeoutMs: 20_000 }, async ($, on) => {
  const store: Record<string, unknown> = { __failGet: true }
  const toasts: string[] = []
  engineBeneath(on, [], store, [], DATA_ALL)
  on('ui.toast', (_, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const r = await $.command.run({ command: 'sessions', args: '' } as never)
  expect(JSON.stringify(r)).toContain('Session-Monitor geöffnet')
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  expect((await ui.find({ type: 'Select', key: 'palette-select' }))?.props['value']).toBe('ruhig')
  expect(await frameOf(ui, 'local_a')).toEqual(['claude', undefined])
  // Saving fails: the pick still applies in this session, with a note
  store['__failSet'] = true
  await ui.select({ key: 'palette-select', value: 'ampel' })
  // (a throwing test hook is skipped, so the engine's own refusal is the message)
  expect(toasts.length).toBe(1)
  expect(toasts[0]).toMatch(/^Farbschema nicht gespeichert: /)
  expect(await frameOf(ui, 'local_a')).toEqual(['#e5603cb3', undefined])
  await ui.unmount()
})

test('"Ruhig": only the waiting card carries the accent, every other frame is neutral grey', { timeoutMs: 20_000 }, async ($, on) => {
  const ui = await mountWith($, on, { palette: 'ruhig' })
  await ui.press({ key: 'toggle-erledigt' })
  expect(await frameOf(ui, 'local_a')).toEqual(['claude', undefined])
  for (const id of ['local_b', 'local_p', 'local_r', 'local_c']) expect([id, ...(await frameOf(ui, id))]).toEqual([id, '#8b949e66', undefined])
  // Buttons: grey outlines without a tint
  expect([(await pillProps(ui, 'open-local_a'))?.['borderColor'], (await pillProps(ui, 'done-local_a'))?.['borderColor']]).toEqual(['#8b949e66', '#8b949e66'])
  expect((await pillProps(ui, 'done-local_a'))?.['backgroundColor']).toBeUndefined()
  await ui.unmount()
})

test('"Ampel": running is blue, review grey, only "Abschließen" outlined green', { timeoutMs: 20_000 }, async ($, on) => {
  const ui = await mountWith($, on, { palette: 'ampel' })
  expect(await frameOf(ui, 'local_r')).toEqual(['#4189f099', undefined])
  expect(await frameOf(ui, 'local_p')).toEqual(['#8b949e59', undefined])
  expect(await frameOf(ui, 'local_a')).toEqual(['#e5603cb3', undefined])
  expect(await frameOf(ui, 'local_b')).toEqual(['#b8851a99', undefined])
  expect([
    (await pillProps(ui, 'open-local_a'))?.['borderColor'],
    (await pillProps(ui, 'pause-local_a'))?.['borderColor'],
    (await pillProps(ui, 'done-local_a'))?.['borderColor'],
  ]).toEqual(['#8b949e66', '#8b949e66', '#2ea043b3'])
  // The arrow before a waiting task in the same orange-red as the frame
  const arrow = (await ui.findAll({ type: 'Text', in: 'card-local_a' })).find(t => t.text === '→')
  expect(arrow?.props['color']).toBe('#e5603c')
  await ui.unmount()
})

test('"Flächen": cards tinted in the group tone behind a fine neutral line, flat grey pills', { timeoutMs: 20_000 }, async ($, on) => {
  const ui = await mountWith($, on, { palette: 'flaechen' })
  expect(await frameOf(ui, 'local_a')).toEqual(['#8b949e33', '#d9775724'])
  expect(await frameOf(ui, 'local_b')).toEqual(['#8b949e33', '#48968c1a'])
  expect(await frameOf(ui, 'local_p')).toEqual(['#8b949e33', '#a371f71a'])
  expect(await frameOf(ui, 'local_r')).toEqual(['#8b949e33', '#4493f81a'])
  const done = await pillProps(ui, 'done-local_a')
  expect([done?.['borderColor'], done?.['backgroundColor']]).toEqual(['#8b949e26', '#8b949e26'])
  await ui.unmount()
})

// Contrast: secondary text (folder, time, "Stand", counts, open items, steps) was the theme's faint
// "subtle" grey and too weak; now "inactive", or the text colour dimmed on tinted cards. "jetzt" is
// drawn in the text colour, the accent only on the dot before the item.
for (const [id, expected] of [['ruhig', ['inactive', false]], ['ampel', ['inactive', false]], ['flaechen', ['text', true]]] as const) {
  test(`contrast: secondary text is never "subtle" (${id})`, { timeoutMs: 20_000 }, async ($, on) => {
    const ui = await mountWith($, on, { palette: id })
    const texts = await ui.findAll({ type: 'Text' })
    const inCard = async (card: string) => ui.findAll({ type: 'Text', in: `card-${card}` })
    const secondary = [
      texts.find(t => t.text.startsWith('Stand ')),
      texts.find(t => t.text === 'recipe-book'), // folder in the footer
      texts.find(t => t.props['size'] === 'footnote' && /^\d+$/.test(t.text)), // count at a bucket
      (await inCard('local_a')).find(t => t.text === 'vor 3 Std.'), // time
      (await inCard('local_p')).find(t => t.text === 'Zahlen prüfen'), // open item, not current
      (await inCard('local_r')).find(t => t.text === 'Nachtest'), // open step
      (await inCard('local_r')).find(t => t.text === 'Schritt 1 von 2'), // progress
    ]
    for (const t of secondary) {
      expect([t?.text, t?.props['color'], t?.props['dimColor']]).toEqual([t?.text, ...expected])
      expect(t?.props['color']).not.toBe('subtle')
    }
    const now = (await inCard('local_p')).find(t => t.text === 'jetzt')
    expect(now?.props['color']).toBe('text')
    await ui.unmount()
  })
}

// ---------- From review 0.3.0: race between a choice and a slow refresh, remaining bucket colours ----------
test('a slow refresh does not undo a newer colour choice', { timeoutMs: 30_000 }, async ($, on) => {
  const store: Record<string, unknown> = { palette: 'ruhig' }
  engineBeneath(on, [], store)
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
  const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
  await ui.press({ key: 'refresh' })
  // Hold the refresh's read of "palette" (it would still see "ruhig"), pick "ampel" meanwhile
  let release = () => {}
  let reached = () => {}
  const readStarted = new Promise<void>(r => { reached = r })
  store['__hold'] = { key: 'palette', promise: new Promise<void>(r => { release = r }), reached }
  const pending = ui.press({ key: 'refresh' })
  await readStarted // the refresh is now reading the old value
  await ui.select({ key: 'palette-select', value: 'ampel' })
  expect(store['palette']).toBe('ampel')
  // The stale read must not win: emulate it by restoring the old value just before releasing
  store['palette'] = 'ruhig'
  delete store['__hold']
  release()
  await pending
  expect((await ui.find({ key: 'palette-select' }))?.props['value']).toBe('ampel')
  await ui.unmount()
})

const MORE_COLOURS = [
  ['ampel', 'local_done', 'erledigt', 'borderColor', '#2ea04399'],
  ['flaechen', 'local_int', 'unterbrochen', 'backgroundColor', '#d299221a'],
  ['flaechen', 'local_done', 'erledigt', 'backgroundColor', '#2ea0431a'],
] as const
for (const [pal, id, bucket, prop, value] of MORE_COLOURS) {
  test(`bucket colour: "${pal}" ${bucket} ${prop} = ${value}`, { timeoutMs: 20_000 }, async ($, on) => {
    const data = { generatedAt: NOW, sessions: [
      { ...DATA.sessions[2], id: 'local_done' },
      { ...DATA.sessions[0], id: 'local_int', bucket: 'unterbrochen', needsAction: '' },
    ] }
    engineBeneath(on, [], { palette: pal }, [], data)
    await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })
    const ui = await $.ui.mount({ ...PANE, surface: 'desktop' })
    await ui.press({ key: 'refresh' })
    if (bucket === 'erledigt') await ui.press({ key: 'toggle-erledigt' })
    const box = (await ui.findAll({ type: 'Box' })).find(b => b.key === `s-${id}`)
    expect(box?.props[prop]).toBe(value)
    await ui.unmount()
  })
}
