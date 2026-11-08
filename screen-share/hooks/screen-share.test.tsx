//! screen-share tests: the shipped rules on every category at their
//! boundaries, the pure helpers, and every hook through the engine: the switch
//! and its command, each transcript row masked on the terminal and the
//! desktop, the ON AIR band, status line and mode label, other mods' drawings
//! and messages, the remembered switch, the `names` option, the machine's own
//! words, and state an earlier or foreign version stored.
//!
//! Fake keys are built from parts at run time, so a secret scan of the
//! repository does not flag the tests.

import { describe, expect, test } from 'claude-code/testing'
import type { On, Register } from 'claude-code'
import type { Plugin } from 'claude-code/testing'

import { tuning as T } from '../data/screen-share'
import type { Category, Tuning } from '../types'
import {
  categoriesOn,
  compileRules,
  cover,
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

type Dollar = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[0]

const SURFACES = ['terminal', 'desktop'] as const
type Surface = (typeof SURFACES)[number]

/** A mask style's glyphs for a span of `n` characters in a category. */
function glyphs(category: Category, n: number): string {
  const style = T.masks[T.categories[category].mask]!
  return cover('x'.repeat(n), style)
}

const DOTS = glyphs('secrets', 1)

// Fake secrets, assembled so no whole key sits in the source.
const GH_KEY = ['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2'].join('')
const ANT_KEY = ['sk', '-ant-', 'api03-', 'Zz9Yy8Xx7Ww6Vv5Uu4'].join('')
const AWS_KEY = ['AK', 'IA', 'ABCDEFGHIJKLMNOP'].join('')
const JWT = ['ey', 'JhbGciOiJIUzI1NiJ9', '.', 'eyJzdWIiOiIxMjM0In0', '.', 'abcdefghijkl'].join('')

const ALL_RULES = compileRules(T, [])

/** Masks with the shipped rules. */
function m(text: string): string {
  return maskText(text, ALL_RULES)
}

/** The shipped tuning with one category switched off. */
function without(category: Category): Tuning {
  return { ...T, categories: { ...T.categories, [category]: { ...T.categories[category], on: false } } }
}

// ---------------------------------------------------------------------------
// Pure rules
// ---------------------------------------------------------------------------

describe('secrets', () => {
  test('vendor keys are masked whole, at a fixed length', () => {
    for (const key of [GH_KEY, ANT_KEY, AWS_KEY, JWT]) expect(m(`use ${key} now`)).toBe(`use ${DOTS} now`)
  })

  test('bearer and authorization headers keep their label', () => {
    expect(m('Authorization: Bearer abcdefgh12345678')).toBe(`Authorization: Bearer ${DOTS}`)
    expect(m('curl -H "Bearer abcdefgh12345678"')).toBe(`curl -H "Bearer ${DOTS}"`)
    // Under eight characters a word after "bearer" is prose, not a token.
    expect(m('the bearer abc1234 left')).toBe('the bearer abc1234 left')
    expect(m('the bearer abcd1234 left')).toBe(`the bearer ${DOTS} left`)
  })

  test('URL passwords and secret query values', () => {
    expect(m('postgres://admin:hunter2@db:5432/x')).toBe(`postgres://admin:${DOTS}@db:5432/x`)
    expect(m('https://x.io/cb?code=1&token=abc123&b=2')).toBe(`https://x.io/cb?code=1&token=${DOTS}&b=2`)
  })

  test('secret flags and key=value pairs, quoted or not', () => {
    expect(m('gh auth --token abc123 --password=s3cret')).toBe(`gh auth --token ${DOTS} --password=${DOTS}`)
    expect(m('"password": "p@ss"')).toBe(`"password": "${DOTS}"`)
    expect(m("client_secret='xyz'")).toBe(`client_secret='${DOTS}'`)
    // "tokens: 5000" is a count, not a token.
    expect(m('tokens: 5000')).toBe('tokens: 5000')
  })

  test('a private key block keeps its frame and loses its body, even cut off mid-stream', () => {
    // Built from parts so secret scanners do not read this fake fixture as a real key.
    const KEY = 'PRIVATE ' + 'KEY'
    const rsaOpen = `-----BEGIN RSA ${KEY}-----`
    const rsaClose = `-----END RSA ${KEY}-----`
    const plainOpen = `-----BEGIN ${KEY}-----`
    const block = `${rsaOpen}
MIIEabc
def
${rsaClose}`
    expect(m(block)).toBe(`-----BEGIN RSA PRIVATE KEY-----\n${DOTS}\n-----END RSA PRIVATE KEY-----`)
    expect(m('-----BEGIN PRIVATE KEY-----\nMIIEabc')).toBe(`-----BEGIN PRIVATE KEY-----\n${DOTS}`)
  })
})

describe('environment values', () => {
  test('shell, cmd and PowerShell assignments keep the name', () => {
    expect(m('export NODE_ENV=production')).toBe(`export NODE_ENV=${DOTS}`)
    expect(m('set DB_HOST="db.internal"')).toBe(`set DB_HOST=${DOTS}`)
    expect(m('$env:MY_VAR = "value here"')).toBe(`$env:MY_VAR = ${DOTS}`)
  })

  test('a name of two letters or one in lower case is not an assignment', () => {
    expect(m('AB=1 and x=2')).toBe('AB=1 and x=2')
    expect(m('ABC=1')).toBe(`ABC=${DOTS}`)
  })

  test('a value a secret rule masked is not masked again', () => {
    expect(m('API_KEY=abc123')).toBe(`API_KEY=${DOTS}`)
  })
})

describe('paths', () => {
  const user = (n: number) => glyphs('paths', n)
  test('Windows, JSON-escaped, Git Bash, WSL, macOS and Linux user folders', () => {
    expect(m('C:\\Users\\alann\\Projects')).toBe(`C:\\Users\\${user(5)}\\Projects`)
    expect(m('"C:\\\\Users\\\\alann\\\\x"')).toBe(`"C:\\\\Users\\\\${user(5)}\\\\x"`)
    expect(m('/c/Users/alann/x')).toBe(`/c/Users/${user(5)}/x`)
    expect(m('/mnt/c/Users/alann/x')).toBe(`/mnt/c/Users/${user(5)}/x`)
    expect(m('/Users/carol/x')).toBe(`/Users/${user(5)}/x`)
    expect(m('/home/bob/x')).toBe(`/home/${user(3)}/x`)
  })
  test('a path that only mentions home is left', () => {
    expect(m('src/home/x and ./Users')).toBe('src/home/x and ./Users')
  })
})

describe('people and money', () => {
  test('emails', () => {
    expect(m('mail ada@example.com today')).toBe(`mail ${glyphs('emails', 15)} today`)
  })

  test('IPv4 addresses, with the allowed ones kept', () => {
    expect(m('at 192.168.1.20')).toBe(`at ${glyphs('ips', 12)}`)
    for (const ip of T.rules.find(r => r.id === 'ipv4')!.allow!) expect(m(`on ${ip}`)).toBe(`on ${ip}`)
    expect(m('version 1.2.3')).toBe('version 1.2.3')
  })

  test('phone numbers start at the shipped digit count', () => {
    const min = T.rules.find(r => r.id === 'phone')!.minDigits!
    const under = '5'.repeat(min - 1)
    const at = '5'.repeat(min)
    expect(m(`call ${under}`)).toBe(`call ${under}`)
    expect(m(`call ${at}`)).toBe(`call ${glyphs('phones', min)}`)
    expect(m('call +1 (555) 123-4567')).toBe(`call ${glyphs('phones', 17)}`)
  })

  test('a date and a time are not a phone number', () => {
    expect(m('on 2026-11-08 12:30')).toBe('on 2026-11-08 12:30')
  })

  test('money with a symbol, a suffix or a currency word', () => {
    expect(m('cost $12,500 today')).toBe(`cost ${glyphs('money', 7)} today`)
    expect(m('about €3.5k')).toBe(`about ${glyphs('money', 5)}`)
    expect(m('paid 3.2k USD')).toBe(`paid ${glyphs('money', 8)}`)
    expect(m('100 dollars')).toBe(glyphs('money', 11))
  })

  test('names: two or more uncommon capitalised words in a row', () => {
    expect(m('ask Ada Lovelace')).toBe(`ask ${glyphs('names', 12)}`)
    expect(m('Thanks Ada Lovelace')).toBe(`Thanks ${glyphs('names', 12)}`)
    expect(m('ask Claude Code')).toBe('ask Claude Code')
    expect(m('Hello Ada')).toBe('Hello Ada')
    expect(m('ask José Núñez')).toBe(`ask ${glyphs('names', 10)}`)
  })
})

describe('masks and compiling', () => {
  test('a matching-length mask stops at its size; a fixed one is always its size', () => {
    const block = T.masks.block!
    expect(cover('x'.repeat(block.size - 1), block)).toBe(block.glyph.repeat(block.size - 1))
    expect(cover('x'.repeat(block.size), block)).toBe(block.glyph.repeat(block.size))
    expect(cover('x'.repeat(block.size + 1), block)).toBe(block.glyph.repeat(block.size))
    const dots = T.masks.dots!
    expect(cover('x', dots)).toBe(dots.glyph.repeat(dots.size))
    expect(cover('x'.repeat(dots.size + 9), dots)).toBe(dots.glyph.repeat(dots.size))
  })

  test('a category switched off compiles none of its rules', () => {
    for (const category of Object.keys(T.categories) as Category[]) {
      const rules = compileRules(without(category), [{ word: 'Zorblax', category }])
      expect(rules.some(r => r.category === category)).toBe(false)
      expect(rules.length).toBe(ALL_RULES.length - T.rules.filter(r => r.category === category).length)
    }
    expect(maskText('mail ada@example.com', compileRules(without('emails'), []))).toBe('mail ada@example.com')
  })

  test('words are masked as written, any case, longest first', () => {
    const rules = compileRules(T, [
      { word: 'kee', category: 'names' },
      { word: 'druids-keep', category: 'paths' },
    ])
    expect(maskText('on DRUIDS-KEEP and Kee', rules)).toBe(`on ${glyphs('paths', 11)} and ${glyphs('names', 3)}`)
  })

  test('a rule shipped without the g flag still masks every match', () => {
    const rule = { id: 'once', category: 'emails' as Category, pattern: String.raw`zed\d`, flags: '' }
    const rules = compileRules({ ...T, rules: [rule] }, [])
    expect(maskText('zed1 and zed2', rules)).toBe(`${glyphs('emails', 4)} and ${glyphs('emails', 4)}`)
  })

  test('a span an earlier rule masked is left as it is, even when a later rule draws in another style', () => {
    const blockSecrets: Tuning = { ...T, categories: { ...T.categories, secrets: { ...T.categories.secrets, mask: 'block' } } }
    const rules = compileRules(blockSecrets, [])
    expect(maskText('API_KEY=abc', rules)).toBe(`API_KEY=${T.masks.block!.glyph.repeat(3)}`)
  })

  test('nothing to mask and no rules both return the text', () => {
    expect(maskText('', ALL_RULES)).toBe('')
    expect(maskText('ada@example.com', [])).toBe('ada@example.com')
  })
})

describe('helpers', () => {
  test('fill keeps unknown slots', () => {
    expect(fill('{a} {b}', { a: 1 })).toBe('1 {b}')
  })

  test('readAsk reads every verb, and anything else is usage', () => {
    expect(readAsk('', T)).toEqual({ kind: 'toggle' })
    expect(readAsk(`  ${T.verbs.on.toUpperCase()} `, T)).toEqual({ kind: 'on' })
    expect(readAsk(T.verbs.off, T)).toEqual({ kind: 'off' })
    expect(readAsk(T.verbs.status, T)).toEqual({ kind: 'status' })
    expect(readAsk(`${T.verbs.test}  a b `, T)).toEqual({ kind: 'test', text: 'a b' })
    expect(readAsk(T.verbs.test, T)).toEqual({ kind: 'test', text: '' })
    expect(readAsk(`${T.verbs.on} now`, T)).toEqual({ kind: 'usage' })
    expect(readAsk('nope', T)).toEqual({ kind: 'usage' })
  })

  test('hideWords splits the option, adds alwaysHide, drops short words and repeats', () => {
    const short = 'x'.repeat(T.minHideLength - 1)
    const enough = 'y'.repeat(T.minHideLength)
    expect(hideWords(` Acme , ${short}, ${enough}, Acme`, T)).toEqual(['Acme', enough, ...T.alwaysHide])
    expect(hideWords(['Acme', 'Beta'], T)).toEqual(['Acme', 'Beta', ...T.alwaysHide])
    expect(hideWords(7, T)).toEqual([...T.alwaysHide])
    expect(hideWords('Acme', { ...T, alwaysHide: ['Zed', 'Q'] })).toEqual(T.minHideLength > 1 ? ['Acme', 'Zed'] : ['Acme', 'Zed', 'Q'])
  })

  test('machineWords takes what `use` names at the minimum length, and the home folder in every slash style', () => {
    const min = T.machine.minLength
    const facts = { home: 'C:\\Users\\alann', user: 'u'.repeat(min), host: 'h'.repeat(min - 1), domain: '  ' }
    const words = machineWords(facts, T)
    expect(words).toContain('C:\\Users\\alann')
    expect(words).toContain('C:/Users/alann')
    expect(words).toContain('C:\\\\Users\\\\alann')
    expect(words).toContain('u'.repeat(min))
    expect(words).not.toContain('h'.repeat(min - 1))
    expect(machineWords(facts, { ...T, machine: { ...T.machine, use: ['user'] } })).toEqual(['u'.repeat(min)])
  })

  test('stored values are read only when they have the right type', () => {
    expect(storedFlag(true)).toBe(true)
    expect(storedFlag(false)).toBe(false)
    expect(storedFlag('true')).toBe(undefined)
    expect(storedWords(['a'])).toEqual(['a'])
    expect(storedWords(['a', 1])).toEqual([])
    expect(storedWords({ shape: 'x', value: ['a'] })).toEqual([])
  })

  test('statusReply lists every category with its switch', () => {
    const off = without('money')
    const reply = statusReply(true, 4, off)
    expect(reply.split('\n')[0]).toBe(T.text.statusOn)
    expect(reply).toContain(fill(T.text.statusCategoryOff, { label: T.categories.money.label }))
    expect(reply).toContain(fill(T.text.statusCategoryOn, { label: T.categories.emails.label }))
    expect(reply).toContain(fill(T.text.statusWords, { count: 4 }))
    expect(statusReply(false, 0, T).split('\n')[0]).toBe(T.text.statusOff)
    expect(categoriesOn(off)).not.toContain(T.categories.money.label)
  })

  test('maskValue walks objects and arrays to the depth limit, keys untouched', () => {
    const value = { 'ada@example.com': 'ada@example.com', n: 5, list: ['ada@example.com', null] }
    const masked = maskValue(value, ALL_RULES, T.deepLimit) as typeof value
    expect(masked['ada@example.com']).toBe(glyphs('emails', 15))
    expect(masked.n).toBe(5)
    expect(masked.list).toEqual([glyphs('emails', 15), null])
    // A string at depth `limit` is reached; one level deeper is not.
    const nest = (depth: number): unknown => (depth === 0 ? 'ada@example.com' : { x: nest(depth - 1) })
    const reach = (v: unknown, depth: number): unknown => (depth === 0 ? v : reach((v as { x: unknown }).x, depth - 1))
    expect(reach(maskValue(nest(2), ALL_RULES, 2), 2)).toBe(glyphs('emails', 15))
    expect(reach(maskValue(nest(3), ALL_RULES, 2), 3)).toBe('ada@example.com')
  })

  test('maskTree masks the words of a drawing and leaves the rest as it came', () => {
    const client = { type: 'Client', props: { module: './x.ts', note: 'ada@example.com' } }
    const tree = {
      type: 'Box',
      props: { flexDirection: 'column' },
      children: [
        { type: 'Text', props: { bold: true }, children: ['mail ada@example.com'] },
        { type: 'Button', props: { key: 'b', label: 'ada@example.com' }, press: { plugin: 'p', handle: 1 } },
        { type: 'Markdown', props: { text: '**ada@example.com**' } },
        { type: 'Code', props: { source: 'ada@example.com', language: 'txt' } },
        client,
        7,
      ],
    }
    const out = maskTree(tree, ALL_RULES) as typeof tree
    const mail = glyphs('emails', 15)
    const kids = out.children as Record<string, unknown>[]
    expect((kids[0] as { children: string[] }).children).toEqual([`mail ${mail}`])
    expect((kids[0] as { props: unknown }).props).toEqual({ bold: true })
    expect((kids[1] as { props: { label: string } }).props.label).toBe(mail)
    expect(kids[1]!.press).toEqual({ plugin: 'p', handle: 1 })
    expect((kids[2] as { props: { text: string } }).props.text).toBe(`**${mail}**`)
    expect((kids[3] as { props: { source: string } }).props.source).toBe(mail)
    expect(kids[4]).toBe(client)
    expect(kids[5]).toBe(7)
    const clean = { type: 'Text', children: ['nothing here'] }
    expect(maskTree(clean, ALL_RULES)).toBe(clean)
    expect(maskTree(null, ALL_RULES)).toBe(null)
    expect(maskTree(['a', 'ada@example.com'], ALL_RULES)).toEqual(['a', mail])
  })
})

// ---------------------------------------------------------------------------
// Through the engine
// ---------------------------------------------------------------------------

type World = {
  toasts: string[]
  statuses: (string | undefined)[]
  notices: (string | undefined)[]
  logs: string[]
  store: Map<string, unknown>
  env: Record<string, string | undefined>
  /** What another mod's band beneath says. */
  otherBand: string
}

const SECRET_LINE = `key ${GH_KEY} for ada@example.com`
const SECRET_SHOWN = `key ${DOTS} for ${glyphs('emails', 15)}`

/** Stands in for the engine beneath the mod: records what reaches it, draws each row from its props. */
function engine(on: On, env: Record<string, string | undefined> = {}): World {
  const world: World = { toasts: [], statuses: [], notices: [], logs: [], store: new Map(), env, otherBand: SECRET_LINE }
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', () => ({ value: { command: 'screen-share' } }))
  on('command.run', () => ({ text: '' }))
  on('env.get', (_, e) => ({ value: world.env[e.name] }))
  on('store.get', (_, e) => ({ value: world.store.get(e.key) }) as never)
  on('store.set', (_, e) => {
    world.store.set(e.key, e.value)
    return { value: undefined } as never
  })
  on('ui.toast', (_, e) => {
    world.toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', (_, e) => {
    world.statuses.push(e.text)
    return { value: undefined }
  })
  on('ui.notice', (_, e) => {
    world.notices.push(e.text)
    return { value: undefined }
  })
  on('tool.call', () => ({ result: {} }) as never)
  on('ui.log', (_, e) => {
    world.logs.push(e.text)
    return { value: undefined }
  })
  on('ui.render', ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const p = e.props as Record<string, unknown>
    switch (e.component) {
      case 'ToolUse':
        return <Text>{JSON.stringify({ input: p.input, output: p.output })}</Text>
      case 'ToolResult':
        return <Text>{JSON.stringify(p.output)}</Text>
      case 'ToolProgress':
        return <Text>{String(p.hint)}</Text>
      case 'Spinner':
        return <Text>{`${String(p.word)}|${String(p.message)}`}</Text>
      case 'ToolGroup':
        return <Text>{`expanded:${String(p.isExpanded)}`}</Text>
      case 'SessionMode':
        return <Text>{(p.modes as string[]).join(' & ')}</Text>
      case 'AbovePrompt':
        return <Text>{world.otherBand}</Text>
      case 'Pane':
      case 'Placed':
        return (
          <Box>
            <Text>{SECRET_LINE}</Text>
            <Button key="other" label={SECRET_LINE} onPress={() => undefined} />
          </Box>
        )
      default:
        return <Text>{String(p.text)}</Text>
    }
  })
  return world
}

