export type SessionMonitorStep = { content: string; status: string }

export type SessionMonitorRow = {
  id: string
  title: string
  project: string
  lastActivityAt: number | null
  bucket: string
  needsAction: string
  wrapAsk: string
  detail: string
  openList: string[]
  openSteps: SessionMonitorStep[]
  parentTitle: string | null
  ancestors: string[] // titles of the parent chain, root first, direct parent last
}

// Set with a button in the pane; holds while the session's lastActivityAt does not go past `at`.
export type SessionMonitorMark = { kind: 'pausiert' | 'erledigt'; at: number }

export type SessionMonitorSnapshot = {
  generatedAt: number
  rows: SessionMonitorRow[]
  dropped: number
}

export type SessionMonitorStatus = {
  isLoading: boolean
  error: string | null
}

declare module 'claude-code' {
  interface PluginState {
    'session-monitor': {
      snapshot: Shaped<SessionMonitorSnapshot | null>
      status: SessionMonitorStatus
      expanded: Record<string, boolean>
      marks: Record<string, SessionMonitorMark>
    }
  }
}
