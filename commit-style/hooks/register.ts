//! commit-style: tells the model how to write commit messages.
//!
//! Adds one section to the end of the system prompt, on the session side of
//! the cache boundary, and changes nothing else. It checks nothing at commit
//! time; it shapes what the model writes. The conventions live in
//! `data/style.ts`. Because the system prompt is fixed once a thread starts,
//! a change to the style reaches the next session (or the next compaction),
//! not the current thread.

import type { Register } from 'claude-code'

import { style } from '../data/style'
import { SECTION_ID, sectionText } from './section'

export const register: Register = on => {
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)
    // Replace rather than duplicate if the section is somehow already there.
    const others = composed.sections.filter(section => section.id !== SECTION_ID)
    return { sections: [...others, { id: SECTION_ID, text: sectionText(style), scope: 'session' as const }] }
  })
}