/** Another mod that speaks on every tool call: a toast, a status line, a notice, a cleared notice and a log line. */
const chattyRegister: Register = on => {
  // An inline plugin runs on its own and sees none of this file's names, so its line is spelled out here (it equals SECRET_LINE).
  const line = `key ${['gh', 'p_', 'A1b2C3d4E5f6G7h8I9j0K1l2'].join('')} for ada@example.com`
  on('tool.call', async ($, e, next) => {
    $.ui.toast(line)
    $.ui.status(line)
    $.ui.notice('t1', line)
    $.ui.notice('t1', undefined)
    $.ui.log(line)
    return next(e)
  })
}
const chatty: Plugin = { name: 'chatty', register: chattyRegister }

const START = { cwd: '/repo', surface: 'terminal', isInteractive: true } as const

/** A /screen-share command. */
function command(args: string) {
  return { command: 'screen-share', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 120 } } as const
}

/** Runs /screen-share and returns its reply. */
async function run($: Dollar, args: string): Promise<string> {
  return String((await $.command.run(command(args) as never)).text)
}

const ROWS = {
  UserMessage: { text: SECRET_LINE, origin: { kind: 'composer' }, isExpanded: false },
  AssistantMessage: { text: SECRET_LINE, isFirstOfReply: true },
  CommandOutput: { command: 'x', args: '', text: SECRET_LINE, isErrored: false },
  InfoNotice: { text: SECRET_LINE, command: null },
  ToolProgress: { tool_use_id: 't1', kind: 'background_hint', hint: SECRET_LINE },
} as const

