//! Pure rules for rubber-duck: parsing the persona JSONL (with its optional
//! sound pack and voice), settling the person's picks, building the duck's
//! system prompt and the conversation it is sent, the project-context block,
//! and the gauge. The sound rules are in clips.ts.

import type { Persona, Settings, Tuning, Turn } from '../types'

/** A main-session message as `$.session.messages()` gives it, reduced to what the duck reads. */
export type SessionLine = { role: 'user' | 'assistant'; text: string }

/** Fills `{key}` placeholders in a template. */
export function fill(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (whole, key: string) => (key in values ? String(values[key]) : whole))
}

/** Personas parsed from JSONL, and a line-numbered problem for each line that is not one. */
export type ParsedPersonas = { personas: Persona[]; problems: string[] }

/**
 * Parses `data/personas.jsonl`: one `{ value, label, system }` object per
 * line; blank lines are skipped. A bad line is reported, not fatal, so one
 * typo does not take every persona down.
 */
export function parsePersonas(text: string): ParsedPersonas {
  const personas: Persona[] = []
  const problems: string[] = []
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim() === '') return
    try {
      const value = JSON.parse(line) as Partial<Persona>
      const extra = optionalProblem(value)
      if (typeof value.value !== 'string' || typeof value.label !== 'string' || typeof value.system !== 'string') {
        problems.push(`line ${index + 1}: needs string value, label and system`)
      } else if (extra !== null) {
        problems.push(`line ${index + 1}: ${extra}`)
      } else if (personas.some(one => one.value === value.value)) {
        problems.push(`line ${index + 1}: duplicate value "${value.value}"`)
      } else {
        personas.push({
          value: value.value,
          label: value.label,
          system: value.system,
          ...(value.pack === undefined ? {} : { pack: value.pack }),
          ...(value.voice === undefined ? {} : { voice: value.voice }),
        })
      }
    } catch (error) {
      problems.push(`line ${index + 1}: ${String(error)}`)
    }
  })
  return { personas, problems }
}

/** A pack name: one folder name, so it can never climb out of the packs folder. */
const PACK_NAME = /^[A-Za-z0-9_-]+$/
/** An SSML prosody pitch: a relative percent or semitone change, or a named level. Keeps the value from breaking the SSML it is written into. */
const PITCH = /^$|^[+-]\d{1,3}(\.\d+)?(%|st|Hz)$|^(x-low|low|medium|high|x-high|default)$/

/**
 * What is wrong with a persona line's optional fields, or null: `pack` must
 * be a folder name, `voice` an object of a string name, an integer rate in
 * -10..10, an integer volume in 0..100 and an SSML pitch.
 */
export function optionalProblem(value: Partial<Persona>): string | null {
  if (value.pack !== undefined && (typeof value.pack !== 'string' || !PACK_NAME.test(value.pack))) return 'pack must be a folder name (letters, digits, _ or -)'
  const voice = value.voice as unknown
  if (voice === undefined) return null
  if (typeof voice !== 'object' || voice === null || Array.isArray(voice)) return 'voice must be an object'
  const v = voice as Record<string, unknown>
  if (v.name !== undefined && typeof v.name !== 'string') return 'voice.name must be a string'
  if (v.rate !== undefined && !(Number.isInteger(v.rate) && (v.rate as number) >= -10 && (v.rate as number) <= 10)) return 'voice.rate must be an integer from -10 to 10'
  if (v.volume !== undefined && !(Number.isInteger(v.volume) && (v.volume as number) >= 0 && (v.volume as number) <= 100)) return 'voice.volume must be an integer from 0 to 100'
  if (v.pitch !== undefined && !(typeof v.pitch === 'string' && PITCH.test(v.pitch))) return 'voice.pitch must be an SSML pitch such as -20%, +2st or low'
  return null
}

/** The persona for a value, or the first one; null when none are loaded. */
export function personaOf(value: string, personas: readonly Persona[]): Persona | null {
  return personas.find(one => one.value === value) ?? personas[0] ?? null
}

/** Settings with anything unknown (an old store, a removed model or persona) put back to the defaults. */
export function settingsOf(stored: unknown, personas: readonly Persona[], t: Tuning): Settings {
  const s = (stored ?? {}) as Partial<Settings>
  const pick = (value: unknown, choices: readonly { value: string }[], fallback: string) =>
    typeof value === 'string' && choices.some(one => one.value === value) ? value : fallback
  return {
    model: pick(s.model, t.models, t.defaults.model),
    effort: pick(s.effort, t.efforts, t.defaults.effort),
    persona: pick(s.persona, personas, t.defaults.persona),
    withContext: typeof s.withContext === 'boolean' ? s.withContext : t.defaults.withContext,
    // Settings stored before the sound switches existed have neither field: they take the defaults.
    audio: typeof s.audio === 'boolean' ? s.audio : t.defaults.audio,
    voice: typeof s.voice === 'boolean' ? s.voice : t.defaults.voice,
  }
}

/** The newest main-session messages, cut to size, as a context block; null when there are none. */
export function contextBlock(lines: readonly SessionLine[], cwd: string, t: Tuning): string | null {
  const recent = lines.filter(line => line.text.trim() !== '').slice(-t.context.recentMessages)
  if (recent.length === 0) return null
  const body = recent.map(line => {
    const text =
      line.text.length > t.context.maxCharsPerMessage
        ? `${line.text.slice(0, t.context.maxCharsPerMessage)} [cut]`
        : line.text
    return `<${line.role}>\n${text}\n</${line.role}>`
  })
  return [fill(t.context.preamble, { cwd }), '<main_session>', ...body, '</main_session>'].join('\n')
}

/**
 * The duck's system prompt: its persona's, then the clip menu when given,
 * then the project context when given; blank parts are left out.
 */
export function systemPrompt(persona: Persona | null, context: string | null, clips: string | null = null): string {
  return [persona?.system ?? '', clips ?? '', context ?? ''].filter(part => part !== '').join('\n\n')
}

/**
 * The one user message sent: the recent duck conversation as a transcript,
 * then the new message. `$.model.complete` takes no history, so it rides here.
 */
export function chatPrompt(history: readonly Turn[], message: string, t: Tuning): string {
  const earlier = history.filter(turn => turn.role !== 'error').slice(-t.chat.historyTurns)
  if (earlier.length === 0) return message
  const lines = earlier.map(turn => `${turn.role === 'you' ? 'Engineer' : 'You'}: ${turn.text}`)
  return ['Our conversation so far:', '<conversation>', ...lines, '</conversation>', '', 'The engineer now says:', message].join('\n')
}

/** A gauge of `used` out of `total`, with its percent and a short count ("45% (32k / 200k)"). */
export function gauge(used: number, total: number, t: Tuning): string {
  const ratio = total <= 0 ? 0 : Math.min(1, Math.max(0, used / total))
  const filled = Math.round(ratio * t.gauge.cells)
  const cells = `${t.gauge.full.repeat(filled)}${t.gauge.empty.repeat(t.gauge.cells - filled)}`
  return `${t.gauge.open}${cells}${t.gauge.close} ${Math.round(ratio * 100)}% (${kilo(used)} / ${kilo(total)})`
}

/** A token count shortened for display: 32000 -> "32k", 840 -> "840". */
export function kilo(n: number): string {
  return n >= 1000 ? `${Math.round(n / 1000)}k` : String(n)
}

/** Seconds, one decimal, for "1.2s" displays. */
export function seconds(ms: number): string {
  return (Math.max(0, ms) / 1000).toFixed(1)
}
