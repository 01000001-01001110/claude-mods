//! Model prices for burn's cost estimates, in US dollars per million tokens.
//!
//! Checked against https://platform.claude.com/docs/en/about-claude/pricing
//! (docs.claude.com/en/docs/about-claude/pricing redirects there) on
//! 2026-11-07. Every number below was read off that page's "Model pricing",
//! "Prompt caching", "Fast mode pricing", "Long context pricing" and "Data
//! residency pricing" sections. These are list prices: a subscription plan
//! is not billed this way, so burn shows them as an estimate of what the
//! same tokens would cost on the API.
//!
//! Patterns are matched against the model id the API reports (for example
//! `claude-opus-5-5` or `claude-sonnet-4-5-20250929`); the first match wins,
//! so the more specific entries come first and the bare family names last
//! catch ids this table does not know yet.

import type { Prices, Rates } from '../types'

/** Builds a rate row from the page's five columns. */
function row(input: number, cacheWrite5m: number, cacheWrite1h: number, cacheRead: number, output: number): Rates {
  return { input, output, cacheWrite5m, cacheWrite1h, cacheRead }
}

export const prices: Prices = {
  source: { url: 'https://platform.claude.com/docs/en/about-claude/pricing', checked: '2026-11-07' },
  models: [
    // Fable 5.1 and Mythos 5.1: cache hits at 0.025x input.
    { id: 'fable-5-1', pattern: String.raw`(?:fable|mythos)-5-1`, rates: row(10, 12.5, 20, 0.25, 50) },
    { id: 'fable-5', pattern: String.raw`(?:fable|mythos)-5`, rates: row(10, 12.5, 20, 1, 50) },
    // Opus 5.5: cache hits at 0.05x input; fast mode $8 / $40.
    { id: 'opus-5-5', pattern: String.raw`opus-5-5`, rates: row(4, 5, 8, 0.2, 20), fast: { input: 8, output: 40 } },
    // Opus 5 and 4.8 share fast mode at $10 / $50 (research preview).
    { id: 'opus-5', pattern: String.raw`opus-5`, rates: row(5, 6.25, 10, 0.5, 25), fast: { input: 10, output: 50 } },
    { id: 'opus-4-8', pattern: String.raw`opus-4-8`, rates: row(5, 6.25, 10, 0.5, 25), fast: { input: 10, output: 50 } },
    { id: 'opus-4-5', pattern: String.raw`opus-4-[5-7](?!\d)`, rates: row(5, 6.25, 10, 0.5, 25) },
    // Opus 4 and 4.1 (retired on the first-party API), including dated ids like opus-4-20250514.
    { id: 'opus-4', pattern: String.raw`opus-4`, rates: row(15, 18.75, 30, 1.5, 75) },
    // Sonnet 5.5: cache hits at 0.05x input.
    { id: 'sonnet-5-5', pattern: String.raw`sonnet-5-5`, rates: row(2, 2.5, 4, 0.1, 10) },
    // Sonnet 5: the $2 / $10 launch price is now the standard price.
    { id: 'sonnet-5', pattern: String.raw`sonnet-5`, rates: row(2, 2.5, 4, 0.2, 10) },
    // Sonnet 4, 4.5 and 4.6 share one price.
    { id: 'sonnet-4', pattern: String.raw`sonnet-4`, rates: row(3, 3.75, 6, 0.3, 15) },
    // Haiku 5.5 is priced by prompt length: over 100,000 tokens (input + cache read + cache write) pays more.
    {
      id: 'haiku-5-5',
      pattern: String.raw`haiku-5-5`,
      rates: row(0.1, 0.125, 0.2, 0.01, 0.5),
      longPrompt: { overTokens: 100_000, rates: row(0.5, 0.625, 1, 0.05, 2.5) },
    },
    { id: 'haiku-4-5', pattern: String.raw`haiku-4-5`, rates: row(1, 1.25, 2, 0.1, 5) },
    // Fallbacks for ids not listed above, by family name: the current mid-tier price of each family.
    { id: 'fable', pattern: String.raw`fable|mythos`, rates: row(10, 12.5, 20, 1, 50) },
    { id: 'opus', pattern: String.raw`opus`, rates: row(5, 6.25, 10, 0.5, 25) },
    { id: 'sonnet', pattern: String.raw`sonnet`, rates: row(3, 3.75, 6, 0.3, 15) },
    { id: 'haiku', pattern: String.raw`haiku`, rates: row(1, 1.25, 2, 0.1, 5) },
  ],
  free: ['<synthetic>'],
  // US-only inference (`inference_geo: "us"`) costs 1.1x on Claude 4.6 and later; global is the default.
  geo: { us: 1.1 },
  decimals: 6,
}
