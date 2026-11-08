// Contract between the hooks module (register.tsx) and the pane drawing (pane.tsx).
// The pane only draws; data, state and actions arrive ready-made through PaneCtx.
import type { Elements } from 'claude-code'

import type { SessionMonitorRow } from '../types'
import type { Palette } from './palettes'

export type BucketDef = {
  id: string // warten | offen | pruefen | laeuft | unterbrochen | pausiert | unbekannt | erledigt
  label: string
  open: boolean // expanded by default?
}

export type PaneCtx = {
  // Element table of the surface. On the terminal, Svg is drawn as a fragment.
  el: Elements['desktop']
  surface: string // 'desktop' | 'terminal' | 'vscode' | 'mobile'
  width: number // columns of the pane body (e.props.bodyColumns)
  now: number
  generatedAt: number | null // when the data was read
  isLoading: boolean
  error: string | null
  buckets: readonly BucketDef[] // in display order
  byBucket: Record<string, SessionMonitorRow[]> // every session per bucket (nothing is hidden)
  isOpen: (bucketId: string) => boolean // expanded (default from BucketDef.open, the user's toggle wins)
  dropped: number // older sessions from unbekannt/erledigt that were not passed on
  ago: (ms: number | null) => string // "vor 3 Std."
  // A mark set in the pane that still holds; the session then already sits in bucket pausiert/erledigt
  markOf: (row: SessionMonitorRow) => 'pausiert' | 'erledigt' | null
  palette: Palette // the chosen colour scheme (unknown stored values already resolved to the default)
  palettes: readonly { id: string; label: string }[] // the picker's options, in display order
  actions: {
    open: (row: SessionMonitorRow) => void // open the session in the app
    mark: (row: SessionMonitorRow, kind: 'pausiert' | 'erledigt' | null) => void // null clears the mark
    toggleBucket: (bucketId: string) => void
    refresh: () => void
    setPalette: (id: string) => void // pick a colour scheme; stored for every session
  }
}

// Keys the tests and controls rely on:
//   Button key `open-${row.id}`      opens the session  (actions.open)
//   Button key `toggle-${bucket.id}` expands a bucket   (actions.toggleBucket), for every bucket with sessions
//   Button key `refresh`             refreshes          (actions.refresh)
//   Select key `palette-select`      colour scheme      (actions.setPalette)
// Every session card shows the title as its own Text (exactly row.title), needsAction (or wrapAsk),
// openList items and openSteps. Keys are unique within a list.
