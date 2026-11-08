/**
 * Type contract for modernize: the tuning in `data/modernize.ts` (workspace
 * folders, artifact names, shard and fan-out caps, rule labels, verdict rules,
 * texts, the security and delta lists the agents work from) and the JSON
 * artifacts the commands and scripts read and write. The mod keeps nothing in
 * `$.state`; every artifact lives on disk under `analysis/<system>/`.
 */

/** The three workspace folders, relative to the workspace root. */
export interface Dirs {
  /** Where the old code sits (a copy or a link). Nothing writes here. */
  legacy: string
  /** Where every artifact of the analysis is written. */
  analysis: string
  /** Where built code goes (phase 2). */
  modernized: string
}

/** What a system name may be. */
export interface NameRule {
  /** Regex the whole name must match (`String.raw`). */
  pattern: string
  maxLength: number
}

/** Keys of the artifacts the mod knows. */
export type ArtifactKey =
  | 'intent'
  | 'assessment'
  | 'topology'
  | 'shards'
  | 'rules'
  | 'brief'
  | 'testRuns'
  | 'verification'
  | 'report'

/** One artifact: its JSON file, the Markdown rendered from it, and what it derives from. */
export interface Artifact {
  /** File name under `analysis/<system>/` (may hold one sub-folder). */
  file: string
  /** Markdown rendered from the JSON, beside it; absent when none is rendered. */
  md?: string
  /** Artifacts this one is built from: it is stale when any of them is newer. */
  from: ArtifactKey[]
}

/** A stage of the road, in order. */
export interface Stage {
  key: string
  /** Artifact whose presence marks the stage done. */
  artifact: ArtifactKey
  /** Command to run when this is the next stage, `{system}` filled in. */
  command: string
  /** One line on why, shown beside the next command. */
  why: string
  /** Other artifacts this stage rewrites: when one is stale, this stage is rerun. */
  covers?: ArtifactKey[]
}

/** Shard and fan-out tuning for the rules pass. */
export interface ShardTuning {
  /** A shard is filled with modules up to about this many lines. */
  targetLines: number
  /** Agents per batch, the default; clamped to [batchMin, batchMax]. */
  batchSize: number
  batchMin: number
  batchMax: number
  /** Above this many shards the command asks the person before fanning out. */
  askAboveShards: number
  /** Hard cap: more shards than this is refused (raise targetLines instead). */
  maxShards: number
  /** File extensions counted as code when a topology names a folder only. */
  codeExtensions: string[]
  /** Folder names never walked. */
  skipDirs: string[]
}

/** Rule-card tuning. */
export interface RuleTuning {
  /** Priority labels, most important first. The first is the one proof checks. */
  priorities: string[]
  confidences: string[]
  /** Id prefix and digit count: RULE-007. */
  idPrefix: string
  idDigits: number
  /** Regex that finds a rule id inside a test name; group 1 is the number (`String.raw`, case-insensitive). */
  testIdPattern: string
}

/** How bad a reason is: it caps the verdict at PARTLY PROVEN or NOT PROVEN. */
export type Severity = 'partly' | 'not'

/** Every reason the proof can give. */
export type ReasonCode =
  | 'noTestsRan'
  | 'testsFailed'
  | 'handTypedCount'
  | 'unparseableEvidence'
  | 'noCanary'
  | 'canaryNotCaught'
  | 'noEquivalence'
  | 'equivalenceDiffers'
  | 'missingOutput'
  | 'tooFewFreshInputs'
  | 'maskUnjustified'
  | 'maskInvalid'
  | 'toleranceUnjustified'
  | 'p0Untested'
  | 'p0NamedNotRun'
  | 'legacyNotRun'
  | 'legacyTouched'

/** One verdict rule: how bad the reason is and the line written into the output. */
export interface ReasonRule {
  severity: Severity
  /** The reason as written, `{…}` filled in. */
  text: string
}