const BAND = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 160, scroll: { offset: 0, bodyRows: 9 }, view: {} }
const PANE = { title: 'Other', isFocused: false, bodyColumns: 80, placement: 'dock', scroll: { offset: 0, bodyRows: 20 }, view: {} }

type Drawn = { texts: string[]; buttons: string[] }

/** What a component draws on a surface: its texts and its buttons' labels. */
async function draw($: Dollar, component: string, props: unknown, surface: Surface, plugin = 'screen-share'): Promise<Drawn> {
  const ui = await $.ui.mount({ plugin, component, requestId: 'r1', props, surface } as never)
  const texts = (await ui.findAll({ type: 'Text' })).map(n => n.text)
  const buttons = (await ui.findAll({ type: 'Button' })).map(n => String(n.props.label))
  await ui.unmount()
  return { texts, buttons }
}

/** The one text a row draws. */
async function row($: Dollar, component: keyof typeof ROWS | string, props: unknown, surface: Surface): Promise<string> {
  return (await draw($, component, props, surface)).texts[0] ?? ''
}

/** The band's own line, as drawn. */
const ON_AIR = [T.text.onAir, T.text.bandNote]

test('off by default: rows, band and other mods’ messages pass untouched', { plugins: [chatty] }, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  for (const surface of SURFACES) {
    for (const [component, props] of Object.entries(ROWS)) expect(await row($, component, props, surface)).toBe(SECRET_LINE)
    expect((await draw($, 'AbovePrompt', BAND, surface)).texts).toEqual([SECRET_LINE])
    expect(await row($, 'SessionMode', { modes: ['focus'] }, surface)).toBe('focus')
    expect(await row($, 'ToolGroup', { calls: [], isActive: false, isExpanded: false }, surface)).toBe('expanded:false')
    expect(await row($, 'Spinner', { word: SECRET_LINE, message: null, suffix: '…', mode: 'thinking' }, surface)).toBe(`${SECRET_LINE}|null`)
    expect((await draw($, 'Pane', PANE, surface)).texts).toEqual([SECRET_LINE])
  }
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await run($, T.verbs.status)
  expect(world.toasts).toEqual([SECRET_LINE])
  expect(world.logs).toEqual([SECRET_LINE])
  expect(world.statuses).toEqual([undefined, SECRET_LINE])
})

