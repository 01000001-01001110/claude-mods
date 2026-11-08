/**
 * commit-style: the commit-message conventions the model is told to follow.
 *
 * A plain TypeScript literal (a hooks module can only import script files);
 * the type checker holds it to `Style`, and the tests import this same file.
 * The text is read by the model only, so it stays in English.
 */

import type { Style } from '../types'

export const style: Style = {
  heading: '# Commit messages',
  format: '`type(scope): summary`, scope optional (Conventional Commits)',
  types: [
    { type: 'feat', use: 'a new feature' },
    { type: 'fix', use: 'a bug fix' },
    { type: 'refactor', use: 'a code change that neither fixes a bug nor adds a feature' },
    { type: 'perf', use: 'a performance improvement' },
    { type: 'test', use: 'adding or fixing tests' },
    { type: 'docs', use: 'documentation only' },
    { type: 'style', use: 'formatting only, no change in behavior' },
    { type: 'chore', use: 'maintenance that touches no source or tests' },
    { type: 'build', use: 'the build system or dependencies' },
    { type: 'ci', use: 'CI configuration and scripts' },
    { type: 'revert', use: 'reverting an earlier commit' },
  ],
  maxSummaryLength: 72,
  rules: [
    'Write the summary in the imperative mood ("add", not "added" or "adds"), lowercase after the colon, with no trailing period, at most {max} characters including the type and scope.',
    'Use a scope only when it names a real area of the repository (a package, module or directory), in lowercase.',
    'One commit per logical change; split unrelated changes into separate commits.',
    'Add a body only when the reason for the change does not fit in the summary; leave a blank line after the summary and wrap the body at 72 columns.',
    'Mark a breaking change with `!` after the type or scope and a `BREAKING CHANGE:` footer that says what breaks.',
    'Write in the language the repository\'s existing commit history uses.',
    'If the repository\'s history follows a different convention, follow the history instead.',
    'Do not add AI attribution: no `Co-Authored-By` lines for an AI, no "Generated with" lines, no emoji signatures.',
  ],
}
