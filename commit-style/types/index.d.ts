/**
 * Type contract for the commit-style mod: the style read from
 * `data/style.ts`, from which the system-prompt section is built.
 */

/** One commit type the model may use, with what it is for. */
export type CommitType = { type: string; use: string }

/** The whole style file. Text the model reads is English. */
export type Style = {
  /** Heading of the section in the system prompt. */
  heading: string
  /** The summary line's shape. */
  format: string
  types: CommitType[]
  /** Hard limit on the summary line, in characters. */
  maxSummaryLength: number
  /** Further rules, each one line, in order. `{max}` is filled with the limit. */
  rules: string[]
}