test('/screen-share on masks every transcript row, on the terminal and the desktop', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  const reply = await run($, T.verbs.on)
  expect(reply).toBe(`${fill(T.text.turnedOn, { categories: categoriesOn(T) })}\n${T.text.turnedOnScrollback}`)
  expect(world.store.get('onAir')).toBe(true)
  for (const surface of SURFACES) {
    for (const [component, props] of Object.entries(ROWS)) expect(await row($, component, props, surface)).toBe(SECRET_SHOWN)
    const tool = { tool_use_id: 't1', tool: 'Bash', input: { command: SECRET_LINE }, isRunning: false, isErrored: false, isInterrupted: false, output: { stdout: SECRET_LINE } }
    expect(JSON.parse(await row($, 'ToolUse', tool, surface))).toEqual({ input: { command: SECRET_SHOWN }, output: { stdout: SECRET_SHOWN } })
    const running = { ...tool, isRunning: true, output: undefined }
    expect(JSON.parse(await row($, 'ToolUse', running, surface))).toEqual({ input: { command: SECRET_SHOWN } })
    const result = { tool_use_id: 't1', tool: 'Bash', output: { stdout: SECRET_LINE, stderr: '' }, isErrored: false }
    expect(JSON.parse(await row($, 'ToolResult', result, surface))).toEqual({ stdout: SECRET_SHOWN, stderr: '' })
    expect(await row($, 'Spinner', { word: SECRET_LINE, message: SECRET_LINE, suffix: '…', mode: 'tool-use' }, surface)).toBe(`${SECRET_SHOWN}|${SECRET_SHOWN}`)
    expect(await row($, 'Spinner', { word: 'Working', message: null, suffix: '…', mode: 'thinking' }, surface)).toBe('Working|null')
    expect(await row($, 'ToolGroup', { calls: [], isActive: false, isExpanded: false }, surface)).toBe(`expanded:${String(T.unfoldGroups)}`)
    expect(await row($, 'SessionMode', { modes: ['focus'] }, surface)).toBe(`focus & ${T.text.mode}`)
  }
  // The status line is sent without waiting; by now it has landed.
  expect(world.statuses).toEqual([undefined, T.text.status])
})

