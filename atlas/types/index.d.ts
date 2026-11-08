/**
 * Type contract for the atlas mod: the tuning in `data/atlas.ts`, the atlas
 * document `scripts/scan.mjs` prints, and the session values kept in `$.state`.
 */

/** One piece of evidence: where a fact was read, repo-relative, 1-based line. */
export type Evidence = { file: string; line: number; text: string }

/** What kind of gap a row reports. */
export type GapKind =
  | 'unprovisioned'
  | 'envMissing'
  | 'envOptional'
  | 'envUndocumented'
  | 'envUnused'
  | 'unused'
  | 'secret'
  | 'apiKey'

/** How loud a gap is: a warning (`!`) or a note (`?`). */
export type Severity = 'warn' | 'note'

/** One gap: what is needed and not provided (or the reverse), with the evidence. */
export type Gap = {
  kind: GapKind
  severity: Severity
  /** The service name, env name or file the row is about. */
  subject: string
  evidence: Evidence[]
}

/** A service's kind: something to provision, a third-party API, or a local file. */
export type ServiceKind = 'resource' | 'api' | 'file'

/** One infra node: implied by code or config, provided (or not) by declared infra. */
export type Service = {
  id: string
  name: string
  kind: ServiceKind
  implied: Evidence[]
  provided: Evidence[]
  /** Env names tied to this service, read or defined anywhere. */
  env: string[]
  /** Whether at least one of those env names is defined somewhere. */
  isEnvDefined: boolean
  /** Ids of the code modules whose files carry the evidence. */
  modules: string[]
}

/** One way the repo runs or ships: a Dockerfile, a Procfile line, a bin, a plugin. */
export type Runtime = { name: string; how: string; file: string; line: number }

/** One env name with where it is read and defined. */
export type EnvName = {
  name: string
  read: Evidence | null
  defined: Evidence | null
  isInExample: boolean
}

/** The env three-way picture. */
export type EnvFacts = { names: EnvName[]; hasExample: boolean }

/** One code module: a workspace unit or a folded folder. */
export type Module = {
  id: string
  name: string
  path: string
  files: number
  lines: number
  churn: number
  isHot: boolean
  entries: Evidence[]
  fanIn: number
  fanOut: number
  /** Service ids this module's files point at. */
  uses: string[]
}

/** A folded edge between modules: how many imports, and the first one seen. */
export type Edge = { from: string; to: string; count: number; via: Evidence }

/** A module-level cycle, with one import per hop as its witness. */
export type Cycle = { modules: string[]; via: Evidence[] }

/** The code view. */
export type Code = {
  /** Which sources gave the edges (`cargo`, `csproj`, `depcruise`, `regex`). */
  sources: string[]
  isApproximate: boolean
  modules: Module[]
  edges: Edge[]
  cycles: Cycle[]
  orphans: string[]
}

/** The scanner's whole answer. `version` changes when the document's shape does. */
export type Atlas = {
  version: 1
  /** The cache key: HEAD plus the key files' sizes and times. */
  key: string
  root: string
  name: string
  head: string | null
  scannedAt: number
  files: number
  services: Service[]
  runtimes: Runtime[]
  env: EnvFacts
  gaps: Gap[]
  code: Code
  offers: { npx: boolean }
  notes: string[]
}

/** The scanner's answer in key mode: only the cache key. */
export type KeyAnswer = { key: string }

/** The opt-in model labels, pinned to one scan by its key. */
export type Labels = { key: string; roles: Record<string, string>; flow: string[] }

/** Which view the pane shows. */
export type Tab = 'infra' | 'code' | 'gaps'

/** What the scanner is doing, and whether the document on hand is out of date. */
export type Status = {
  phase: 'idle' | 'scanning' | 'failed'
  error: string
  isStale: boolean
  /** The file whose edit made it stale. */
  staleBy: string
}

/** One run of text in a drawn line. */
export type Segment = { text: string; color?: string; isBold?: boolean; isDim?: boolean }

/** One drawn line. */
export type Line = Segment[]

/** The request written to the scanner's stdin. */
export type ScanRequest = {
  mode: 'scan' | 'key'
  root: string
  allowNpx: boolean
  now: number
  fold: Tuning['fold']
  budgets: Tuning['budgets']
  tools: Tuning['tools']
}

