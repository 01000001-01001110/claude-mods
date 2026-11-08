//! Tuning for context-meter: every threshold, lifetime, interval, color,
//! glyph and line of text the mod shows. The hooks and the tests both import
//! this file, so a re-tune here changes the mod and its tests together.
//!
//! The thresholds are heuristics, not facts: no single fill percentage is
//! known to be safe (Chroma, "Context Rot"), so tune them to taste.

import type { Tuning } from '../types'

const MINUTE = 60_000

export const tuning: Tuning = {
  bar: { cells: 20, full: '█', empty: '░', threshold: '│' },
  forecast: { samples: 5, minSamples: 2, minGrowthTokens: 500 },
  cache: {
    // The lengths Anthropic's prompt cache offers.
    ttlMs: { '5m': 5 * MINUTE, '1h': 60 * MINUTE },
    // Plan usage keeps the cache an hour; an API key or usage credits keep it five minutes.
    planTtl: '1h',
    apiTtl: '5m',
    tiers: [
      { id: 'soon', withinMs: 2 * MINUTE, color: 'error' },
      { id: 'aging', withinMs: 10 * MINUTE, color: 'warning' },
    ],
    warmColor: 'subtle',
    coldColor: 'error',
    minPromptTokens: 4_096,
    hitReadRatio: 0.5,
    minMissWriteTokens: 2_048,
    minColdTokens: 20_000,
    historyRows: 12,
  },
  stale: {
    tools: { Read: 'file_path', Edit: 'file_path', Write: 'file_path', MultiEdit: 'file_path', NotebookEdit: 'notebook_path' },
    sweepMs: 30_000,
    maxFiles: 200,
    bandFiles: 2,
  },
  verdict: {
    order: [
      { id: 'fresh', word: 'FRESH', color: 'success' },
      { id: 'aging', word: 'AGING', color: 'warning' },
      { id: 'stale', word: 'STALE', color: 'error' },
      { id: 'cold', word: 'COLD', color: 'suggestion' },
    ],
    stale: { usablePercent: 85, compactions: 3, files: 1 },
    aging: { usablePercent: 60, turnsLeft: 5, cacheLeftMs: 10 * MINUTE, compactions: 1 },
  },
  tickMs: 15_000,
  band: { rows: 2 },
  pane: { title: 'Context meter', categoryRows: 12, fileRows: 12 },
  notifyTitle: 'Context meter',
  colors: { label: 'subtle', gauge: 'claude', over: 'error', stale: 'warning', heading: 'claude' },
  glyphs: { compaction: '⟲', estimate: '~', separator: ' · ', turns: '~', cache: '◷', file: '✎' },
  units: {
    tokens: [
      { atLeast: 1_000_000, suffix: 'M', decimals: 1 },
      { atLeast: 1_000, suffix: 'k', decimals: 0 },
    ],
    seconds: '{n}s',
    minutes: '{n}m',
    hours: '{h}h{m}m',
  },
  command: {
    description: 'Context meter: on, off, status, or detail (opens the breakdown pane)',
    on: 'on',
    off: 'off',
    status: 'status',
    detail: 'detail',
  },
  text: {
    noReading: 'context: waiting for the first response',
    fill: '{percent}% · {tokens}/{window}',
    usable: 'usable {usable}%',
    turnsLeft: '{turns} turns to autocompact',
    steady: 'growth steady',
    atThreshold: 'at autocompact',
    cacheWarm: 'cache {left} ({ttl} {source})',
    cacheCold: 'cache cold {ago}: next send re-caches {tokens}',
    staleFiles: '{count} changed on disk: {files}',
    moreFiles: ' +{count}',
    ttlSources: { plan: 'plan guess', engine: 'engine', observed: 'observed' },
    reasons: {
      fresh: 'all clear',
      cold: 'cache expired {ago} ago, next send re-caches {tokens}',
      files: '{count} file(s) changed since read',
      usable: '{usable}% of the autocompact limit used',
      compactions: '{count} compaction(s) this session',
      turns: 'about {turns} turns to autocompact',
      cache: 'cache expires in {left}',
    },
    notify: '{from} → {to}: {reason}',
    usage: 'Usage: /context-meter on | off | status | detail',
    turnedOn: 'Context meter on.',
    turnedOff: 'Context meter off: the band and notifications are hidden; it keeps measuring.',
    paneOpened: 'Context meter detail opened.',
    paneNotPlaced: 'Context meter detail is open but not shown here: {reason}',
    detail: {
      verdict: 'Verdict: {word} ({reason})',
      fill: 'Fill: {fill}',
      threshold: 'Autocompact at {tokens} ({percent}% of the window), {usable}',
      noThreshold: 'Autocompact: off or not read yet',
      forecast: 'Forecast: {forecast}',
      categories: 'Categories (estimated):',
      category: '  {name}: {tokens}',
      cache: 'Cache: {state}',
      cacheCounts: '  {hits} hits, {misses} misses this session',
      cacheEvent: '  {ago} ago  {kind}  read {read}  wrote {write}',
      noCacheEvents: '  no requests yet',
      files: 'Files the model saw ({count}):',
      file: '  {path}',
      fileChanged: '  {path}  changed {ago} after it was seen',
      fileGone: '  {path}  gone from disk',
      noFiles: '  none yet',
      compactions: 'Compactions: {count}',
    },
    events: { hit: 'hit', miss: 'MISS', engineCold: 'engine: cold', engineWarm: 'engine: warm', ttl: 'lifetime now' },
  },
}
