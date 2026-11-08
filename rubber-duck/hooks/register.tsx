//! rubber-duck: a side-panel chat with a model of your choice.
//!
//! `/duck` opens a pane (docked beside the transcript in fullscreen). Every
//! control is a clickable chip: the model, the effort, the persona and the
//! project-context checkbox. The pane exactly fills its body: the header and
//! settings at the top, the input and footer pinned at the bottom, and the
//! chat window between them, which this module scrolls itself (the wheel,
//! and a scrollbar to click or drag). Each message is one `$.model.complete`
//! call with the recent duck conversation folded into the prompt; the main
//! session's own thread is never touched. Models, defaults, limits, layout
//! and the whole look live in `data/duck.ts`; personas in
//! `data/personas.jsonl`.
//!
//! Sound: a persona with a `pack` (Rocky) may play the pack's clips. With
//! the audio switch on, the pack's clip menu rides in the system prompt, the
//! reply's first-line tag names a clip, the tag is taken off, and the clip
//! plays when the chance, no-repeat and cooldown rules allow. With the voice
//! switch on, the shown reply is read aloud by a system voice; switching it
//! off stops the reading. Both switches are chips and `/duck audio|voice
//! on|off`, and are remembered with the other picks.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, ModelEffort, Register } from 'claude-code'

import { tuning as t } from '../data/duck'
import type { Line, Persona, Settings, Turn } from '../types'
import { chatPrompt, contextBlock, fill, gauge, kilo, parsePersonas, personaOf, settingsOf, systemPrompt } from './chat'
import type { ParsedPersonas, SessionLine } from './chat'
import { clipLogOf, clipMenu, clipVerdict, logPlayed, packRoot, parseManifest, parseReply, parseVerb, roll, speakable, voiceOf } from './clips'
import type { PackLoad } from './clips'
import type { ScrollbarPost, ScrollbarProps } from './scrollbar'
import { playSound } from './sound'
import { backFromTrack, chatLines, chatWindow, chipRows, chipText, groupTexts, paneLayout, scrolled, thumb } from './view'
import { speak, stopSpeaking } from './voice'

/** Store key for the person's picks. A protocol name, not a tunable. */
const STORE_SETTINGS = 'settings'
/** Store key for the running chat count. A protocol name, not a tunable. */
const STORE_CHATS = 'chats'
/** The scrollbar Client's key. An address, not a tunable. */
const SCROLLBAR = 'scrollbar'

// Bump a shape tag when that value's fields change, so a reload declines the old value.
const chatAtom = atom({ plugin: 'rubber-duck', key: 'chat' } as const, [], { shape: 'chat-1' })
// settings-2: the audio and voice switches joined; a settings-1 value is declined and the store's (filled by settingsOf) used.
const settingsAtom = atom({ plugin: 'rubber-duck', key: 'settings' } as const, null, { shape: 'settings-2' })
const clipLogAtom = atom({ plugin: 'rubber-duck', key: 'clipLog' } as const, { recent: [], lastAt: 0 }, { shape: 'cliplog-1' })
const askedAtAtom = atom({ plugin: 'rubber-duck', key: 'askedAt' } as const, 0)
const nowAtom = atom({ plugin: 'rubber-duck', key: 'now' } as const, 0)
const usageAtom = atom({ plugin: 'rubber-duck', key: 'usage' } as const, null)
const sentAtom = atom({ plugin: 'rubber-duck', key: 'sent' } as const, 0)
const chatNumberAtom = atom({ plugin: 'rubber-duck', key: 'chatNumber' } as const, 0)
const scrollBackAtom = atom({ plugin: 'rubber-duck', key: 'scrollBack' } as const, 0)

// Module variables reset on every reload, so persona edits apply on the next reload.
let personasLoad: Promise<ParsedPersonas> | undefined
/** Each sound pack's manifest, read once per load of the module (a pack fixed on disk is picked up on reload). */
const packLoads = new Map<string, Promise<PackLoad>>()
/**
 * How far back the chat could scroll when last drawn. The wheel's hook
 * clamps with it; it is a measurement of the last drawing, so a module
 * variable (lost on reload, redrawn at once) is the right home.
 */
let lastMaxBack = 0

/** Reads and caches data/personas.jsonl; a missing or unreadable file is reported, not thrown. */
function personas($: EngineInterface): Promise<ParsedPersonas> {
  personasLoad ??= $.fs
    .read(`${$.plugin.root}/data/personas.jsonl`)
    .then(text => parsePersonas(String(text)))
    .catch(error => ({ personas: [], problems: [`data/personas.jsonl: ${String(error)}`] }))
  return personasLoad
}

