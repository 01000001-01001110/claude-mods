//! screen-share: masks private details on screen while you present, stream or
//! record, and shows a visible ON AIR mark while it does.
//!
//! `/screen-share` switches it. While on air, every transcript row the API lets
//! a mod rewrite before it is drawn (prompts, replies, tool rows and results,
//! command output, progress hints, the spinner, notices) is masked, and so are
//! other mods' panes, bands, placed rows, toasts, status lines, notices and log
//! lines. Masking is display only: the stored conversation, and what the model
//! reads, stay as they were. Wiring only: the rules are in `mask.ts`, every
//! pattern, glyph, switch and line of text in `data/screen-share.ts`.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import { tuning as t } from '../data/screen-share'
import type { Category } from '../types'
import {
  categoriesOn,
  compileRules,
  fill,
  hideWords,
  machineWords,
  maskText,
  maskTree,
  maskValue,
  readAsk,
  statusReply,
  storedFlag,
  storedWords,
} from './mask'
import type { MachineFacts, Ready } from './mask'

// Bump a shape tag whenever its value's shape changes, so a reload reads the old value as absent.
const onAirAtom = atom({ plugin: 'screen-share', key: 'onAir' } as const, false, { shape: 'on-air-1' })
const machineAtom = atom({ plugin: 'screen-share', key: 'machineWords' } as const, [] as string[], { shape: 'machine-words-1' })

/** The `$.store` key the switch is kept under across sessions: a storage name, not a tunable. */
const STORE_KEY = 'onAir'
/** The band button's key: the surface finds the button again by it after a redraw. */
const OFF_KEY = 'screen-share-off'

/** Words from the `names` option, read once per load in `register`. */
let optionWords: string[] = []
/** The last compiled rule set and the words it was built for, so a redraw does not compile again. */
let compiled: { key: string; rules: Ready[] } | null = null

/** The rules for these machine words, compiled once per distinct set. */
function rulesFor(machine: readonly string[]): Ready[] {
  const key = `${machine.join('\u0000')}\u0001${optionWords.join('\u0000')}`
  if (compiled?.key === key) return compiled.rules
  const words: { word: string; category: Category }[] = [
    ...machine.map(word => ({ word, category: t.machine.category })),
    ...optionWords.map(word => ({ word, category: 'names' as Category })),
  ]
  compiled = { key, rules: compileRules(t, words) }
  return compiled.rules
}

/** The masking rules while on air, else null. Reading subscribes a drawing, so it redraws when the switch flips. */
async function masking($: EngineInterface): Promise<Ready[] | null> {
  if ((await read($, onAirAtom)) !== true) return null
  return rulesFor(storedWords(await read($, machineAtom)))
}

/** The rules for other mods' drawings and messages: only when `maskOtherMods` is on. */
async function maskingOthers($: EngineInterface): Promise<Ready[] | null> {
  return t.maskOtherMods ? masking($) : null
}

