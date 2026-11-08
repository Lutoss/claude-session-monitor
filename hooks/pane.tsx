// Pane drawing: a calm list that leads with the next thing to do.
// - Every session is a Box; its frame, fill, the dot at the bucket header and the accent glyphs come
//   from the chosen colour scheme (ctx.palette, see ./palettes.ts). The title is bold and one step
//   larger than the task below it.
// - detail is left out when it only repeats the task; the openList item that matches the task gets
//   "jetzt" instead of another line.
// - Time at the top right next to the title; footer: the session's folder and, for sub-sessions, the
//   main session (root of the parent chain). Card content lives in ./card.tsx, the whole card opens
//   the chat; buttons at the bottom right: Öffnen / Pausieren / Abschließen.
// - The head holds "Stand …", the colour picker (Select "palette-select") and "aktualisieren".
import type { RenderElement } from 'claude-code'

import type { SessionMonitorRow } from '../types'
import type { CardProps } from './card'
import type { Pill, Tone } from './palettes'
import type { BucketDef, PaneCtx } from './types'

// Word stems of 5+ letters, to spot repetition.
function stems(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-zäöüß0-9]+/)
    .filter(w => w.length >= 5)
}

function overlaps(a: string, b: string): boolean {
  const hay = b.toLowerCase()
  if (!hay) return false
  return stems(a).some(w => hay.includes(w) || hay.includes(w.slice(0, 5)))
}

// Budgets per card: keep props (<= 100,000 chars) and the client tree (<= 20,000 nodes) small.
export const MAX_ITEMS = 20
export const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s)