/** The user's home folder, as the OS gives it (Windows sets USERPROFILE, others HOME). */
async function home($: EngineInterface): Promise<string> {
  return (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? ''
}

/**
 * Reads a sound pack's manifest into clips, once. A missing or broken
 * manifest is a problem the pane shows, never a throw: chat goes on without
 * audio.
 */
function pack($: EngineInterface, name: string): Promise<PackLoad> {
  let load = packLoads.get(name)
  if (load === undefined) {
    load = readPack($, name)
    packLoads.set(name, load)
  }
  return load
}

/** The read behind `pack`. */
async function readPack($: EngineInterface, name: string): Promise<PackLoad> {
  const root = packRoot(await home($), name, t)
  try {
    return parseManifest(String(await $.fs.read(`${root}/${t.packs.manifest}`)), root)
  } catch (error) {
    return { clips: [], problem: `${t.packs.manifest}: ${String(error)}` }
  }
}

/** The persona's pack, or null when it has none. */
async function packOf($: EngineInterface, persona: Persona | null): Promise<PackLoad | null> {
  return persona?.pack === undefined ? null : pack($, persona.pack)
}

/** Flips or sets one sound switch; turning the voice off stops any reading at once. */
async function setSwitch($: EngineInterface, which: 'audio' | 'voice', value: boolean | 'flip'): Promise<boolean> {
  const now = value === 'flip' ? !(await settings($))[which] : value
  await choose($, which === 'audio' ? { audio: now } : { voice: now })
  if (which === 'voice' && !now) stopSpeaking()
  return now
}

/**
 * Plays the clip a reply named, when the rules allow, and returns its label
 * for the reply's meta line (null when nothing played).
 */
async function react($: EngineInterface, clipId: string | null, load: PackLoad): Promise<string | null> {
  const now = await $.clock.now()
  const log = clipLogOf(await read($, clipLogAtom))
  if (clipVerdict(clipId, now, log, () => roll(now), t.clips) !== 'play') return null
  const clip = load.clips.find(one => one.id === clipId)
  if (clip === undefined) return null
  await update($, clipLogAtom, () => logPlayed(log, clip.id, now, t.clips.noRepeat))
  playSound($, t.clips.sound, clip.file, await $.session.cwd())
  return clip.label
}

/** The person's picks: this session's, else the stored ones, else the defaults. */
async function settings($: EngineInterface): Promise<Settings> {
  const { personas: list } = await personas($)
  const held = await read($, settingsAtom)
  return settingsOf(held ?? (await $.store.get(STORE_SETTINGS)), list, t)
}

/** Changes one pick and remembers it across sessions. */
async function choose($: EngineInterface, change: Partial<Settings>): Promise<void> {
  const next: Settings = { ...(await settings($)), ...change }
  await update($, settingsAtom, () => next)
  await $.store.set(STORE_SETTINGS, next)
}

/** Takes the next chat number from the store, so numbers keep counting across sessions. */
async function nextChatNumber($: EngineInterface): Promise<number> {
  const stored = await $.store.get(STORE_CHATS)
  const n = (typeof stored === 'number' ? stored : 0) + 1
  await $.store.set(STORE_CHATS, n)
  await update($, chatNumberAtom, () => n)
  return n
}

/** Empties the chat and starts a new numbered one. */
async function clearChat($: EngineInterface): Promise<void> {
  await update($, chatAtom, () => [])
  await update($, usageAtom, () => null)
  await update($, scrollBackAtom, () => 0)
  await nextChatNumber($)
}

/** The main session's newest messages, for the context block. */
async function sessionLines($: EngineInterface): Promise<SessionLine[]> {
  const messages = await $.session.messages()
  return messages.map(message => ({ role: message.role, text: message.text }))
}

/** Appends one turn and follows the newest line. */
async function say($: EngineInterface, turn: Turn): Promise<void> {
  await update($, chatAtom, chat => [...chat, turn])
  await update($, scrollBackAtom, () => 0)
}

/** Moves the waiting line's clock. */
async function tick($: EngineInterface): Promise<void> {
  const now = await $.clock.now()
  await update($, nowAtom, () => now)
}

/** Sends one message to the duck and appends its reply (or the reason it gave none). */
async function send($: EngineInterface, raw: string): Promise<void> {
  const message = raw.trim()
  if (message === '' || (await read($, askedAtAtom)) !== 0) return
  const picks = await settings($)
  const { personas: list } = await personas($)
  const history = await read($, chatAtom)
  await say($, { role: 'you', text: message })
  await update($, sentAtom, n => n + 1)
  const askedAt = await $.clock.now()
  await update($, nowAtom, () => askedAt)
  await update($, askedAtAtom, () => askedAt)
  const clock = $.clock.every(t.waitingTickMs, () => void tick($))

  try {
    const persona = personaOf(picks.persona, list)
    const context = picks.withContext ? contextBlock(await sessionLines($), await $.session.cwd(), t) : null
    // Audio off sends no clip menu (no tokens spent on it) and parses no tag.
    const load = picks.audio ? await packOf($, persona) : null
    const menu = load === null ? null : clipMenu(load.clips, t)
    const system = systemPrompt(persona, context, menu)
    const result = await $.model.complete({
      model: picks.model,
      // No persona and no context: send no system prompt rather than an empty one.
      ...(system === '' ? {} : { system }),
      prompt: chatPrompt(history, message, t),
      effort: picks.effort as ModelEffort,
      maxTokens: t.chat.maxTokens,
      timeoutMs: t.chat.timeoutMs,
    })
    const ms = (await $.clock.now()) - askedAt
    if (result.isAnswered) {
      const reply = menu !== null && load !== null ? parseReply(result.text, load.clips.map(clip => clip.id), t.clips.tag) : { text: result.text, clip: null }
      const label = load !== null && menu !== null ? await react($, reply.clip, load) : null
      await say($, { role: 'duck', text: reply.text, model: picks.model, ms, ...(label === null ? {} : { clip: label }) })
      // Read from the settings as they are now: the voice may have been switched while the reply was pending.
      if ((await settings($)).voice) speak($, speakable(reply.text, t), voiceOf(persona, t), t, await $.session.cwd())
    } else {
      await say($, { role: 'error', text: `No reply (${result.reason}).` })
    }
    await update($, usageAtom, () => ({ input: result.usage.input_tokens, output: result.usage.output_tokens }))
  } catch (error) {
    await say($, { role: 'error', text: `The request was refused: ${String(error)}` })
  } finally {
    clock.cancel()
    await update($, askedAtAtom, () => 0)
  }
}

/** Sets the scroll-back, clamped to what the last drawing could show. */
async function scrollTo($: EngineInterface, back: number): Promise<void> {
  await update($, scrollBackAtom, () => Math.min(lastMaxBack, Math.max(0, back)))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: t.command.name, description: t.command.description, argumentHint: t.command.argumentHint })
    const stored = await $.store.get(STORE_CHATS)
    await update($, chatNumberAtom, () => (typeof stored === 'number' && stored > 0 ? stored : 0))
    return next(e)
  })

  on('command.run', { command: 'duck' }, async ($, e) => {
    const verb = parseVerb(e.args, t.command.verbs)
    const R = t.command.replies
    if (verb.kind === 'usage') return { text: R.usage }
    if (verb.kind === 'switch') {
      const isOn = await setSwitch($, verb.which, verb.value)
      if (verb.which === 'voice') return { text: isOn ? R.voiceOn : R.voiceOff }
      const { personas: list } = await personas($)
      const hasPack = personaOf((await settings($)).persona, list)?.pack !== undefined
      return { text: isOn ? `${R.audioOn}${hasPack ? '' : R.noPack}` : R.audioOff }
    }
    if (verb.kind === 'new' || (await read($, chatNumberAtom)) === 0) await clearChat($)
    // The person asked, so the pane is placed at any width.
    await $.ui.open({ id: t.pane.id, title: t.pane.title })
    return { text: fill(R.opened, { title: t.pane.title }) }
  })

  // The pane is drawn to fit its body exactly, so the engine never scrolls it:
  // the wheel moves the chat window instead.
  on('ui.scroll', { component: 'Pane', requestId: 'rubber-duck' }, async ($, e) => {
    const back = await read($, scrollBackAtom)
    await scrollTo($, scrolled(back, e.by, lastMaxBack, t))
    return {}
  })

  // A press or drag on the scrollbar.
  on('ui.message', { element: 'scrollbar' }, async ($, e) => {
    const post = e.data as Partial<ScrollbarPost> | null
    if (typeof post?.row === 'number' && typeof post.rows === 'number' && typeof post.total === 'number') {
      await scrollTo($, backFromTrack(post.row, post.rows, post.total))
    }
    return {}
  })

  on('ui.render', { component: 'Pane', requestId: 'rubber-duck' }, async ($, e) => {
    const { Box, Button, Input, Text } = $.ui.resolve(e)
    const { personas: list, problems } = await personas($)
    const picks = await settings($)
    const chat = await read($, chatAtom)
    const askedAt = await read($, askedAtAtom)
    const now = await read($, nowAtom)
    const usage = await read($, usageAtom)
    const sent = await read($, sentAtom)
    const chatNumber = await read($, chatNumberAtom)
    const back = await read($, scrollBackAtom)
    const L = t.labels
    const C = t.colors
    const isBusy = askedAt !== 0
    const status = isBusy ? L.thinking : L.idle
    const persona = personaOf(picks.persona, list)
    const modelLabel = t.models.find(one => one.value === picks.model)?.label ?? picks.model

    // Settings groups, heading first, exactly as drawn, so the layout counts their rows.
    const personaChoices = list.map(({ value, label }) => ({ value, label }))
    const contextGroup = [L.contextHeading, `${picks.withContext ? L.checkOn : L.checkOff} ${L.context}`, gauge(usage?.input ?? 0, t.chat.windowTokens, t)]
    // The sound row: the audio switch only for a persona with a pack (or why its pack cannot play), the voice switch always.
    const load = await packOf($, persona)
    const sound: { key: 'heading' | 'audio' | 'unavailable' | 'voice'; text: string }[] = [{ key: 'heading', text: L.soundHeading }]
    if (load !== null && load.clips.length === 0) sound.push({ key: 'unavailable', text: fill(L.audioUnavailable, { reason: load.problem ?? '' }) })
    else if (load !== null) sound.push({ key: 'audio', text: `${picks.audio ? L.checkOn : L.checkOff} ${L.audio}` })
    sound.push({ key: 'voice', text: `${picks.voice ? L.checkOn : L.checkOff} ${L.voice}` })
    const soundGroup = sound.map(item => item.text)
    const groups = [
      groupTexts(L.modelHeading, t.models, picks.model, t),
      groupTexts(L.effortHeading, t.efforts, picks.effort, t),
      groupTexts(L.personaHeading, personaChoices, picks.persona, t),
      contextGroup,
      soundGroup,
    ]
    const size = paneLayout(e.props.bodyColumns, e.props.scroll.bodyRows, groups, problems.length, t)

    const lines = chatLines(chat, size.chatWidth, { waiting: isBusy ? { persona: persona?.label ?? '', model: modelLabel, ms: now - askedAt } : null }, t)
    const view = chatWindow(lines, size.chatRows, back)
    lastMaxBack = view.maxBack
    const bar = thumb(lines.length, size.chatRows, view.top)

    /** One settings group as chip rows: the heading as text, each choice a clickable chip. */
    const chipGroup = (key: string, heading: string, choices: readonly { value: string; label: string }[], picked: string, pick: (value: string) => void) => {
      const texts = groupTexts(heading, choices, picked, t)
      return chipRows(texts, size.cardWidth, t.layout.chipGap).map(row => (
        <Box flexDirection="row" columnGap={t.layout.chipGap}>
          {row.map(index => {
            if (index === 0) return <Text color={C.accent}>{heading}</Text>
            const choice = choices[index - 1]!
            const isPicked = choice.value === picked
            return (
              <Button key={`${key}-${choice.value}`} plain onPress={() => pick(choice.value)}>
                <Text color={isPicked ? C.picked : C.dim}>{isPicked ? L.radioOn : L.radioOff}</Text> {choice.label}
              </Button>
            )
          })}
        </Box>
      ))
    }

    const drawLine = (line: Line) =>
      line.length === 0 ? (
        <Text> </Text>
      ) : (
        <Text wrap="truncate-end">
          {line.map(segment => (
            <Text color={segment.color} bold={segment.bold} dimColor={segment.dim}>
              {segment.text}
            </Text>
          ))}
        </Text>
      )

    const scrollbarProps: ScrollbarProps = {
      rows: size.chatRows,
      total: lines.length,
      start: bar.start,
      size: bar.size,
      track: t.scrollbar.track,
      thumb: t.scrollbar.thumb,
      color: C.scrollbar,
    }
    // Only the terminal and desktop draw a Client; elsewhere the wheel still scrolls.
    let scrollbar = null
    if ((e.surface === 'terminal' || e.surface === 'desktop') && lines.length > size.chatRows) {
      const { Client } = $.ui.resolve(e)
      scrollbar = <Client key={SCROLLBAR} module="./scrollbar.ts" props={scrollbarProps} width={1} height={size.chatRows} />
    }

    return (
      <Box flexDirection="column" height={e.props.scroll.bodyRows}>
        <Box flexDirection="row" justifyContent="space-between" flexShrink={0}>
          <Text color={C.accent} bold>
            {L.title}
          </Text>
          <Text color={isBusy ? C.busy : C.idle}>{fill(L.session, { n: chatNumber, status })}</Text>
        </Box>

        <Box flexDirection="column" borderStyle={t.borders.settings} borderColor={C.border} paddingX={1} flexShrink={0}>
          {chipGroup('model', L.modelHeading, t.models, picks.model, value => void choose($, { model: value }))}
          {chipGroup('effort', L.effortHeading, t.efforts, picks.effort, value => void choose($, { effort: value }))}
          {chipGroup('persona', L.personaHeading, personaChoices, picks.persona, value => void choose($, { persona: value }))}
          {problems.map(problem => (
            <Text color={C.error} wrap="truncate-end">
              personas: {problem}
            </Text>
          ))}
          {chipRows(contextGroup, size.cardWidth, t.layout.chipGap).map(row => (
            <Box flexDirection="row" columnGap={t.layout.chipGap}>
              {row.map(index =>
                index === 0 ? (
                  <Text color={C.accent}>{L.contextHeading}</Text>
                ) : index === 1 ? (
                  <Button key="context" plain onPress={() => choose($, { withContext: !picks.withContext })}>
                    <Text color={picks.withContext ? C.picked : C.dim}>{picks.withContext ? L.checkOn : L.checkOff}</Text> {L.context}
                  </Button>
                ) : (
                  <Text color={C.gauge}>{contextGroup[2]}</Text>
                ),
              )}
            </Box>
          ))}
          {chipRows(soundGroup, size.cardWidth, t.layout.chipGap).map(row => (
            <Box flexDirection="row" columnGap={t.layout.chipGap}>
              {row.map(index => {
                const item = sound[index]!
                if (item.key === 'heading') return <Text color={C.accent}>{item.text}</Text>
                if (item.key === 'unavailable') return <Text color={C.dim} wrap="truncate-end">{item.text}</Text>
                const isOn = item.key === 'audio' ? picks.audio : picks.voice
                return (
                  <Button key={item.key} plain onPress={() => setSwitch($, item.key as 'audio' | 'voice', !isOn)}>
                    <Text color={isOn ? C.picked : C.dim}>{isOn ? L.checkOn : L.checkOff}</Text>
                    <Text> {item.key === 'audio' ? L.audio : L.voice}</Text>
                  </Button>
                )
              })}
            </Box>
          ))}
        </Box>

        <Box flexDirection="column" borderStyle={t.borders.chat} borderColor={C.chatBorder} paddingX={1} flexGrow={1} overflow="hidden">
          <Box flexDirection="row" columnGap={2} flexShrink={0}>
            <Text color={C.chatBorder} bold>
              {L.chatHeading}
            </Text>
            {view.back > 0 && <Text color={C.dim}>{fill(L.scrolledBack, { n: view.back })}</Text>}
            {view.back > 0 && <Button key="newest" label={L.toBottom} onPress={() => scrollTo($, 0)} />}
            <Button key="new" label={L.newChat} onPress={() => clearChat($)} />
          </Box>
          <Box flexDirection="row" columnGap={1} flexGrow={1}>
            <Box flexDirection="column" width={size.chatWidth} justifyContent="flex-end" overflow="hidden">
              {view.lines.map(drawLine)}
            </Box>
            {scrollbar}
          </Box>
        </Box>

        <Box flexDirection="column" borderStyle={t.borders.input} borderColor={C.inputBorder} paddingX={1} flexShrink={0}>
          <Text color={C.inputBorder}>{L.inputHeading}</Text>
          <Input
            key={`message-${sent}`}
            label=">"
            placeholder={isBusy ? `${L.thinking}...` : L.placeholder}
            submitLabel={L.send}
            rows={t.layout.inputRows}
            autoFocus
            onSubmit={value => {
              void send($, value)
            }}
          />
        </Box>

        <Box flexShrink={0}>
          <Text color={C.dim} wrap="truncate-end">
            {fill(L.footer, {
              status,
              model: modelLabel,
              effort: picks.effort,
              persona: persona?.label ?? '',
              input: kilo(usage?.input ?? 0),
              output: kilo(usage?.output ?? 0),
            })}
          </Text>
        </Box>
      </Box>
    )
  })
}