/** Proof tuning. */
export interface ProofTuning {
  verdicts: { proven: string; partly: string; not: string }
  reasons: Record<ReasonCode, ReasonRule>
  /** At least this many distinct fresh inputs. */
  minFreshInputs: number
  /** Absolute float tolerance when a case declares none (0 means bytes must match after masks). */
  defaultTolerance: number
  /** What a masked span is replaced with on both sides. */
  maskToken: string
  /** File extensions read as test results inside a results folder. */
  resultExtensions: string[]
  /** Fields that, set on a suite by hand, are a typed count. */
  typedCountFields: string[]
  /** At most this many touched legacy files are named. */
  listMax: number
  /** Lines written into the output under "rules". */
  rulesPreamble: string[]
  /** What the proof does not prove, written into every output. */
  limits: string[]
}

/** A goal the front door can record. */
export interface Goal {
  key: string
  label: string
}

/** Advice the front door prints for settings.json. */
export interface Permissions {
  allow: string[]
  deny: string[]
}

/** The guard on edits into the legacy folder. */
export interface Guard {
  enabled: boolean
  /** Tool names whose file argument is checked. */
  tools: string[]
  /** Input fields that name the file. */
  pathFields: string[]
  /** Reason shown when an edit is refused; `{path}` and `{legacy}` filled in. */
  deny: string
}

/** Every line the scripts print or render. */
export interface Texts {
  /** Appended to a cut list, `{count}` items cut. */
  more: string
  /** Shape problems in an artifact, `{field}` (and `{options}`) filled in. */
  shape: Record<string, string>
  /** Why a citation does not hold. */
  citation: Record<string, string>
  usage: Record<string, string>
  /** Problems the prompt check reports, `{file}` and `{name}` filled in. */
  prompts: Record<string, string>
  /** Lines the scripts print on success. */
  cli: Record<string, string>
  errors: Record<string, string>
  status: Record<string, string>
  md: Record<string, string>
  report: Record<string, string>
}

/** The whole tuning. */
export interface Tuning {
  dirs: Dirs
  systemName: NameRule
  artifacts: Record<ArtifactKey, Artifact>
  /** Folder under analysis/<system>/ where rule-card JSON files are written, one per shard. */
  cardsDir: string
  /** Folder under analysis/<system>/ for test results and comparisons. */
  evidenceDir: string
  stages: Stage[]
  /** Stage shown after the brief is written and before a person approves it. */
  approve: Omit<Stage, 'artifact'>
  /** Stage shown when the brief is approved and nothing is built yet. */
  build: Omit<Stage, 'artifact'>
  /** Stage shown when a built module has no verdict, or an older one. */
  verify: Omit<Stage, 'artifact'>
  shard: ShardTuning
  rules: RuleTuning
  proof: ProofTuning
  goals: Goal[]
  /** Modernization patterns the assessment chooses from. */
  patterns: string[]
  /** Classes the security auditor checks, one finder pass per class. */
  vulnerabilityClasses: string[]
  /** Categories a version-delta catalogue sorts breaking changes into (phase 2). */
  deltaCategories: string[]
  permissions: Permissions
  guard: Guard
  /** What the prompt check allows. */
  prompts: {
    /** Tools an agent may list: the agents only read. */
    readOnlyTools: string[]
    /** The plugin's command namespace with its colon. */
    commandPrefix: string
    /** File names a prompt may name besides the artifacts and command files. */
    extraFiles: string[]
  }
  text: Texts
  /** Stylesheet of the offline report. */
  reportCss: string
}

// ---- Artifacts (JSON on disk). Commands write the first four; scripts the rest. ----

/** analysis/<system>/INTENT.json, written once by /modernize. */
export interface Intent {
  system: string
  goal: string
  from?: string
  to?: string
  mustStayTrue: string[]
  /** The person's answers word for word. */
  answers: Record<string, string>
  date: string
  openItems?: string[]
}

/** One file of a module. */
export interface TopoFile {
  path: string
  /** Line count; shard.mjs fills it from disk when absent. */
  lines?: number
}

/** One module of the legacy system. */
export interface TopoModule {
  name: string
  path?: string
  files: TopoFile[]
}

/** analysis/<system>/topology.json, written by /modernize-map. */
export interface Topology {
  system: string
  modules: TopoModule[]
  edges: { from: string; to: string; kind?: string }[]
  entryPoints?: string[]
  dataStores?: string[]
}

/** One shard: modules handed to one rules extractor. */
export interface Shard {
  id: string
  modules: string[]
  files: string[]
  lines: number
}

