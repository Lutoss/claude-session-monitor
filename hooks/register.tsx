import { atom, read, update } from 'claude-code'
import type { Elements, EngineInterface, Register, RenderElement } from 'claude-code'

import type {
  SessionMonitorMark,
  SessionMonitorPaletteId,
  SessionMonitorRow,
  SessionMonitorSnapshot,
  SessionMonitorStatus,
} from '../types'
import { pane } from './pane'
import { DEFAULT_PALETTE, PALETTES, isPaletteId, paletteOf } from './palettes'
import type { PaneCtx } from './types'

const PANE = 'session-monitor'
const REFRESH_MS = 2 * 60 * 1000
const MAX_CLOSED = 25 // at most this many rows each for "Ohne Status" / "Erledigt"
const MAX_PER_BUCKET = 50 // open buckets: more cards would exceed the engine's tree limits

// Data source: the classification script shipped in this plugin (one logic for web view and pane).
export function scriptPath($: EngineInterface): string {
  return `${$.plugin.root.replace(/[\\/]+$/, '')}/scripts/session-monitor.mjs`
}

// Colours per bucket live in the palettes (./palettes.ts).
export const BUCKETS = [
  { id: 'warten', label: 'Wartet auf dich', open: true },
  // second, right after "Wartet auf dich"
  { id: 'offen', label: 'Offene Punkte', open: true },
  { id: 'pruefen', label: 'Zum Prüfen', open: true },
  { id: 'laeuft', label: 'Läuft gerade', open: true },
  { id: 'unterbrochen', label: 'Unterbrochen', open: true },
  // paused with a button in the pane; only in the monitor, nothing changes in the app
  { id: 'pausiert', label: 'Pausiert', open: false },
  { id: 'unbekannt', label: 'Ohne Status', open: false },
  { id: 'erledigt', label: 'Erledigt', open: false },
] as const

// snapshot-2: rows carry ancestors; an older stored value without the field is discarded.
const snapshot = atom({ plugin: 'session-monitor', key: 'snapshot' } as const, null, {
  shape: 'snapshot-2',
})
const status = atom({ plugin: 'session-monitor', key: 'status' } as const, {
  isLoading: false,
  error: null,
} as SessionMonitorStatus)
const expanded = atom({ plugin: 'session-monitor', key: 'expanded' } as const, {} as Record<string, boolean>)
const marks = atom({ plugin: 'session-monitor', key: 'marks' } as const, {} as Record<string, SessionMonitorMark>)
const palette = atom({ plugin: 'session-monitor', key: 'palette' } as const, DEFAULT_PALETTE as SessionMonitorPaletteId)

// ---------- Data ----------

type ScriptSession = {
  id: string
  title?: string
  cwd?: string
  lastActivityAt?: number | null
  bucket?: string
  needsAction?: string
  wrapAsk?: string
  detail?: string
  summary?: string
  openList?: string[]
  openSteps?: { content: string; status: string }[]
  parent?: { id: string; title: string | null } | null
  ancestors?: { id: string; title: string }[]
}

// Below a folder named "Projects" anywhere in the path: the path relative to it ("web\app");
// otherwise just the folder name, like the group in the app's sidebar ("Work" for "C:\Work").
export function shortProject(cwd: string): string {
  const path = cwd.replace(/[\\/]+$/, '') // strip trailing separators first, several too
  const rest = path.match(/(?:^|[\\/])Projects[\\/]+(.+)$/i)?.[1]
  if (rest) return rest.replace(/[\\/]+/g, '\\')
  const parts = path.split(/[\\/]+/).filter(Boolean)
  return parts.at(-1) ?? cwd
}