// Svg without width/height: the markup size applies (the API means CSS pixels, previews count cells).
// Raw colours only inside SVG (theme keys do not apply there), hence the palette's hex dot.
const svg = (w: number, h: number, body: string) =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`

function render(ctx: PaneCtx): RenderElement {
  const { Box, Text, Button, Select, Svg, Client } = ctx.el
  const width = Math.max(30, ctx.width)
  const desktop = ctx.surface !== 'terminal'
  const pal = ctx.palette
  const toneOf = (b: BucketDef): Tone => (pal.bucket as Record<string, Tone | undefined>)[b.id] ?? pal.bucket.unbekannt

  // Icons: a text glyph instead of Svg on the terminal.
  const icon = (key: string, src: string, alt: string, fallback: string, color: string) =>
    desktop ? (
      <Box key={key} flexShrink={0} paddingTop={0}>
        <Svg source={src} alt={alt} />
      </Box>
    ) : (
      <Text color={color}>{fallback}</Text>
    )
  const dot = (b: BucketDef) =>
    icon(`dot-${b.id}`, svg(10, 10, `<circle cx="5" cy="5" r="4" fill="${toneOf(b).dot}"/>`), b.label, '●', toneOf(b).accent)
  const stand = ctx.isLoading ? 'lädt …' : ctx.generatedAt ? `Stand ${ctx.ago(ctx.generatedAt)}` : 'noch keine Daten'

  // Card footer: on the left the folder and, for sub-sessions only, the name of the main session; on
  // the right, in the same row and font size, the buttons. A Button cannot carry a colour itself (the
  // desktop draws it natively), so each sits in a framed Box ("pill") in the palette's pill colours.
  const footer = (r: SessionMonitorRow, b: BucketDef) => {
    const mark = ctx.markOf(r)
    const btn = (key: string, label: string, pill: Pill, onPress: () => void) => (
      <Box key={`pill-${key}`} padding={0} borderStyle="round" borderColor={pill.border} backgroundColor={pill.fill} flexShrink={0}>
        <Button key={key} plain onPress={onPress}>
          {label}
        </Button>
      </Box>
    )
    // Marked in the pane: offer to clear. Detected as done by the script: nothing to pause or finish.
    const extra = mark === 'pausiert'
      ? [btn(`resume-${r.id}`, 'Fortsetzen', pal.pill.resume, () => ctx.actions.mark(r, null)), btn(`done-${r.id}`, 'Abschließen', pal.pill.done, () => ctx.actions.mark(r, 'erledigt'))]
      : mark === 'erledigt'
        ? [btn(`resume-${r.id}`, 'Wieder öffnen', pal.pill.resume, () => ctx.actions.mark(r, null))]
        : b.id === 'erledigt'
          ? []
          : [btn(`pause-${r.id}`, 'Pausieren', pal.pill.pause, () => ctx.actions.mark(r, 'pausiert')), btn(`done-${r.id}`, 'Abschließen', pal.pill.done, () => ctx.actions.mark(r, 'erledigt'))]
    const root = r.ancestors[0] ?? ''
    return (
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" columnGap={2}>
        {/* One row: the left side is truncated (…), the buttons on the right keep their room */}
        <Box flexDirection="row" columnGap={2} alignItems="center" flexShrink={1} minWidth={0}>
          {r.project ? <Text color={pal.meta} dimColor={pal.metaDim} size="body" wrap="truncate-end">{clip(r.project, 200)}</Text> : null}
          {root ? <Text color={pal.meta} dimColor={pal.metaDim} size="body" wrap="truncate-end">{clip(root, 200)}</Text> : null}
        </Box>
        <Box flexDirection="row" gap={1} alignItems="center" flexShrink={0}>
          {btn(`open-${r.id}`, 'Öffnen', pal.pill.open, () => ctx.actions.open(r))}
          {extra}
        </Box>
      </Box>
    )
  }

  // Every session is its own Box in its bucket's tone (frame, optional fill). The content is a client module
  // (./card.tsx), so a click anywhere on it opens the chat: plain Boxes receive no clicks, and the
  // desktop draws Buttons natively (title size and weight would be lost). The buttons below sit
  // outside the module.
  const session = (r: SessionMonitorRow, b: BucketDef) => {
    const tone = toneOf(b)
    const task = r.needsAction || r.wrapAsk
    const nowIdx = r.needsAction ? r.openList.findIndex(i => overlaps(i, r.needsAction)) : -1
    const active = r.openSteps.findIndex(s => s.status === 'in_progress')
    const props: CardProps = {
      id: r.id,
      title: clip(r.title, 300),
      when: ctx.ago(r.lastActivityAt),
      accent: tone.accent,
      urgent: b.id === 'warten',
      mark: r.needsAction ? '→' : r.wrapAsk ? '?' : '',
      task: clip(task, 2000),
      detail: r.detail && !overlaps(r.detail, `${r.needsAction} ${r.wrapAsk}`) ? clip(r.detail, 1000) : '',
      list: r.openList.slice(0, MAX_ITEMS).map((text, i) => ({ text: clip(text, 500), now: i === nowIdx })),
      steps: r.openSteps.slice(0, MAX_ITEMS).map(s => ({ text: clip(s.content, 300), on: s.status === 'in_progress' })),
      progress: active >= 0 ? `Schritt ${active + 1} von ${r.openSteps.length}` : '',
      colors: pal.card,
    }
    return (
      <Box key={`s-${r.id}`} flexDirection="column" gap={1} paddingX={2} paddingY={1} borderStyle="round" borderColor={tone.border} backgroundColor={tone.fill}>
        <Client key={`card-${r.id}`} module="./card.tsx" props={props} />
        {footer(r, b)}
      </Box>
    )
  }

  return (
    <Box flexDirection="column" width={width} gap={2}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="center" gap={2}>
        <Box flexShrink={1} minWidth={0}>
          <Text color={pal.meta} dimColor={pal.metaDim} size="footnote" wrap="truncate-end">
            {stand}
          </Text>
        </Box>
        <Box flexDirection="row" gap={2} alignItems="center" flexShrink={0}>
          {/* Colour scheme for every session; the hooks store the pick */}
          <Select
            key="palette-select"
            label="Farben"
            options={ctx.palettes.map(p => ({ value: p.id, label: p.label }))}
            value={pal.id}
            onSelect={v => ctx.actions.setPalette(v)}
          />
          <Button key="refresh" onPress={() => ctx.actions.refresh()}>
            aktualisieren
          </Button>
        </Box>
      </Box>
      {ctx.error ? (
        <Text color="error" wrap="wrap">
          Fehler: {ctx.error}
        </Text>
      ) : null}
      {ctx.buckets.map(b => {
        const list = ctx.byBucket[b.id] ?? []
        if (!list.length && !b.open) return null
        const isOpen = ctx.isOpen(b.id)
        return (
          <Box key={`bucket-${b.id}`} flexDirection="column" gap={1}>
            <Box flexDirection="row" gap={1} alignItems="center">
              <Button key={`toggle-${b.id}`} plain onPress={() => ctx.actions.toggleBucket(b.id)}>
                <Text color="subtle">{isOpen ? '▾' : '▸'}</Text>
              </Button>
              {dot(b)}
              {/* Name outside a Button: only then do size and weight apply on the desktop */}
              <Text weight="bold" size="heading" color={isOpen || (b.id === 'warten' && list.length > 0) ? 'text' : 'inactive'}>
                {b.label}
              </Text>
              <Text color={pal.meta} dimColor={pal.metaDim} size="footnote">{String(list.length)}</Text>
            </Box>
            {isOpen && list.length ? (
              <Box flexDirection="column" gap={b.id === 'warten' ? 1 : 2}>
                {list.map(r => session(r, b))}
              </Box>
            ) : null}
          </Box>
        )
      })}
      {ctx.dropped > 0 ? (
        <Text color={pal.meta} dimColor={pal.metaDim} size="caption" wrap="wrap">
          {ctx.dropped} ältere Sessions aus „Ohne Status“/„Erledigt“ nicht gezeigt.
        </Text>
      ) : null}
    </Box>
  )
}

export const pane = { render }
