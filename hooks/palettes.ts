// The pane's colour schemes. One is active for all sessions (stored under the store key "palette").
// Theme keys (claude, inactive, text …) follow the app's light/dark theme; hex values, also with alpha,
// are the same in both and were picked to read on light and dark backgrounds.
import type { SessionMonitorPaletteId } from '../types'
import type { CardColors } from './card'

export type BucketId = 'warten' | 'offen' | 'pruefen' | 'laeuft' | 'unterbrochen' | 'pausiert' | 'unbekannt' | 'erledigt'

// Per bucket: card border, card fill (optional), dot (hex, drawn in SVG), accent (glyphs → ? ◐ in the card,
// the dot on the terminal).
export type Tone = { border: string; fill?: string; dot: string; accent: string }
// Button pills: border and optional fill.
export type Pill = { border: string; fill?: string }

export type Palette = {
  id: SessionMonitorPaletteId
  label: string // shown in the picker
  bucket: Record<BucketId, Tone>
  pill: Record<'open' | 'pause' | 'done' | 'resume', Pill>
  meta: string // secondary text in the pane: folder, main session, counts, "Stand"
  metaDim: boolean // true: meta dimmed (stays readable on tinted cards)
  card: CardColors // colours inside the card (client module), passed as props
}

export const PALETTES: readonly Palette[] = [
  // Calm with one accent: neutral grey frames, only "Wartet auf dich" in Claude orange; groups only
  // by a muted dot; buttons as grey outlines without a tint.
  {
    id: 'ruhig',
    label: 'Ruhig',
    bucket: {
      warten: { border: 'claude', dot: '#d97757', accent: 'claude' },
      offen: { border: '#8b949e66', dot: '#7fa8a2', accent: 'inactive' },
      pruefen: { border: '#8b949e66', dot: '#a39bc0', accent: 'inactive' },
      laeuft: { border: '#8b949e66', dot: '#8aa4c8', accent: 'inactive' },
      unterbrochen: { border: '#8b949e66', dot: '#c4a868', accent: 'inactive' },
      pausiert: { border: '#8b949e66', dot: '#8b949e', accent: 'inactive' },
      unbekannt: { border: '#8b949e66', dot: '#8b949e', accent: 'inactive' },
      erledigt: { border: '#8b949e66', dot: '#7fae86', accent: 'inactive' },
    },
    pill: {
      open: { border: '#8b949e66' },
      pause: { border: '#8b949e66' },
      done: { border: '#8b949e66' },
      resume: { border: '#8b949e66' },
    },
    meta: 'inactive',
    metaDim: false,
    card: { title: 'text', second: 'inactive', meta: 'inactive', off: 'subtle', nowTag: 'text', dim: false, urgentArrow: 'claude', nowDot: 'claude' },
  },
  // Colour only for urgency: waiting orange-red, open items amber, running blue, done green, the rest
  // grey; frames muted by alpha; only "Abschließen" outlined in green.
  {
    id: 'ampel',
    label: 'Ampel',
    bucket: {
      warten: { border: '#e5603cb3', dot: '#e5603c', accent: '#e5603c' },
      offen: { border: '#b8851a99', dot: '#b8851a', accent: '#b8851a' },
      pruefen: { border: '#8b949e59', dot: '#8b949e', accent: 'inactive' },
      laeuft: { border: '#4189f099', dot: '#4189f0', accent: '#4189f0' },
      unterbrochen: { border: '#8b949e59', dot: '#8b949e', accent: 'inactive' },
      pausiert: { border: '#8b949e59', dot: '#8b949e', accent: 'inactive' },
      unbekannt: { border: '#8b949e59', dot: '#8b949e', accent: 'inactive' },
      erledigt: { border: '#2ea04399', dot: '#2ea043', accent: '#2ea043' },
    },
    pill: {
      open: { border: '#8b949e66' },
      pause: { border: '#8b949e66' },
      done: { border: '#2ea043b3' },
      resume: { border: '#8b949e66' },
    },
    meta: 'inactive',
    metaDim: false,
    card: { title: 'text', second: 'inactive', meta: 'inactive', off: 'subtle', nowTag: 'text', dim: false, urgentArrow: '#e5603c', nowDot: '#e5603c' },
  },
  // Tinted surfaces instead of coloured frames: a faint fill in the group's tone, a fine neutral line,
  // flat grey button pills; secondary text is the text colour dimmed (theme grey loses contrast on tints).
  {
    id: 'flaechen',
    label: 'Flächen',
    bucket: {
      warten: { border: '#8b949e33', dot: '#d97757', accent: 'claude', fill: '#d9775724' },
      offen: { border: '#8b949e33', dot: '#48968c', accent: 'planMode', fill: '#48968c1a' },
      pruefen: { border: '#8b949e33', dot: '#a371f7', accent: 'permission', fill: '#a371f71a' },
      laeuft: { border: '#8b949e33', dot: '#4493f8', accent: 'suggestion', fill: '#4493f81a' },
      unterbrochen: { border: '#8b949e33', dot: '#d29922', accent: 'warning', fill: '#d299221a' },
      pausiert: { border: '#8b949e33', dot: '#8b949e', accent: 'inactive', fill: '#8b949e14' },
      unbekannt: { border: '#8b949e33', dot: '#8b949e', accent: 'inactive', fill: '#8b949e14' },
      erledigt: { border: '#8b949e33', dot: '#2ea043', accent: 'success', fill: '#2ea0431a' },
    },
    pill: {
      open: { border: '#8b949e26', fill: '#8b949e26' },
      pause: { border: '#8b949e26', fill: '#8b949e26' },
      done: { border: '#8b949e26', fill: '#8b949e26' },
      resume: { border: '#8b949e26', fill: '#8b949e26' },
    },
    meta: 'text',
    metaDim: true,
    card: { title: 'text', second: 'text', meta: 'text', off: 'inactive', nowTag: 'text', dim: true, urgentArrow: 'claude', nowDot: 'claude' },
  },
]

export const DEFAULT_PALETTE: SessionMonitorPaletteId = 'ruhig'

export function isPaletteId(v: unknown): v is SessionMonitorPaletteId {
  return typeof v === 'string' && PALETTES.some(p => p.id === v)
}

// The palette with this id; anything unknown (an old or broken stored value) gives the default.
export function paletteOf(id: unknown): Palette {
  return PALETTES.find(p => p.id === id) ?? (PALETTES.find(p => p.id === DEFAULT_PALETTE) as Palette)
}
