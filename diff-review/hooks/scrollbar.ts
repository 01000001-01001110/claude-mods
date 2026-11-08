//! The review's scrollbar: a surface module drawn in a `Client` beside the
//! diff. It draws the track and thumb it is handed, and posts the track row
//! under the pointer on a press and while dragging, so the hooks module can
//! move the diff. It holds no scroll position of its own: the hooks module
//! owns it and hands back the next thumb in its props.

import type { ClientModule, ClientSurface } from 'claude-code'

/** What the hooks module hands the scrollbar. */
export type ScrollbarProps = {
  rows: number
  total: number
  start: number
  size: number
  track: string
  thumb: string
  color: string
}

/** What the scrollbar posts: the track row asked for, and the sizes it was drawn with. */
export type ScrollbarPost = { row: number; rows: number; total: number }

/** Whether the left button is held, between its press and release. */
type State = { isDragging: boolean }

/**
 * The newest props per instance. The pointer listener is set once, on the
 * first draw, so it reads sizes from here rather than the props it closed over.
 */
const latest = new WeakMap<ClientSurface<State>, ScrollbarProps>()

const Scrollbar: ClientModule<ScrollbarProps, State> = (props, surface) => {
  const { Box, Text } = surface.elements
  latest.set(surface, props)
  if (surface.state === undefined) {
    surface.setState({ isDragging: false })
    surface.onPointer(event => {
      const now = latest.get(surface) ?? props
      const post = (y: number) =>
        surface.post({ row: Math.min(now.rows - 1, Math.max(0, y)), rows: now.rows, total: now.total })
      if (event.type === 'down' && event.button === 'left') {
        surface.setState({ isDragging: true })
        post(event.y)
      } else if (event.type === 'move' && surface.state?.isDragging === true) {
        post(event.y)
      } else if (event.type === 'up') {
        surface.setState({ isDragging: false })
      }
    })
  }
  const rows = []
  for (let i = 0; i < props.rows; i++) {
    const isThumb = i >= props.start && i < props.start + props.size
    rows.push(Text({ color: props.color, dimColor: !isThumb, children: isThumb ? props.thumb : props.track }))
  }
  return Box({ flexDirection: 'column', children: rows })
}

export default Scrollbar