// From the script's --json output, only what the pane draws. Sessions with a mark that still holds
// (paused/done with a button) do not count against MAX_CLOSED, or they would vanish from "Pausiert" too.
export function slim(
  data: { generatedAt?: number; sessions?: ScriptSession[] },
  marked: Record<string, SessionMonitorMark> = {},
): SessionMonitorSnapshot {
  const counts: Record<string, number> = {}
  const rows: SessionMonitorRow[] = []
  let dropped = 0
  for (const s of data.sessions ?? []) {
    const bucket = s.bucket ?? 'unbekannt'
    const mark = marked[s.id]
    const isMarked = !!mark && (s.lastActivityAt ?? 0) <= mark.at
    if (!isMarked) counts[bucket] = (counts[bucket] ?? 0) + 1
    if (!isMarked && (bucket === 'erledigt' || bucket === 'unbekannt') && (counts[bucket] ?? 0) > MAX_CLOSED) {
      dropped++
      continue
    }
    rows.push({
      id: s.id,
      title: s.title || '(ohne Titel)',
      project: shortProject(s.cwd ?? ''),
      lastActivityAt: s.lastActivityAt ?? null,
      bucket,
      needsAction: s.needsAction ?? '',
      wrapAsk: s.wrapAsk ?? '',
      detail: s.detail || s.summary || '',
      openList: s.openList ?? [],
      openSteps: bucket === 'erledigt' ? [] : (s.openSteps ?? []),
      parentTitle: s.parent?.title ?? null,
      // Older script output without ancestors: at least the direct parent session
      ancestors: s.ancestors
        ? s.ancestors.map(a => a.title?.trim() || '(ohne Titel)')
        : s.parent?.title ? [s.parent.title] : [],
    })
  }
  return { generatedAt: data.generatedAt ?? 0, rows, dropped }
}

export function ago(ms: number | null, now: number): string {
  if (!ms) return ''
  const m = Math.round((now - ms) / 60000)
  if (m < 1) return 'gerade eben'
  if (m < 60) return `vor ${m} Min.`
  const h = Math.round(m / 60)
  if (h < 36) return `vor ${h} Std.`
  return `vor ${Math.round(h / 24)} Tagen`
}

let inFlight = false

async function refresh($: EngineInterface): Promise<void> {
  if (inFlight) return
  inFlight = true
  try {
    await update($, status, s => ({ ...s, isLoading: true }))
    const r = await $.process.run(['node', scriptPath($), '--json'], { timeoutMs: 90_000 })
    if (r.exitCode !== 0) throw new Error((r.stderr || `Exit-Code ${r.exitCode}`).slice(0, 300))
    if (r.isStdoutTruncated) throw new Error('Ausgabe des Skripts über 4 MiB, abgeschnitten (zu viele Sessions?)')
    const data = JSON.parse(r.stdout)
    // Pick up marks set in other sessions (the store is shared across sessions), before trimming
    const m = await loadMarks($).catch(() => null)
    if (m) await update($, marks, () => m)
    // Likewise the colour scheme; a store failure or a newer local choice keeps the current one
    await syncPalette($)
    await update($, snapshot, () => slim(data, m ?? {}))
    await update($, status, () => ({ isLoading: false, error: null }))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    // After a reload/unload the state is gone; then there is nothing left to report
    await update($, status, () => ({ isLoading: false, error: msg })).catch(() => undefined)
  } finally {
    inFlight = false
  }
}

// Only IDs of the app's form local_… become a deep link; applies to the button and the card click alike.
// The script checks the same pattern again before it opens anything.
export const SESSION_ID = /^local_[A-Za-z0-9-]+$/

