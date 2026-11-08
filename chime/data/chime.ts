/**
 * chime tuning: which events sound, the category each one plays from, every
 * gate's numbers, quiet hours, the pack and where packs live, how sounds are
 * played, the banners, the status line and every line `/chime` answers with.
 * A typed literal (a hooks module can only import script files); the type
 * checker holds it to `Tuning`, and the tests import this same file.
 */

import type { Tuning } from '../types'

export const tuning: Tuning = {
  // Packs are installed privately under the person's own folder, never in the repo.
  packsRoot: '{home}/.claude/chime/packs',
  pack: 'rocky',
  volume: 0.5,
  enabled: true,
  categories: {
    'session.start': true,
    'task.acknowledge': false,
    'task.complete': true,
    'task.error': true,
    'input.required': true,
    'resource.limit': true,
    'user.spam': true,
  },
  suppressSubagentComplete: false,
  // PowerShell beside Bash: on Windows most shell work runs there.
  errorTools: ['Bash', 'PowerShell'],
  notificationRoutes: {
    idle_prompt: 'idle',
    elicitation_dialog: 'question',
  },
  // A prompt without a source is the person's own (the field is still rolling out).
  promptSources: ['user'],
  gates: {
    stopDebounceMs: 5_000,
    sessionStartCooldownMs: 30_000,
    silentWindowMs: 0,
    idleDedupeMs: 3_600_000,
    spamThreshold: 3,
    spamWindowMs: 10_000,
  },
  quietHours: null,
  manifest: {
    fileName: 'openpeon.json',
    cespVersions: ['1.0'],
    namePattern: String.raw`^[a-z0-9_-]{1,64}$`,
    filePattern: String.raw`^[A-Za-z0-9._-]+$`,
    soundsDir: 'sounds',
    extensions: { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg' },
    // CESP limits, checked on disk by scripts/check-pack.mjs.
    maxFileBytes: 1_048_576,
    maxPackBytes: 52_428_800,
  },
  player: {
    mode: 'auto',
    // MediaPlayer plays WAV, MP3 and OGG with a volume; the loop waits for the length to load
    // (at most 2 s), then sleeps through the clip so the process outlives it.
    argv: [
      'powershell',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      'Add-Type -AssemblyName PresentationCore; $p = New-Object System.Windows.Media.MediaPlayer; $p.Open([Uri]{file}); $p.Volume = {volume}; $p.Play(); $t = 0; while (-not $p.NaturalDuration.HasTimeSpan -and $t -lt 40) { Start-Sleep -Milliseconds 50; $t++ }; if ($p.NaturalDuration.HasTimeSpan) { Start-Sleep -Milliseconds ([int]$p.NaturalDuration.TimeSpan.TotalMilliseconds + 200) }; $p.Close()',
    ],
    quote: 'powershell',
    timeoutMs: 15_000,
  },
  routes: {
    sessionStart: { category: 'session.start', status: 'ready' },
    answer: { category: 'task.complete', status: 'done', state: 'done' },
    turnError: { category: 'task.error', status: 'stopped on an error', state: 'done' },
    subagent: { category: 'task.complete', status: 'subagent done' },
    toolError: { category: 'task.error', status: '{tool} failed' },
    permission: { category: 'input.required', status: 'needs approval for {tool}', state: 'needsYou' },
    question: { category: 'input.required', status: 'question pending', state: 'needsYou' },
    idle: { category: 'task.complete', status: 'waiting for you', state: 'needsYou' },
    compact: { category: 'resource.limit', status: 'context compacting' },
    spam: { category: 'user.spam', status: 'slow down', state: 'working' },
    acknowledge: { category: 'task.acknowledge', status: 'working', state: 'working' },
  },
  banners: {
    'session.start': { kind: 'none', text: '{project}: {status}' },
    'task.acknowledge': { kind: 'none', text: '{project}: {status}' },
    'task.complete': { kind: 'toast', text: '{project}: {status}' },
    'task.error': { kind: 'toast', text: '{project}: {status}' },
    'input.required': { kind: 'notify', text: '{project}: {status}' },
    'resource.limit': { kind: 'toast', text: '{project}: {status}' },
    'user.spam': { kind: 'none', text: '{project}: {status}' },
  },
  statusLine: {
    enabled: true,
    texts: { working: '● {project}: working', done: '● {project}: done', needsYou: '● {project}: needs you' },
  },
  command: {
    name: 'chime',
    description: 'Sounds on Claude events: on, off, status, pack, volume, quiet, test, category',
    argumentHint: '[on|off|status|pack <name>|volume <0-1>|quiet <HH:MM-HH:MM|off>|test <category>|category <name> on|off]',
  },
  text: {
    on: 'chime is on.',
    off: 'chime is off.',
    usage: 'Usage: /chime on | off | status | pack <name> | volume <0-1> | quiet <HH:MM-HH:MM|off> | test <category> | category <name> on|off',
    status: 'chime is {state}. Pack: {pack}. Volume: {volume}. Categories on: {categories}. Quiet hours: {quiet}. Last sound: {last}.',
    statusNoSound: 'none yet',
    quietNone: 'none',
    quietRange: '{from} to {to}',
    quietSet: 'Quiet hours set: {from} to {to}. Sounds stay off then; banners still show.',
    quietOff: 'Quiet hours off.',
    quietBad: 'Quiet hours are written HH:MM-HH:MM (22:00-07:00), or off.',
    pack: 'Pack set to {pack}.',
    packUnknown: 'No pack named "{pack}". Installed: {packs}.',
    packNone: 'none',
    packBroken: 'Pack "{pack}" cannot be used: {reason}',
    volume: 'Volume set to {volume}.',
    volumeBad: 'Volume must be a number from 0 to 1.',
    test: 'Playing {category}: {label}.',
    testNoSound: 'The pack has no sound for {category}.',
    categoryOn: '{category} is on.',
    categoryOff: '{category} is off.',
    categoryUnknown: 'No category "{category}". Categories: {categories}.',
    packFailed: 'chime is quiet: {reason}',
    failed: 'chime failed: {error}',
    why: {
      missing: 'pack "{pack}" has no {file} at {dir}.',
      json: '{file} in pack "{pack}" is not valid JSON.',
      version: 'pack "{pack}" is CESP {version}; chime reads {versions}.',
      name: 'pack name "{pack}" is not a valid pack name.',
      categories: 'pack "{pack}" lists no categories.',
      sound: 'pack "{pack}" has a bad sound entry in {category}: {detail}.',
    },
    onWord: 'on',
    offWord: 'off',
    none: 'none',
  },
}