/** The whole tuning file. */
export type Tuning = {
  /** How the node scanner is started. */
  scan: {
    /** argv[0] for the scanner. */
    node: string
    /** The scanner, relative to the plugin root. */
    script: string
    /** The shared signals file, relative to the plugin root. */
    signals: string
    /** A full scan's time limit. */
    timeoutMs: number
    /** A key check's time limit. */
    keyTimeoutMs: number
  }
  /** npx is a network install of third-party code: off until the person allows it. */
  allowNpx: boolean
  /** How files fold into modules. */
  fold: {
    /** Folder depth a module is cut at when no workspace unit holds the file. */
    depth: number
    /** Below this many modules, the biggest one is split into its children. */
    minModules: number
    /** Share of modules (by churn × lines) marked hot. */
    hotShare: number
    /** Days of git history the churn counts. */
    churnDays: number
  }
  /** Caps on what the document carries, so it stays small enough to store. */
  budgets: {
    files: number
    evidencePerGap: number
    gaps: number
    modules: number
    edges: number
  }
  /** Outside tools the scanner may run, argv per tool; `shims` names the ones that need a shell on Windows. */
  tools: {
    git: string
    cargo: string[]
    compose: string[]
    depcruise: string[]
    localDepcruise: string
    shims: string[]
    timeoutMs: number
    npxTimeoutMs: number
  }
  /** Edits that make the scan stale: tool name to the input field holding the path. */
  stale: { tools: Record<string, string> }
  /** How often the pane's "scanned N ago" redraws. */
  tickMs: number
  /** The pane. */
  pane: { id: string; title: string }
  /** Rows per section in the pane. */
  rows: {
    attention: number
    evidence: number
    runtimes: number
    services: number
    modules: number
    cycles: number
    usesPerModule: number
  }
  /** Column widths in the pane's tables. */
  columns: { runs: number; service: number; env: number; module: number; path: number }
  /** Where `/atlas export` writes, relative to the scanned root. */
  export: { dir: string; markdown: string; html: string }
  /** The opt-in labels pass. */
  explain: {
    model: string
    maxTokens: number
    timeoutMs: number
    roleWords: number
    flowLines: number
    system: string
    prompt: string
  }
  /** The desktop and export SVG. */
  svg: {
    width: number
    boxWidth: number
    boxHeight: number
    rankGap: number
    rowGap: number
    pad: number
    font: number
    maxStroke: number
    serviceColumn: number
    colors: { box: string; hot: string; entry: string; cycle: string; service: string; missing: string; edge: string; text: string; back: string }
  }
  /** Theme keys per meaning. */
  palette: {
    title: string
    warn: string
    note: string
    ok: string
    missing: string
    hot: string
    entry: string
    cycle: string
    rule: string
    dim: string
  }
  glyphs: {
    warn: string
    note: string
    entry: string
    hot: string
    cycle: string
    arrow: string
    uses: string
    fanIn: string
    rule: string
    sep: string
    ellipsis: string
  }
  hotkeys: { infra: string; code: string; gaps: string; rescan: string; export: string; explain: string; quit: string; allow: string; deny: string }
  /** The words `/atlas` takes after its name. */
  command: {
    description: string
    infra: string
    code: string
    gaps: string
    explain: string
    export: string
    rescan: string
    npx: string
    on: string
    off: string
  }
  /** Every line of text a person reads. Placeholders are `{name}`. */
  text: {
    header: string
    scannedJustNow: string
    scannedAgo: string
    units: { s: string; m: string; h: string; d: string }
    noHead: string
    stale: string
    scanning: string
    failed: string
    scanFailedShape: string
    empty: string
    attention: string
    clean: string
    moreGaps: string
    runsAs: string
    uses: string
    noRuntimes: string
    noServices: string
    envLine: string
    envUnused: string
    codeHeader: string
    approximate: string
    noModules: string
    legend: string
    cycleLine: string
    orphans: string
    moreRows: string
    fanIn: string
    hotWord: string
    cycleWord: string
    provided: string
    notProvided: string
    defined: string
    undefined: string
    fileOk: string
    npxOffer: string
    npxAllow: string
    npxDeny: string
    npxOn: string
    npxOff: string
    buttons: { infra: string; code: string; gaps: string; rescan: string; export: string; explain: string; quit: string }
    gapTitle: Record<GapKind, string>
    gapFix: Record<GapKind, string>
    summaryHead: string
    summaryCode: string
    summaryRuns: string
    summaryNone: string
    gapsNone: string
    exported: string
    exportFailed: string
    explaining: string
    explained: string
    explainFailed: string
    explainBlank: string
    explainNoScan: string
    flowTitle: string
    opened: string
    notPlaced: string
    usage: string
    mdTitle: string
    mdAttention: string
    mdInfra: string
    mdCode: string
    mdCycles: string
    htmlTitle: string
    svgAlt: string
    svgTip: string
  }
}

declare module 'claude-code' {
  interface PluginState {
    atlas: {
      /** The last scan, or null before the first. */
      doc: Shaped<Atlas | null>
      /** The scanner's state and staleness. */
      status: Shaped<Status>
      /** The pane's view. */
      tab: Shaped<Tab>
      /** Model labels for the scan on hand, or null. */
      labels: Shaped<Labels | null>
      /** The clock at the last tick, so "scanned N ago" redraws. */
      now: Shaped<number>
    }
  }
}