test('the ON AIR band shows over another mod’s masked band, yields to a survey, and Turn off ends it', async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await run($, T.verbs.on)
  for (const surface of SURFACES) {
    const band = await draw($, 'AbovePrompt', BAND, surface)
    expect(band.texts).toEqual([SECRET_SHOWN, ...ON_AIR])
    expect(band.buttons).toEqual([T.text.turnOff])
    expect((await draw($, 'AbovePrompt', { ...BAND, hasSurvey: true }, surface)).texts).toEqual([SECRET_LINE])
  }
  const ui = await $.ui.mount({ plugin: 'screen-share', component: 'AbovePrompt', props: BAND, surface: 'desktop' } as never)
  const button = await ui.find({ type: 'Button' })
  expect(button?.props.hotkey).toBe(T.hotkeys.off)
  await ui.press({ key: 'screen-share-off' })
  await ui.unmount()
  expect(world.store.get('onAir')).toBe(false)
  for (const surface of SURFACES) {
    expect((await draw($, 'AbovePrompt', BAND, surface)).texts).toEqual([SECRET_LINE])
    expect(await row($, 'UserMessage', ROWS.UserMessage, surface)).toBe(SECRET_LINE)
  }
  expect(world.toasts).toEqual([T.text.turnedOff])
  expect(world.statuses).toEqual([undefined, T.text.status, undefined])
})

