//! A live clock for a running agent or turn, ticking on the surface's own frame clock so the pane need not redraw
//! each second. `since` and `now` come from the hooks module's `$.clock`; between redraws it counts its own ticks.

import type { ClientModule } from 'claude-code'

/** What the deck hands a clock. */
type ClockProps = { since: number; now: number; endAt: number | null; color: string; tickMs: number }

/** Time counted since the hooks module's last reading, in one mutable record the timer shares. */
type Tally = { fromMs: number; ticks: number; readingAt: number; ticking: boolean }

/**
 * m:ss, or XhYY past the hour: the format the deck draws where it cannot animate. A surface module has no imports
 * from the hooks module, so the format is written again here.
 */
function clockFace(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`)
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h${pad(minutes % 60)}`
  return `${minutes}:${pad(seconds % 60)}`
}

const Elapsed: ClientModule<ClockProps, { tally: Tally }> = (props, surface) => {
  const { Text } = surface.elements
  const tally = surface.state?.tally ?? { fromMs: 0, ticks: 0, readingAt: -1, ticking: true }
  // A fresh reading from the hooks module: count on from it.
  if (tally.readingAt !== props.now) {
    tally.readingAt = props.now
    tally.ticks = 0
    tally.fromMs = (props.endAt ?? props.now) - props.since
  }
  tally.ticking = props.endAt === null
  if (!surface.state) {
    surface.setState({ tally })
    surface.every(props.tickMs, () => {
      if (!tally.ticking) return
      tally.ticks += 1
      surface.setState({ tally })
    })
  }
  return <Text color={props.color}>{clockFace(tally.fromMs + props.tickMs * tally.ticks)}</Text>
}

export default Elapsed
