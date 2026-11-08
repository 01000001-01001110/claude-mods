/**
 * Type contract for the rubber-duck mod: the tuning in `data/duck.ts`, the
 * personas in `data/personas.jsonl`, the settings kept in `$.store`, and
 * the chat held in `$.state`.
 */

/** One option of a chip row. */
export type Choice = { value: string; label: string }

/**
 * How a persona's replies are read aloud by the system voice. Every field is
 * optional; a missing one falls back to `speech.defaults` in `data/duck.ts`.
 */
export type VoiceSettings = {
  /** The installed system voice's exact name (`Microsoft David Desktop`); empty for the default voice. */
  name?: string
  /** SAPI speaking rate, -10 (slowest) to 10 (fastest); 0 is normal. */
  rate?: number
  /** SAPI volume, 0 to 100. */
  volume?: number
  /** An SSML prosody pitch (`-20%`, `+2st`, `low`, `x-low`); empty for none. */
  pitch?: string
}

/**
 * A persona: how the duck talks, as its system prompt. One line of
 * `data/personas.jsonl`. `pack` names a sound pack whose clips the persona
 * may play as reactions; `voice` tunes how its replies are read aloud.
 */
export type Persona = { value: string; label: string; system: string; pack?: string; voice?: VoiceSettings }

/** One line of the duck chat. */
export type Turn = {
  role: 'you' | 'duck' | 'error'
  text: string
  /** For a duck reply: which model answered and how long it took. */
  model?: string
  ms?: number
  /** For a duck reply: the label of the clip that played with it, if one did. */
  clip?: string
}

/** What the person picked; kept across sessions. `audio` plays a persona's clips, `voice` reads replies aloud. */
export type Settings = { model: string; effort: string; persona: string; withContext: boolean; audio: boolean; voice: boolean }

/** Token use of the last reply, for the context gauge. */
export type Usage = { input: number; output: number }

/** One run of text in a drawn chat line, with its look. */
export type Segment = { text: string; color?: string; bold?: boolean; dim?: boolean }

/** One drawn row of the chat window. */
export type Line = Segment[]

/** Which program plays a sound or speaks: `auto` picks PowerShell on Windows, the engine elsewhere. */
export type PlayerChoice = 'auto' | 'powershell' | 'engine'

/** How sound files are played (the shape `hooks/sound.ts` reads). */
export type SoundSettings = {
  player: PlayerChoice
  /** 0 to 1. */
  volume: number
  /**
   * The PowerShell player's argv. `{file}` and `{volume}` are filled: an
   * entry that is exactly `{file}` gets the path as its own argument; inside
   * a longer entry the path is written with `'` doubled, so the template
   * must wrap it in single quotes.
   */
  argv: string[]
  /** How long a player may run before it is killed. */
  timeoutMs: number
}

/** A clip-pack's one sound as the duck offers it to the model. */
export type Clip = { id: string; label: string; file: string }

/** Where the remembered clip plays stand: the newest ids, newest last, and when the last one played. */
export type ClipLog = { recent: string[]; lastAt: number }