/** analysis/<system>/SHARDS.json, written by shard.mjs. */
export interface Shards {
  system: string
  targetLines: number
  batchSize: number
  shards: Shard[]
  batches: string[][]
  /** True when the shard count is above askAboveShards: ask before the fan-out. */
  ask: boolean
  /** Line count of every file, as counted: the topology keeps none, the report reads them here. */
  fileLines: Record<string, number>
}

/** One rule card as an extractor returns it. */
export interface Card {
  name: string
  priority: string
  confidence: string
  given: string
  when: string
  then: string
  /** `path:line` citations, path relative to legacy/<system>. */
  citations: string[]
  module?: string
}

/** A card after rules-index: numbered, its citations checked. */
export interface Rule extends Card {
  id: string
  /** Shards the card came from (several when duplicates were folded). */
  sources: string[]
  /** Citations that did not hold, with why. */
  badCitations: { citation: string; why: string }[]
}

/** analysis/<system>/RULES.json, written by rules-index.mjs. */
export interface RulesIndex {
  system: string
  rules: Rule[]
  folded: number
  rejected: { source: string; index: number; why: string }[]
}

/** analysis/<system>/ASSESSMENT.json, written by /modernize-assess. */
export interface Assessment {
  system: string
  languages: { name: string; files: number; lines: number }[]
  entryPoints: string[]
  debt: { item: string; severity: string; where: string }[]
  security: { class: string; severity: string; where: string; note: string }[]
  pattern: { choice: string; why: string }
  risks: string[]
}

/** A suite or canary run named in test-runs.json. */
export interface RunEntry {
  module: string
  name?: string
  command?: string
  /** Result files or folders (JUnit XML, TRX, JSON per-test lists), relative to the workspace root. */
  results: string[]
  note?: string
  /** Canaries: what was broken. */
  change?: string
  /** Any other field (a typed `passed: 12`) is read only to reject it. */
  [extra: string]: unknown
}

/** One comparison case: one output of the old and the new code. */
export interface Case {
  id: string
  /** The input this output came from; fresh inputs are counted by it. */
  input: string
  fresh?: boolean
  /** Paths relative to the cases file's folder. */
  legacy: string
  new: string
  masks?: { pattern: string; why: string }[]
  tolerance?: { abs: number; why: string }
  /** A person's reason for accepting a difference. */
  approved?: string
}

/** analysis/<system>/evidence/test-runs.json, written by /modernize-verify. */
export interface TestRuns {
  date: string
  legacy: { ran: boolean; how?: string; why?: string }
  suites: RunEntry[]
  canaries: RunEntry[]
  /** Cases files (paths relative to the workspace root), each `{ module, cases: Case[] }`. */
  comparisons: string[]
  /** Rules each module must implement; absent means the P0 rules whose module matches. */
  moduleRules?: Record<string, string[]>
}

/** One test as read from a result file. */
export interface TestResult {
  name: string
  className: string
  status: 'passed' | 'failed' | 'skipped'
  file: string
}

/** One reason in a verdict. */
export interface Reason {
  code: ReasonCode
  severity: Severity
  text: string
}

/** One module's verdict. */
export interface ModuleVerdict {
  module: string
  verdict: string
  reasons: Reason[]
  tests: { passed: number; failed: number; skipped: number; files: string[] }
  canary: { runs: number; caught: number }
  cases: { total: number; same: number; differ: number; approved: number; freshInputs: number }
  masks: { pattern: string; why: string; case: string }[]
  tolerances: { abs: number; why: string; case: string }[]
  p0: { id: string; state: 'tested' | 'namedNotRun' | 'untested' }[]
}

/** analysis/<system>/VERIFICATION.json, written by proof.mjs. */
export interface Verification {
  system: string
  date: string
  rules: string[]
  limits: string[]
  modules: ModuleVerdict[]
  legacyTouched: string[]
  signoff: { by: string; date: string }
}

/** analysis/<system>/BRIEF.json, written by /modernize-brief. */
export interface Brief {
  system: string
  goal: string
  target: string
  phases: { name: string; modules: { name: string; rules: string[] }[]; exit: string[] }[]
  risks: string[]
  questions: string[]
  approval: { by: string; date: string }
}