/** What this machine says about its user. Variable names must be literals: the engine reads them off the source. */
async function readMachine($: EngineInterface): Promise<MachineFacts> {
  return {
    home: (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')),
    user: (await $.env.get('USERNAME')) ?? (await $.env.get('USER')) ?? (await $.env.get('LOGNAME')),
    host: (await $.env.get('COMPUTERNAME')) ?? (await $.env.get('HOSTNAME')),
    domain: await $.env.get('USERDOMAIN'),
  }
}

/** Shows or clears the status line entry. */
function showStatus($: EngineInterface, isOn: boolean): void {
  $.ui.status(isOn ? t.text.status : undefined)
}

/** Flips the switch; returns the reply line. */
async function setOnAir($: EngineInterface, isOn: boolean): Promise<string> {
  const was = (await read($, onAirAtom)) === true
  if (was === isOn) return isOn ? t.text.alreadyOn : t.text.alreadyOff
  await update($, onAirAtom, () => isOn)
  if (t.remember) await $.store.set(STORE_KEY, isOn)
  showStatus($, isOn)
  if (!isOn) return t.text.turnedOff
  return `${fill(t.text.turnedOn, { categories: categoriesOn(t) })}\n${t.text.turnedOnScrollback}`
}

/** The band's Turn off button. */
async function pressOff($: EngineInterface): Promise<void> {
  $.ui.toast(await setOnAir($, false))
}

/** Reads the machine's words and, when remembered, the switch from the last session. */
async function startUp($: EngineInterface): Promise<void> {
  const words = machineWords(await readMachine($), t)
  await update($, machineAtom, () => words)
  if (t.remember && storedFlag(await $.store.get(STORE_KEY)) === true) {
    await update($, onAirAtom, () => true)
  }
  showStatus($, (await read($, onAirAtom)) === true)
}

/** Answers `/screen-share`. */
async function answer($: EngineInterface, args: string): Promise<string> {
  const ask = readAsk(args, t)
  const isOn = (await read($, onAirAtom)) === true
  if (ask.kind === 'toggle') return setOnAir($, !isOn)
  if (ask.kind === 'on') return setOnAir($, true)
  if (ask.kind === 'off') return setOnAir($, false)
  const machine = storedWords(await read($, machineAtom))
  if (ask.kind === 'status') return statusReply(isOn, machine.length + optionWords.length, t)
  if (ask.kind === 'test') {
    if (ask.text === '') return t.text.testEmpty
    return fill(t.text.testResult, { masked: maskText(ask.text, rulesFor(machine)) })
  }
  return t.text.usage
}

export const register: Register = (on, options) => {
  optionWords = hideWords(options.names, t)
  compiled = null

  on('session.start', async ($, e, next) => {
    // The command's name is a literal: the engine matches `command.run` hooks by it.
    await $.command.register({ name: 'screen-share', description: t.text.commandDescription })
    await startUp($)
    return next(e)
  })

  on('command.run', { command: 'screen-share' }, async ($, e) => ({ text: await answer($, e.args) }))

  // --- transcript rows ------------------------------------------------------

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    const rules = await masking($)
    return rules ? next({ ...e, props: { ...e.props, text: maskText(e.props.text, rules) } }) : next(e)
  })

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const rules = await masking($)
    return rules ? next({ ...e, props: { ...e.props, text: maskText(e.props.text, rules) } }) : next(e)
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const rules = await masking($)
    if (!rules) return next(e)
    const input = maskValue(e.props.input, rules, t.deepLimit)
    const output = e.props.output === undefined ? {} : { output: maskValue(e.props.output, rules, t.deepLimit) }
    return next({ ...e, props: { ...e.props, input, ...output } })
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const rules = await masking($)
    return rules ? next({ ...e, props: { ...e.props, output: maskValue(e.props.output, rules, t.deepLimit) } }) : next(e)
  })

  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    // A folded group's count line can quote paths it read; unfolded, each call is a ToolUse row masked above.
    const rules = await masking($)
    return rules && t.unfoldGroups && !e.props.isExpanded ? next({ ...e, props: { ...e.props, isExpanded: true } }) : next(e)
  })

  on('ui.render', { component: 'CommandOutput' }, async ($, e, next) => {
    const rules = await masking($)
    return rules ? next({ ...e, props: { ...e.props, text: maskText(e.props.text, rules) } }) : next(e)
  })

  on('ui.render', { component: 'ToolProgress' }, async ($, e, next) => {
    const rules = await masking($)
    return rules ? next({ ...e, props: { ...e.props, hint: maskText(e.props.hint, rules) } }) : next(e)
  })

  on('ui.render', { component: 'Spinner' }, async ($, e, next) => {
    // On the desktop the spinner says what the step is doing (`Creating notes.md`), so it can hold a path.
    const rules = await masking($)
    if (!rules) return next(e)
    const message = e.props.message === null ? null : maskText(e.props.message, rules)
    return next({ ...e, props: { ...e.props, word: maskText(e.props.word, rules), message } })
  })

  on('ui.render', { component: 'InfoNotice' }, async ($, e, next) => {
    const rules = await masking($)
    return rules ? next({ ...e, props: { ...e.props, text: maskText(e.props.text, rules) } }) : next(e)
  })

  // --- the ON AIR marks -------------------------------------------------------

  on('ui.render', { component: 'SessionMode' }, async ($, e, next) => {
    const rules = await masking($)
    return rules ? next({ ...e, props: { ...e.props, modes: [...e.props.modes, t.text.mode] } }) : next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rules = await masking($)
    if (!rules || e.props.hasSurvey) return next(e)
    const below = await next(e)
    const others = t.maskOtherMods ? maskTree(below, rules) : below
    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {others as never}
        <Box flexDirection="row" gap={1}>
          <Text color={t.colors.onAir} bold>
            {t.text.onAir}
          </Text>
          <Text color={t.colors.note}>{t.text.bandNote}</Text>
          <Button key={OFF_KEY} hotkey={t.hotkeys.off} label={t.text.turnOff} onPress={() => pressOff($)} />
        </Box>
      </Box>
    )
  })

  // --- other mods' drawings and messages --------------------------------------

  on('ui.render', { component: 'Pane' }, async ($, e, next) => {
    const rules = await maskingOthers($)
    const tree = await next(e)
    return rules ? (maskTree(tree, rules) as typeof tree) : tree
  })

  on('ui.render', { component: 'Placed' }, async ($, e, next) => {
    const rules = await maskingOthers($)
    const tree = await next(e)
    return rules ? (maskTree(tree, rules) as typeof tree) : tree
  })

  on('ui.status', async ($, e, next) => {
    const rules = await maskingOthers($)
    return rules && e.text !== undefined ? next({ ...e, text: maskText(e.text, rules) }) : next(e)
  })

  on('ui.toast', async ($, e, next) => {
    const rules = await maskingOthers($)
    return rules ? next({ ...e, text: maskText(e.text, rules) }) : next(e)
  })

  on('ui.notice', async ($, e, next) => {
    const rules = await maskingOthers($)
    return rules && e.text !== undefined ? next({ ...e, text: maskText(e.text, rules) }) : next(e)
  })

  on('ui.log', async ($, e, next) => {
    const rules = await maskingOthers($)
    return rules ? next({ ...e, text: maskText(e.text, rules) }) : next(e)
  })
}
