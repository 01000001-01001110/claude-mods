//! Builds the commit-style system-prompt section from the style data.

import type { Style } from '../types'

/** The section id: the plugin's own namespace, so a hook above can find it. */
export const SECTION_ID = 'commit-style:rules'

/** The section's text: heading, format, the type list, then the rules. */
export function sectionText(style: Style): string {
  const types = style.types.map(one => `- \`${one.type}\`: ${one.use}`)
  const rules = style.rules.map(rule => `- ${rule.replaceAll('{max}', String(style.maxSummaryLength))}`)
  return [
    style.heading,
    '',
    `When you write a git commit message, use the form ${style.format}.`,
    '',
    'Types:',
    ...types,
    '',
    'Rules:',
    ...rules,
  ].join('\n')
}