test('other mods: panes, placed rows, toasts, status lines, notices and log lines are masked while on air', { plugins: [chatty] }, async ($, on) => {
  const world = engine(on)
  await $.session.start(START)
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await run($, T.verbs.on)
  for (const surface of SURFACES) {
    for (const component of ['Pane', 'Placed']) {
      const drawn = await draw($, component, component === 'Pane' ? PANE : { id: 'x', plugin: 'other' }, surface)
      expect(drawn.texts).toEqual([SECRET_SHOWN])
      expect(drawn.buttons).toEqual([SECRET_SHOWN])
    }
  }
  await $.tool.call({ tool: 'Bash', command: 'ls' } as never)
  await run($, T.verbs.status)
  expect(world.toasts).toEqual([SECRET_LINE, SECRET_SHOWN])
  expect(world.statuses).toEqual([undefined, SECRET_LINE, T.text.status, SECRET_SHOWN])
  expect(world.notices).toEqual([SECRET_LINE, undefined, SECRET_SHOWN, undefined])
  expect(world.logs).toEqual([SECRET_LINE, SECRET_SHOWN])
})

test('the command: toggle, already on and off, status, test and usage', async ($, on) => {
  engine(on, { USERNAME: 'zorblax' })
  await $.session.start(START)
  expect(await run($, T.verbs.off)).toBe(T.text.alreadyOff)
  expect(await run($, '')).toContain(fill(T.text.turnedOn, { categories: categoriesOn(T) }))
  expect(await run($, T.verbs.on)).toBe(T.text.alreadyOn)
  expect(await run($, T.verbs.status)).toBe(statusReply(true, 1, T))
  expect(await run($, '')).toBe(T.text.turnedOff)
  expect(await run($, T.verbs.status)).toBe(statusReply(false, 1, T))
  // test masks whether or not the mode is on, the machine's words included.
  expect(await run($, `${T.verbs.test} ${SECRET_LINE} zorblax`)).toBe(fill(T.text.testResult, { masked: `${SECRET_SHOWN} ${glyphs('paths', 7)}` }))
  expect(await run($, T.verbs.test)).toBe(T.text.testEmpty)
  expect(await run($, 'loud')).toBe(T.text.usage)
})

