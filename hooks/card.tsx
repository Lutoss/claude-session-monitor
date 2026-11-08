// Content of one session card as a client module, so the whole card is clickable.
// Runs on the drawing thread without `$`; a click posts { open: id } to the hooks (ui.message),
// which open the session. Client elements have no Svg, so markers are text glyphs.
import type { ClientModule } from 'claude-code'

export type CardProps = {
  id: string
  title: string
  when: string
  accent: string // theme key of the bucket
  urgent: boolean
  mark: '→' | '?' | '' // before the task: an action, a question, or nothing
  task: string
  detail: string
  list: { text: string; now: boolean }[]
  steps: { text: string; on: boolean }[]
  progress: string // "Schritt 1 von 2" or ''
}

// Cards on which the left button is currently pressed (shared across instances, by ID)
const pressed = new Set<string>()

const Card: ClientModule<CardProps> = (p, s) => {
  const { Box, Text } = s.elements
  // A left click anywhere on the card opens the session: press and release both inside.
  // The client keeps the pointer until release, also outside (then negative or >= columns/rows).
  s.onPointer(e => {
    const inside = (s.columns <= 0 || (e.x >= 0 && e.x < s.columns)) && (s.rows <= 0 || (e.y >= 0 && e.y < s.rows))
    if (e.type === 'down') {
      if (e.button === 'left' && inside) pressed.add(p.id)
      else pressed.delete(p.id)
    } else if (e.type === 'up') {
      const wasPressed = pressed.delete(p.id)
      if (e.button === 'left' && wasPressed && inside) s.post({ open: p.id })
    }
  })
  return (
    <Box flexDirection="column" gap={1}>
      <Box flexDirection="row" justifyContent="space-between" alignItems="flex-start" gap={2}>
        <Box flexShrink={1} minWidth={0}>
          <Text weight="bold" size="title" color="text" wrap="wrap">{p.title}</Text>
        </Box>
        {p.when ? (
          <Box flexShrink={0}>
            <Text color="subtle" size="caption">{p.when}</Text>
          </Box>
        ) : null}
      </Box>
      {p.task ? (
        <Box flexDirection="row" gap={1} alignItems="flex-start">
          {p.mark ? <Text color={p.urgent && p.mark === '→' ? 'claude' : p.accent} weight="bold">{p.mark}</Text> : null}
          <Text wrap="wrap" weight="regular" size="body">{p.task}</Text>
        </Box>
      ) : null}
      {p.detail ? <Text color="inactive" size="footnote" wrap="wrap">{p.detail}</Text> : null}
      {p.list.length ? (
        <Box flexDirection="column">
          {p.list.map((it, i) => (
            <Box key={`ol-${p.id}-${i}`} flexDirection="row" gap={1} justifyContent="space-between" alignItems="flex-start">
              <Box flexDirection="row" gap={1} flexShrink={1} alignItems="flex-start">
                <Text color={it.now ? 'claude' : 'subtle'}>{it.now ? '•' : '○'}</Text>
                <Text wrap="wrap" size="footnote" color={it.now ? 'text' : 'inactive'}>{it.text}</Text>
              </Box>
              {/* fixed width: otherwise "jetzt" wraps into "je/tz/t" next to long items */}
              {it.now ? (
                <Box flexShrink={0}>
                  <Text color="claude" size="caption" weight="medium">jetzt</Text>
                </Box>
              ) : null}
            </Box>
          ))}
        </Box>
      ) : null}
      {p.steps.length ? (
        <Box flexDirection="column">
          {p.steps.map((st, i) => (
            <Box key={`st-${p.id}-${i}`} flexDirection="row" gap={1} alignItems="flex-start">
              <Text color={st.on ? p.accent : 'subtle'}>{st.on ? '◐' : '○'}</Text>
              <Text wrap="wrap" size="footnote" color={st.on ? 'text' : 'inactive'}>{st.text}</Text>
            </Box>
          ))}
          {p.progress ? <Text color="subtle" size="caption">{p.progress}</Text> : null}
        </Box>
      ) : null}
    </Box>
  )
}

export default Card