/** The whole tuning file. */
export type Tuning = {
  pane: { id: string; title: string }
  command: {
    name: string
    description: string
    argumentHint: string
    /** The words after `/duck`: start a new chat, the two switches, and the on/off values. */
    verbs: { new: string; audio: string; voice: string; on: string; off: string }
    /** Replies to `/duck ...`; `{title}` is filled. */
    replies: {
      opened: string
      audioOn: string
      audioOff: string
      /** Added after the audio reply when the current persona has no sound pack. */
      noPack: string
      voiceOn: string
      voiceOff: string
      usage: string
    }
  }
  models: Choice[]
  efforts: Choice[]
  defaults: Settings
  context: {
    /** The newest main-session messages handed to the duck when context is on. */
    recentMessages: number
    /** Each is cut to this many characters. */
    maxCharsPerMessage: number
    /** Text before the project context; `{cwd}` is filled. */
    preamble: string
  }
  chat: {
    /** The newest duck turns resent as history with each message. */
    historyTurns: number
    maxTokens: number
    timeoutMs: number
    /** Size of the window the gauge measures against. */
    windowTokens: number
  }
  /** Sound packs: where they live and how their clips are offered and played. */
  packs: {
    /** The pack's folder; `{home}` (the user's home, forward slashes) and `{pack}` are filled. */
    root: string
    /** The manifest's file name inside the pack folder. */
    manifest: string
  }
  clips: {
    /** Appended to the persona's system prompt when audio is on; `{menu}` is filled with the menu lines. */
    instruction: string
    /** One menu line; `{id}` and `{label}` are filled. */
    menuLine: string
    /** The tag line the reply starts with: `{open} id {close}`, `none` for no clip. */
    tag: { open: string; close: string; none: string }
    /** Chance (0 to 1) a named clip plays at all. */
    chance: number
    /** A clip among the last this many played is not played again. */
    noRepeat: number
    /** No clip plays within this many ms of the last one. */
    cooldownMs: number
    sound: SoundSettings
  }
  speech: {
    /** Which program speaks: PowerShell's SAPI on Windows, `$.audio.speak` elsewhere. */
    player: PlayerChoice
    /** Replies are cut to this many characters before they are spoken. */
    maxChars: number
    /** Said in place of a fenced code block. */
    codeSpoken: string
    /** The voice for a persona with none of its own (and the fallback for each missing field). */
    defaults: Required<VoiceSettings>
    /**
     * The PowerShell speaker's argv. The text arrives on standard input and
     * the voice settings in the environment variables named in `env`, so no
     * reply text is ever part of a command line.
     */
    argv: string[]
    env: { name: string; rate: string; volume: string; pitch: string }
  }
  layout: {
    /** Cells between chips in a row. */
    chipGap: number
    /** Rows the input field takes. */
    inputRows: number
    /** The chat window never gets fewer rows than this, however short the pane. */
    minChatRows: number
    /** Rows kept free at the bottom, so a measuring slip never pushes the input out of view. */
    rowSlack: number
    /** Rows one wheel tick moves the chat. */
    wheelRows: number
    /** The prefix drawn before each line of a reply. */
    replyGutter: string
    /** A line that starts a code block in a reply. */
    codeFence: string
  }
  scrollbar: { track: string; thumb: string }
  /** Every line of text the pane shows. Placeholders in `{braces}` are filled. */
  labels: {
    title: string
    /** Beside the title: `{n}` the chat number, `{status}` idle or thinking. */
    session: string
    idle: string
    thinking: string
    modelHeading: string
    effortHeading: string
    personaHeading: string
    contextHeading: string
    soundHeading: string
    chatHeading: string
    inputHeading: string
    you: string
    duck: string
    error: string
    /** After the duck label: `{model}`, `{seconds}`. */
    replyMeta: string
    /** After the reply meta when a clip played: `{clip}` its label. */
    clipMeta: string
    /** The waiting line: `{model}`, `{persona}`, `{seconds}`. */
    waiting: string
    /** Shown above the newest line while scrolled back: `{n}` lines below. */
    scrolledBack: string
    placeholder: string
    send: string
    newChat: string
    toBottom: string
    context: string
    /** The audio switch's label after its check mark. */
    audio: string
    /** The voice switch's label after its check mark. */
    voice: string
    /** Shown in place of the audio switch when the persona's pack cannot load: `{reason}`. */
    audioUnavailable: string
    radioOn: string
    radioOff: string
    checkOn: string
    checkOff: string
    empty: string
    /** The footer: `{status}`, `{model}`, `{effort}`, `{persona}`, `{input}`, `{output}`. */
    footer: string
  }
  colors: {
    accent: string
    you: string
    duck: string
    error: string
    dim: string
    gauge: string
    border: string
    chatBorder: string
    inputBorder: string
    replyGutter: string
    code: string
    picked: string
    idle: string
    busy: string
    scrollbar: string
    clip: string
  }
  /** Border styles (the terminal's names: round, double, bold, dashed, single, ...). */
  borders: { settings: string; chat: string; input: string }
  gauge: { cells: number; full: string; empty: string; open: string; close: string }
  /** How often the waiting line's clock redraws while a reply is pending. */
  waitingTickMs: number
}

declare module 'claude-code' {
  interface PluginState {
    'rubber-duck': {
      chat: Shaped<Turn[]>
      settings: Shaped<Settings | null>
      /** Epoch ms the pending reply was asked at; 0 when idle. */
      askedAt: number
      /** The clock while a reply is pending, so the waiting line counts up. */
      now: number
      usage: Usage | null
      /** Bumped per sent message, so the input field is drawn fresh and empty. */
      sent: number
      /** Which chat this is: bumped by each new chat. */
      chatNumber: number
      /** Chat lines scrolled back from the newest; 0 follows the newest. */
      scrollBack: number
      /** Which clips played lately and when, for the no-repeat and cooldown rules. */
      clipLog: Shaped<ClipLog>
    }
  }
}