test('the machine’s home folder and user name are masked as written', async ($, on) => {
  engine(on, { USERPROFILE: 'D:\\profiles\\zorblax', USERNAME: 'zorblax', COMPUTERNAME: 'KEEP-01' })
  await $.session.start(START)
  await run($, T.verbs.on)
  const text = 'D:\\profiles\\zorblax\\x on KEEP-01 by zorblax'
  for (const surface of SURFACES) {
    expect(await row($, 'UserMessage', { ...ROWS.UserMessage, text }, surface)).toBe(
      `${glyphs('paths', 19)}\\x on ${glyphs('paths', 7)} by ${glyphs('paths', 7)}`,
    )
  }
})

test('a later session start reads the machine again, and its new words are masked', async ($, on) => {
  const world = engine(on, { USERNAME: 'zorblax' })
  await $.session.start(START)
  await run($, T.verbs.on)
  expect(await row($, 'UserMessage', { ...ROWS.UserMessage, text: 'zorblax' }, 'terminal')).toBe(glyphs('paths', 7))
  world.env.USERNAME = 'quixotic'
  await $.session.start(START)
  expect(await row($, 'UserMessage', { ...ROWS.UserMessage, text: 'quixotic zorblax' }, 'desktop')).toBe(`${glyphs('paths', 8)} zorblax`)
})