async function openSession($: EngineInterface, id: string): Promise<void> {
  if (!SESSION_ID.test(id)) return
  try {
    const r = await $.process.run(['node', scriptPath($), '--open', id], { timeoutMs: 15_000 })
    if (r.exitCode !== 0) throw new Error((r.stderr || `Exit-Code ${r.exitCode}`).slice(0, 300))
  } catch (err) {
    await $.ui.toast(`Session ließ sich nicht öffnen: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// Pause / finish: one store key "mark:<id>" per session holding the kind and the activity time at
// marking. The store is shared across sessions. New activity in the session (a later lastActivityAt)
// clears the mark; the session then returns to its own bucket. Nothing is archived in the app itself.
const MARK_PREFIX = 'mark:'

function isMark(v: unknown): v is SessionMonitorMark {
  if (!v || typeof v !== 'object') return false
  const m = v as Record<string, unknown>
  return (m['kind'] === 'pausiert' || m['kind'] === 'erledigt') && typeof m['at'] === 'number'
}

export async function loadMarks($: EngineInterface): Promise<Record<string, SessionMonitorMark>> {
  const out: Record<string, SessionMonitorMark> = {}
  for (const k of await $.store.keys()) {
    if (!k.startsWith(MARK_PREFIX)) continue
    const v = await $.store.get(k)
    if (isMark(v)) out[k.slice(MARK_PREFIX.length)] = v
  }
  return out
}

async function setMark($: EngineInterface, r: SessionMonitorRow, kind: SessionMonitorMark['kind'] | null): Promise<void> {
  const next: SessionMonitorMark | null = kind ? { kind, at: r.lastActivityAt ?? 0 } : null
  try {
    if (next) await $.store.set(MARK_PREFIX + r.id, next)
    else await $.store.delete(MARK_PREFIX + r.id)
  } catch (err) {
    await $.ui.toast(`Markierung nicht gespeichert: ${err instanceof Error ? err.message : String(err)}`)
    return
  }
  // Saved. Reloading also picks up marks from other sessions; if that fails, show at least this
  // change instead of reporting an error that was none.
  const all = await loadMarks($).catch(() => null)
  await update($, marks, x => {
    if (all) return all
    const copy = { ...x }
    if (next) copy[r.id] = next
    else delete copy[r.id]
    return copy
  })
}

// Colour scheme: one store key "palette" for every session (the store is shared across sessions).
// An unknown or missing value gives the default.
const PALETTE_KEY = 'palette'

export async function loadPalette($: EngineInterface): Promise<SessionMonitorPaletteId> {
  const v = await $.store.get(PALETTE_KEY)
  return isPaletteId(v) ? v : DEFAULT_PALETTE
}

// Bumped on every local choice, before and after saving it. A refresh adopts the stored value only if
// no choice happened while it was reading, so a slow read cannot undo a newer pick.
let paletteVersion = 0

async function setPalette($: EngineInterface, id: string): Promise<void> {
  if (!isPaletteId(id)) return
  paletteVersion++
  // Applies at once in this session, even if saving fails
  await update($, palette, () => id)
  try {
    await $.store.set(PALETTE_KEY, id)
  } catch (err) {
    await $.ui.toast(`Farbschema nicht gespeichert: ${err instanceof Error ? err.message : String(err)}`)
  } finally {
    paletteVersion++
  }
}

// Reads the stored scheme and adopts it unless a local choice came in meanwhile.
async function syncPalette($: EngineInterface): Promise<void> {
  const before = paletteVersion
  const p = await loadPalette($).catch(() => null)
  if (p && before === paletteVersion) await update($, palette, () => p)
}

// Does a mark still hold? Only while the session has not moved on since it was marked.
export function markOf(m: Record<string, SessionMonitorMark>, r: SessionMonitorRow): SessionMonitorMark['kind'] | null {
  const mark = m[r.id]
  return mark && (r.lastActivityAt ?? 0) <= mark.at ? mark.kind : null
}

// The mod loads in every session. So that not every session runs the script every two minutes,
// refreshing starts only once the pane is needed: after /sessions, or when the app draws the pane
// on its own again. Once per session (and per load).
let updatesStarted = false

function startUpdates($: EngineInterface): void {
  if (updatesStarted) return
  updatesStarted = true
  $.clock.every(REFRESH_MS, () => void refresh($))
  void refresh($)
}

// A refused open (no surface, pane limits) is not the mod's failure: /sessions still answers.
async function openPane($: EngineInterface): Promise<boolean> {
  try {
    const r = await $.ui.open({ id: PANE, title: 'Sessions' })
    return r.isPlaced
  } catch {
    return false
  }
}

// A throwing drawing must not leave the pane blank: show an error line instead.
export function renderSafely(ctx: PaneCtx, draw: (ctx: PaneCtx) => RenderElement = pane.render): RenderElement {
  try {
    return draw(ctx)
  } catch (err) {
    const { Text } = ctx.el
    const msg = err instanceof Error ? err.message : String(err)
    return <Text color="error" wrap="wrap">{`Die Pane konnte nicht gezeichnet werden: ${msg}`}</Text>
  }
}

// ---------- Hooks ----------

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // A store failure must not take the command, timer and pane down with it
    const storedMarks = await loadMarks($).catch(() => ({}) as Record<string, SessionMonitorMark>)
    await update($, marks, () => storedMarks)
    const storedPalette = await loadPalette($).catch(() => DEFAULT_PALETTE)
    await update($, palette, () => storedPalette)
    await $.command.register({
      name: 'sessions',
      description: 'Pane mit offenen Claude-Code-Sessions öffnen und aktualisieren',
    })
    // No unrequested opening: the mod runs in every session, /sessions opens the pane.
    return next(e)
  })

  on('command.run', { command: 'sessions' }, async $ => {
    await openPane($)
    if (updatesStarted) void refresh($)
    else startUpdates($)
    return { text: 'Session-Monitor geöffnet, Daten werden neu geladen.' }
  })

  // A click on a card (client module ./card.tsx) arrives as { open: id }; only session IDs of the
  // form local_… open, everything else passes on unchanged.
  on('ui.message', async ($, e, next) => {
    const data = e.data as { open?: unknown } | null
    const id = data && typeof data === 'object' ? data.open : undefined
    if (e.requestId === PANE && typeof id === 'string' && SESSION_ID.test(id)) {
      await openSession($, id)
      return {}
    }
    return next(e)
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    // When the app draws the pane without /sessions (restored layout), start refreshing; not in
    // here (no writes during ui.render) but right after.
    if (!updatesStarted) $.clock.after(0, () => startUpdates($))
    const el = $.ui.resolve(e) as unknown as Elements['desktop']
    const snap = await read($, snapshot)
    const st = await read($, status)
    const exp = await read($, expanded)
    const mk = await read($, marks)
    const pal = paletteOf(await read($, palette))
    const now = await $.clock.now()

    const rows = snap?.rows ?? []
    const byBucket: Record<string, SessionMonitorRow[]> = {}
    for (const b of BUCKETS) byBucket[b.id] = []
    for (const r of rows) (byBucket[markOf(mk, r) ?? r.bucket] ?? byBucket['unbekannt'])?.push(r)
    // Cap the tree size (engine: at most 20,000 nodes / 100,000 characters per tree)
    let overflow = 0
    for (const id of Object.keys(byBucket)) {
      const list = byBucket[id] ?? []
      if (list.length > MAX_PER_BUCKET) {
        overflow += list.length - MAX_PER_BUCKET
        byBucket[id] = list.slice(0, MAX_PER_BUCKET)
      }
    }

    const ctx: PaneCtx = {
      el,
      surface: e.surface,
      width: Math.max(20, e.props.bodyColumns),
      now,
      generatedAt: snap?.generatedAt ?? null,
      isLoading: st.isLoading,
      error: st.error,
      buckets: BUCKETS,
      byBucket,
      isOpen: id => exp[id] ?? BUCKETS.find(b => b.id === id)?.open ?? false,
      dropped: (snap?.dropped ?? 0) + overflow,
      ago: ms => ago(ms, now),
      markOf: r => markOf(mk, r),
      palette: pal,
      palettes: PALETTES.map(p => ({ id: p.id, label: p.label })),
      actions: {
        open: r => void openSession($, r.id),
        mark: (r, kind) => void setMark($, r, kind),
        toggleBucket: id =>
          void update($, expanded, x => ({ ...x, [id]: !(x[id] ?? BUCKETS.find(b => b.id === id)?.open ?? false) })),
        refresh: () => void refresh($),
        setPalette: id => void setPalette($, id),
      },
    }

    return renderSafely(ctx)
  })
}