test('names from the option are masked', { options: { names: 'Acme, Q' } }, async ($, on) => {
  engine(on)
  await $.session.start(START)
  await run($, T.verbs.on)
  // "Q" is under the shipped minimum length, so it stays.
  expect(await row($, 'UserMessage', { ...ROWS.UserMessage, text: 'Acme and Q' }, 'terminal')).toBe(
    T.minHideLength > 1 ? `${glyphs('names', 4)} and Q` : `${glyphs('names', 4)} and ${glyphs('names', 1)}`,
  )
})

describe('the remembered switch', () => {
  test('a session after one left on air starts on air', async ($, on) => {
    const world = engine(on)
    world.store.set('onAir', true)
    await $.session.start(START)
    expect(world.statuses).toEqual([T.remember ? T.text.status : undefined])
    expect(await row($, 'UserMessage', ROWS.UserMessage, 'terminal')).toBe(T.remember ? SECRET_SHOWN : SECRET_LINE)
  })

  for (const stored of ['true', 1, { shape: 'x', value: true }, null]) {
    test(`a stored ${JSON.stringify(stored)} is not a switch`, async ($, on) => {
      const world = engine(on)
      world.store.set('onAir', stored)
      await $.session.start(START)
      expect(world.statuses).toEqual([undefined])
      expect(await row($, 'UserMessage', ROWS.UserMessage, 'desktop')).toBe(SECRET_LINE)
    })
  }
})

describe('state an earlier or foreign version stored', () => {
  /** What a reload can meet under each key. */
  const seeds = [
    ['unshaped values', { onAir: true, machineWords: ['zorblax'] }, false],
    ['another shape', { onAir: { shape: 'on-air-0', value: true }, machineWords: { shape: 'machine-words-0', value: 7 } }, false],
    ['a tagged undefined', { onAir: { shape: 'on-air-1', value: undefined }, machineWords: { shape: 'machine-words-1', value: undefined } }, false],
    ['our shape holding a string', { onAir: { shape: 'on-air-1', value: 'yes' }, machineWords: { shape: 'machine-words-1', value: [] } }, false],
    ['our shape on air with broken words', { onAir: { shape: 'on-air-1', value: true }, machineWords: { shape: 'machine-words-1', value: [1, 2] } }, true],
  ] as const
  for (const [name, seed, isOnAir] of seeds) {
    test(`${name}: the drawings still render`, async ($, on) => {
      engine(on)
      on('state.get', (_, e, next) => {
        const key = (e as { key: string }).key as keyof typeof seed
        return key in seed ? ({ value: { value: seed[key], version: 1 } } as never) : next(e)
      })
      for (const surface of SURFACES) {
        expect(await row($, 'UserMessage', ROWS.UserMessage, surface)).toBe(isOnAir ? SECRET_SHOWN : SECRET_LINE)
        const band = await draw($, 'AbovePrompt', BAND, surface)
        expect(band.texts).toEqual(isOnAir ? [SECRET_SHOWN, ...ON_AIR] : [SECRET_LINE])
        const drawn = await draw($, 'Pane', PANE, surface)
        expect(drawn.texts).toEqual([isOnAir ? SECRET_SHOWN : SECRET_LINE])
      }
    })
  }
})
