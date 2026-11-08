//! atlas scanner: reads a repository and prints one JSON "atlas" document.
//!
//! The hooks module has no file system walk, no glob and a 4 MiB read cap, so
//! the scan runs here, in plain Node, started by `$.process.run(['node',
//! script])` with a JSON request on stdin (mode, root, budgets, tool argv: all
//! from `data/atlas.ts`). Every rule it applies (packages per service, env
//! patterns, entry points, glue types) comes from `data/signals.json`, the file
//! the hooks read too. Nothing here is tunable on its own.
//!
//! Two modes: `key` prints `{ key }` (HEAD plus the key files' sizes and
//! times, cheap, for the cache), `scan` prints the whole document.
//!
//! Safety: `.env` files are read for NAMES only; each value is dropped as the
//! line is split and never leaves this process. Outside tools run without a
//! shell, except the Windows `.cmd` shims the request names (npx, docker),
//! which cannot start without one.

import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const signals = JSON.parse(fs.readFileSync(path.join(here, '..', 'data', 'signals.json'), 'utf8'))

/** Gap kinds in the order a person should read them: the warnings (secret, unprovisioned, envMissing) first. Structural: the contract's GapKind members. */
const KIND_RANK = ['secret', 'unprovisioned', 'envMissing', 'apiKey', 'unused', 'envOptional', 'envUndocumented', 'envUnused']

// ---------------------------------------------------------------- helpers

/** Forward slashes, no leading `./`: every path in the document looks the same on every OS. */
function slash(p) {
  return p.split(path.sep).join('/').replace(/^\.\//, '')
}

/** A basename glob (`*.csproj`, `compose*.yml`) as an anchored regex. */
function globRe(glob) {
  return new RegExp('^' + glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
}

/** 1-based line of a character offset, by binary search over newline offsets. */
function lineFinder(text) {
  const starts = [0]
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1)
  return offset => {
    let lo = 0
    let hi = starts.length - 1
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1
      if (starts[mid] <= offset) lo = mid
      else hi = mid - 1
    }
    return lo + 1
  }
}

/** 1-based line of the first line containing `needle`, or 1. */
function lineOf(text, needle) {
  const at = text.indexOf(needle)
  return at < 0 ? 1 : text.slice(0, at).split('\n').length
}

/** Runs a tool by argv. Shims (npx, docker) need a shell on Windows; nothing else gets one. */
function run(argv, cwd, timeoutMs, shims) {
  const needsShell = process.platform === 'win32' && shims.includes(argv[0])
  const r = spawnSync(argv[0], argv.slice(1), { cwd, timeout: timeoutMs, encoding: 'utf8', shell: needsShell, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
  return { ok: r.status === 0 && !r.error, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error.message) : '') }
}

/** True when one of the regex sources matches the name. */
function matchesAny(name, sources) {
  return sources.some(s => new RegExp(s).test(name))
}

/** Adds evidence to a keyed list, at most once per file:line. */
function addEvidence(map, key, ev) {
  const list = map.get(key) ?? []
  if (!list.some(e => e.file === ev.file && e.line === ev.line)) list.push(ev)
  map.set(key, list)
}

// ---------------------------------------------------------------- files

/** Is any folder on the path one the scan skips? */
function isSkipped(rel) {
  const parts = rel.split('/')
  return parts.slice(0, -1).some(p => signals.skipDirs.includes(p))
}

/** The repo's files: git's view (tracked plus untracked, ignored left out), else a walk. */
function listFiles(root, req) {
  const git = run([req.tools.git, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], root, req.tools.timeoutMs, [])
  const tracked = new Set()
  let files = []
  if (git.ok) {
    files = git.stdout.split('\0').filter(Boolean)
    const cached = run([req.tools.git, 'ls-files', '-z', '--cached'], root, req.tools.timeoutMs, [])
    if (cached.ok) for (const f of cached.stdout.split('\0').filter(Boolean)) tracked.add(f)
  } else {
    const walk = dir => {
      for (const d of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
        const rel = dir === '' ? d.name : `${dir}/${d.name}`
        if (d.isDirectory()) {
          if (!signals.skipDirs.includes(d.name)) walk(rel)
        } else if (d.isFile()) files.push(rel)
        if (files.length >= req.budgets.files) return
      }
    }
    walk('')
  }
  files = [...new Set(files)].filter(f => !isSkipped(f) && fs.existsSync(path.join(root, f))).sort()
  return { files: files.slice(0, req.budgets.files), tracked, isGit: git.ok }
}

/** The cache key: HEAD, the file count, and each key file's size and time. */
function cacheKey(root, files, head) {
  const res = signals.keyFiles.map(globRe)
  const parts = [head ?? '-', String(files.length)]
  for (const f of files) {
    if (!res.some(r => r.test(path.posix.basename(f)))) continue
    const st = fs.statSync(path.join(root, f))
    parts.push(`${f}:${st.size}:${Math.round(st.mtimeMs)}`)
  }
  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 16)
}

// ---------------------------------------------------------------- the scan

function scan(req) {
  const start = path.resolve(req.root || process.cwd())
  const top = run([req.tools.git, 'rev-parse', '--show-toplevel'], start, req.tools.timeoutMs, [])
  const root = top.ok ? path.resolve(top.stdout.trim()) : start
  const headRun = run([req.tools.git, 'rev-parse', '--short', 'HEAD'], root, req.tools.timeoutMs, [])
  const head = headRun.ok ? headRun.stdout.trim() : null
  const { files, tracked, isGit } = listFiles(root, req)
  const key = cacheKey(root, files, head)
  if (req.mode === 'key') return { key }

  const notes = []
  const fileSet = new Set(files)
  const langOf = new Map()
  for (const f of files) {
    const ext = path.posix.extname(f).toLowerCase()
    for (const [lang, exts] of Object.entries(signals.sourceExtensions)) if (exts.includes(ext)) langOf.set(f, lang)
  }
  const texts = new Map()
  /** Reads a file once; files over the size cap read as empty. */
  const textOf = f => {
    if (texts.has(f)) return texts.get(f)
    let t = ''
    try {
      const abs = path.join(root, f)
      if (fs.statSync(abs).size <= signals.maxFileBytes) t = fs.readFileSync(abs, 'utf8')
    } catch {
      t = ''
    }
    texts.set(f, t)
    return t
  }
  const base = f => path.posix.basename(f)
  const dirOf = f => (f.includes('/') ? f.slice(0, f.lastIndexOf('/')) : '')

  const implied = new Map() // service id -> Evidence[]
  const provided = new Map()
  const envRead = new Map() // name -> Evidence
  const envDefined = new Map() // name -> { ev, source }
  const exampleNames = new Set()
  let hasExample = false
  const imageEnv = new Set()
  const runtimes = []
  const entries = [] // { file, line, text }
  const units = [] // { dir, name, file, kind }
  const fileEdges = [] // { from, to, line, text, source }
  const secrets = []
  const services = signals.services
  const envIgnore = new Set(signals.envIgnore)

  // Names whose every read has a fallback (`?? x`, `getenv("X", d)`): optional, not missing.
  const optionalOnly = new Map()
  const noteRead = (name, ev, isOptional = false) => {
    if (envIgnore.has(name)) return
    if (!envRead.has(name)) envRead.set(name, ev)
    optionalOnly.set(name, (optionalOnly.get(name) ?? true) && isOptional)
  }
  const noteDefined = (name, ev, source) => {
    if (!envDefined.has(name) || (envDefined.get(name).source === 'example' && source !== 'example')) envDefined.set(name, { ev, source })
  }
  /** A package name seen in an ecosystem's manifest: which services does it imply? */
  const notePackage = (eco, name, rest, ev) => {
    for (const s of services) {
      for (const spec of s.packages[eco] ?? []) {
        const [pkg, feature] = spec.split(':')
        if (pkg.toLowerCase() !== name.toLowerCase()) continue
        if (feature !== undefined && !rest.toLowerCase().includes(feature)) continue
        addEvidence(implied, s.id, ev)
      }
    }
  }
  /** An image name: which services does it provide? Tags and registries are ignored. */
  const imageServices = image => {
    const bare = image.replace(/["']/g, '').split('@')[0].replace(/:[^/:]*$/, '').toLowerCase()
    return services.filter(s => s.images.some(i => bare === i.toLowerCase() || bare.endsWith('/' + i.toLowerCase())))
  }

  // ---- env files: names only
  const envFileRe = new RegExp(signals.envFiles.pattern)
  const exampleRes = signals.envFiles.examples.map(s => new RegExp(s))
  for (const f of files) {
    if (!envFileRe.test(base(f))) continue
    const isExample = exampleRes.some(r => r.test(base(f)))
    if (isExample) hasExample = true
    if (!isExample && tracked.has(f)) secrets.push({ file: f, line: 1, text: signals.words.tracked })
    const lines = textOf(f).split(/\r?\n/)
    lines.forEach((raw, i) => {
      // The name is everything before `=`; the value is dropped right here.
      const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(raw)
      if (m === null) return
      const ev = { file: f, line: i + 1, text: `${m[1]}` }
      if (isExample) exampleNames.add(m[1])
      noteDefined(m[1], ev, isExample ? 'example' : 'dotenv')
    })
    texts.delete(f)
  }

  // ---- manifests: units, packages, entry points
  const crateIdents = new Map() // rust crate ident -> src dir
  let goModule = null
  let goModuleDir = ''
  for (const f of files) {
    const b = base(f)
    const dir = dirOf(f)
    if (b === 'package.json') {
      let pkg
      try {
        pkg = JSON.parse(textOf(f))
      } catch {
        continue
      }
      const t = textOf(f)
      units.push({ dir, name: pkg.name ?? (dir || path.basename(root)), file: f, kind: 'npm' })
      for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
        for (const name of Object.keys(pkg[field] ?? {})) {
          notePackage('npm', name, '', { file: f, line: lineOf(t, `"${name}"`), text: `${name}` })
        }
      }
      const unitName = pkg.name ?? (dir || path.basename(root))
      if (typeof pkg.bin === 'string' || (pkg.bin && typeof pkg.bin === 'object')) {
        runtimes.push({ name: unitName, how: signals.words.runtimes.bin, file: f, line: lineOf(t, '"bin"') })
      }
      if (pkg.scripts?.start) runtimes.push({ name: unitName, how: signals.words.runtimes.npmStart, file: f, line: lineOf(t, '"start"') })
      const mainFile = typeof pkg.main === 'string' ? slash(path.posix.join(dir, pkg.main)) : null
      if (mainFile && fileSet.has(mainFile)) entries.push({ file: mainFile, line: 1, text: signals.words.packageMain })
    } else if (b === 'Cargo.toml') {
      const t = textOf(f)
      let section = ''
      let crate = null
      const lines = t.split(/\r?\n/)
      lines.forEach((raw, i) => {
        const line = raw.trim()
        const head = /^\[([^\]]+)\]$/.exec(line)
        if (head) {
          section = head[1]
          // `[dependencies.sqlx]`: the features sit on the lines below, up to the next table.
          const dep = /^(?:dev-|build-)?dependencies\.([A-Za-z0-9_-]+)$/.exec(section)
          if (dep) {
            const next = lines.findIndex((l, j) => j > i && l.trim().startsWith('['))
            const body = lines.slice(i + 1, next < 0 ? undefined : next).join(' ')
            notePackage('cargo', dep[1], body, { file: f, line: i + 1, text: `${dep[1]}` })
          }
          return
        }
        if (line === '[[bin]]') {
          runtimes.push({ name: crate ?? (dir || path.basename(root)), how: signals.words.runtimes.cargoBin, file: f, line: i + 1 })
          return
        }
        if (section === 'package') {
          const n = /^name\s*=\s*"([^"]+)"/.exec(line)
          if (n) crate = n[1]
        }
        if (/^(dev-|build-)?dependencies$/.test(section) || /^target\..*dependencies$/.test(section)) {
          const d = /^([A-Za-z0-9_-]+)\s*=(.*)$/.exec(line)
          if (d) notePackage('cargo', d[1], d[2], { file: f, line: i + 1, text: `${d[1]}${d[2].includes('features') ? ' ' + (d[2].match(/features\s*=\s*\[([^\]]*)\]/)?.[1] ?? '').replace(/["\s]/g, '') : ''}` })
        }
      })
      if (crate !== null) {
        units.push({ dir, name: crate, file: f, kind: 'cargo' })
        crateIdents.set(crate.replace(/-/g, '_'), dir === '' ? 'src' : `${dir}/src`)
        const mainRs = dir === '' ? 'src/main.rs' : `${dir}/src/main.rs`
        if (fileSet.has(mainRs)) runtimes.push({ name: crate, how: signals.words.runtimes.rustMain, file: mainRs, line: 1 })
      }
    } else if (/\.csproj$/i.test(b)) {
      const t = textOf(f)
      const name = b.replace(/\.csproj$/i, '')
      units.push({ dir, name, file: f, kind: 'csproj' })
      for (const m of t.matchAll(/<PackageReference\s+Include="([^"]+)"/g)) {
        notePackage('nuget', m[1], '', { file: f, line: lineOf(t, m[0]), text: `${m[1]}` })
      }
      for (const m of t.matchAll(/<ProjectReference\s+Include="([^"]+)"/g)) {
        const target = slash(path.posix.normalize(path.posix.join(dir, m[1].replace(/\\/g, '/'))))
        if (fileSet.has(target)) fileEdges.push({ from: f, to: target, line: lineOf(t, m[0]), text: base(target), source: 'csproj' })
      }
      if (/<OutputType>\s*Exe\s*<\/OutputType>/i.test(t)) runtimes.push({ name, how: signals.words.runtimes.dotnetExe, file: f, line: lineOf(t, '<OutputType>') })
      if (/Sdk="Microsoft\.NET\.Sdk\.(Web|Worker)"/.test(t)) runtimes.push({ name, how: /Web/.test(t) ? signals.words.runtimes.aspnet : signals.words.runtimes.worker, file: f, line: 1 })
    } else if (/^requirements.*\.txt$/.test(b)) {
      textOf(f).split(/\r?\n/).forEach((raw, i) => {
        const m = /^\s*([A-Za-z0-9_.-]+)/.exec(raw)
        if (m && !raw.trim().startsWith('#')) notePackage('pypi', m[1], raw, { file: f, line: i + 1, text: `${m[1]}` })
      })
    } else if (b === 'pyproject.toml') {
      const t = textOf(f)
      const n = /^\s*name\s*=\s*"([^"]+)"/m.exec(t)
      units.push({ dir, name: n ? n[1] : dir || path.basename(root), file: f, kind: 'python' })
      t.split(/\r?\n/).forEach((raw, i) => {
        const m = /^\s*"([A-Za-z0-9_.-]+)\s*(?:[<>=~!;[ ].*)?",?\s*$/.exec(raw) ?? /^([A-Za-z0-9_.-]+)\s*=\s*["{]/.exec(raw)
        if (m) notePackage('pypi', m[1], raw, { file: f, line: i + 1, text: `${m[1]}` })
      })
    } else if (b === 'go.mod') {
      const t = textOf(f)
      const mod = /^module\s+(\S+)/m.exec(t)
      if (mod) {
        goModule = mod[1]
        goModuleDir = dir
        units.push({ dir, name: mod[1].split('/').pop(), file: f, kind: 'go' })
      }
      t.split(/\r?\n/).forEach((raw, i) => {
        const m = /^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/[^\s]+)\s+v/.exec(raw)
        if (!m) return
        for (const s of services) for (const p of s.packages.go ?? []) if (m[1] === p || m[1].startsWith(p + '/')) addEvidence(implied, s.id, { file: f, line: i + 1, text: `${m[1]}` })
      })
    } else if (b === 'plugin.json' && dir.endsWith('.claude-plugin')) {
      let name = dirOf(dir) || path.basename(root)
      try {
        name = JSON.parse(textOf(f)).name ?? name
      } catch {
        // a broken manifest still marks the folder as a plugin
      }
      units.push({ dir: dirOf(dir), name, file: f, kind: 'plugin' })
      runtimes.push({ name, how: signals.words.runtimes.plugin, file: f, line: 1 })
    } else if (b === 'schema.prisma') {
      const t = textOf(f)
      const p = /datasource\s+\w+\s*\{[^}]*provider\s*=\s*"([^"]+)"/.exec(t)
      if (p) for (const s of services) if (s.prisma.includes(p[1])) addEvidence(implied, s.id, { file: f, line: lineOf(t, p[0].split('\n').find(l => l.includes('provider')) ?? 'provider'), text: `prisma ${p[1]}` })
      for (const m of t.matchAll(/env\(\s*"([A-Za-z_][A-Za-z0-9_]*)"\s*\)/g)) noteRead(m[1], { file: f, line: lineOf(t, m[0]), text: `${m[1]}` })
    }
  }

  // ---- declared infra: compose, Dockerfile, Procfile, platform files, workflows, k8s, Terraform
  const composeRe = /^(docker-)?compose.*\.ya?ml$/
  const yamlServices = []
  for (const f of files) {
    const b = base(f)
    if (!composeRe.test(b)) continue
    const t = textOf(f)
    const lines = t.split(/\r?\n/)
    let inServices = false
    let svc = null
    let block = ''
    let blockIndent = -1
    const finish = () => {
      if (svc) yamlServices.push(svc)
      svc = null
    }
    lines.forEach((raw, i) => {
      if (/^\S/.test(raw)) {
        finish()
        inServices = /^services\s*:/.test(raw)
        return
      }
      if (!inServices || raw.trim() === '' || raw.trim().startsWith('#')) return
      const indent = raw.length - raw.trimStart().length
      const svcHead = /^ {1,4}([A-Za-z0-9_.-]+)\s*:\s*$/.exec(raw)
      if (svcHead && (svc === null || indent <= svc.indent)) {
        finish()
        svc = { name: svcHead[1], indent, file: f, line: i + 1, image: null, build: false, ports: [], env: [] }
        block = ''
        return
      }
      if (svc === null) return
      const kv = /^\s*([A-Za-z_]+)\s*:\s*(.*)$/.exec(raw)
      if (kv && indent > svc.indent && (blockIndent < 0 || indent <= blockIndent)) {
        block = kv[1]
        blockIndent = indent
        if (kv[1] === 'image') svc.image = { value: kv[2].trim(), line: i + 1 }
        if (kv[1] === 'build') svc.build = true
        return
      }
      if (block === 'ports') {
        const p = /^\s*-\s*["']?(?:[\d.]+:)?(\d+)(?::(\d+))?/.exec(raw)
        if (p) svc.ports.push(p[1])
      }
      if (block === 'environment') {
        const item = /^\s*-\s*["']?([A-Za-z_][A-Za-z0-9_]*)\s*[=:"']?/.exec(raw) ?? /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:/.exec(raw)
        if (item) svc.env.push({ name: item[1], line: i + 1 })
      }
    })
    finish()
    // `${VAR}` interpolation: the compose file reads that env name.
    for (const m of t.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?:[:?-][^}]*)?\}/g)) noteRead(m[1], { file: f, line: lineOf(t, m[0]), text: `${m[1]}` })
    // Normalise with docker when it is there: it follows extends, profiles and includes.
    const argv = req.tools.compose.map(a => a.replace('{file}', f))
    const normal = run(argv, root, req.tools.timeoutMs, req.tools.shims)
    if (normal.ok) {
      try {
        const doc = JSON.parse(normal.stdout)
        for (const [name, s] of Object.entries(doc.services ?? {})) {
          if (yamlServices.some(y => y.file === f && y.name === name)) continue
          yamlServices.push({ name, indent: 2, file: f, line: lineOf(t, `${name}:`), image: s.image ? { value: s.image, line: lineOf(t, `${name}:`) } : null, build: Boolean(s.build), ports: [], env: Object.keys(s.environment ?? {}).map(n => ({ name: n, line: lineOf(t, n) })) })
        }
      } catch {
        notes.push(`docker compose config gave no JSON for ${f}`)
      }
    }
  }
  for (const s of yamlServices) {
    const matched = s.image ? imageServices(s.image.value) : []
    for (const svc of matched) addEvidence(provided, svc.id, { file: s.file, line: s.image.line, text: `${s.name} (${s.image.value})` })
    for (const e of s.env) {
      noteDefined(e.name, { file: s.file, line: e.line, text: `${e.name}` }, 'compose')
      // An image's own settings (POSTGRES_PASSWORD) are for the image, not the code.
      if (s.image && !s.build) imageEnv.add(e.name)
    }
    if (s.build) runtimes.push({ name: s.name, how: withPort(signals.words.runtimes.compose, s.ports[0]), file: s.file, line: s.line })
  }

  for (const f of files) {
    const b = base(f)
    const t = () => textOf(f)
    if (/^Dockerfile(\..+)?$|\.Dockerfile$/.test(b)) {
      const text = t()
      const expose = /^\s*EXPOSE\s+(\d+)/im.exec(text)
      const name = dirOf(f).split('/').pop() || path.basename(root)
      runtimes.push({ name, how: withPort(signals.words.runtimes.dockerfile, expose?.[1]), file: f, line: expose ? lineOf(text, expose[0]) : 1 })
      for (const m of text.matchAll(/^\s*FROM\s+(\S+)/gim)) for (const s of imageServices(m[1])) addEvidence(provided, s.id, { file: f, line: lineOf(text, m[0]), text: `FROM ${m[1]}` })
      for (const m of text.matchAll(/^\s*(?:ENV|ARG)\s+([A-Za-z_][A-Za-z0-9_]*)/gim)) noteDefined(m[1], { file: f, line: lineOf(text, m[0]), text: `${m[1]}` }, 'docker')
    } else if (b === 'Procfile') {
      t().split(/\r?\n/).forEach((raw, i) => {
        const m = /^([A-Za-z0-9_-]+)\s*:/.exec(raw)
        if (m) runtimes.push({ name: m[1], how: signals.words.runtimes.procfile, file: f, line: i + 1 })
      })
    } else if (b === 'fly.toml' || b === 'wrangler.toml') {
      const text = t()
      const app = /^\s*(?:app|name)\s*=\s*"([^"]+)"/m.exec(text)
      runtimes.push({ name: app ? app[1] : dirOf(f) || path.basename(root), how: b === 'fly.toml' ? signals.words.runtimes.fly : signals.words.runtimes.wrangler, file: f, line: app ? lineOf(text, app[0]) : 1 })
      let inVars = false
      text.split(/\r?\n/).forEach((raw, i) => {
        const h = /^\s*\[([^\]]+)\]/.exec(raw)
        if (h) inVars = h[1] === 'env' || h[1] === 'vars'
        const kv = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(raw)
        if (inVars && kv) noteDefined(kv[1], { file: f, line: i + 1, text: `${kv[1]}` }, 'platform')
      })
    } else if (b === 'vercel.json' || b === 'serverless.yml' || b === 'netlify.toml') {
      runtimes.push({ name: dirOf(f) || path.basename(root), how: b.replace(/\.(json|yml|toml)$/, ''), file: f, line: 1 })
    } else if (/^\.github\/workflows\/.+\.ya?ml$/.test(f)) {
      const text = t()
      for (const d of signals.deploySteps) {
        const m = new RegExp(d.pattern).exec(text)
        if (m) runtimes.push({ name: base(f).replace(/\.ya?ml$/, ''), how: signals.words.runtimes.deploysTo.replace('{name}', d.name), file: f, line: lineOf(text, m[0]) })
      }
      for (const m of text.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g)) noteDefined(m[1], { file: f, line: lineOf(text, m[0]), text: signals.words.ciSecret.replace('{name}', m[1]) }, 'ci')
    } else if (/\.ya?ml$/.test(b) && !composeRe.test(b)) {
      const text = t()
      if (!/^apiVersion\s*:/m.test(text)) continue
      const kind = /^kind\s*:\s*(\w+)/m.exec(text)
      if (!kind || !signals.k8sKinds.includes(kind[1])) continue
      const name = /^\s{2}name\s*:\s*(\S+)/m.exec(text)
      runtimes.push({ name: name ? name[1] : b, how: signals.words.runtimes.k8s.replace('{kind}', kind[1]), file: f, line: lineOf(text, kind[0]) })
      for (const m of text.matchAll(/^\s*image\s*:\s*(\S+)/gm)) for (const s of imageServices(m[1])) addEvidence(provided, s.id, { file: f, line: lineOf(text, m[0]), text: `${m[1]}` })
      for (const m of text.matchAll(/^\s*-\s*name\s*:\s*([A-Z_][A-Z0-9_]*)\s*$/gm)) noteDefined(m[1], { file: f, line: lineOf(text, m[0]), text: `${m[1]}` }, 'k8s')
    } else if (/\.tf$/.test(b)) {
      const text = t()
      for (const m of text.matchAll(/^\s*resource\s+"([^"]+)"\s+"([^"]+)"/gm)) {
        if (matchesAny(m[1], signals.terraformGlue)) continue
        for (const s of services) if (matchesAny(m[1], s.terraform)) addEvidence(provided, s.id, { file: f, line: lineOf(text, m[0]), text: `${m[1]}.${m[2]}` })
      }
    } else if (/\.tfstate$/.test(b)) {
      try {
        const state = JSON.parse(t())
        for (const r of state.resources ?? []) {
          if (matchesAny(r.type, signals.terraformGlue)) continue
          for (const s of services) if (matchesAny(r.type, s.terraform)) addEvidence(provided, s.id, { file: f, line: 1, text: signals.words.inState.replace('{name}', `${r.type}.${r.name}`) })
        }
      } catch {
        notes.push(`${f} is not JSON`)
      }
    }
  }

  // ---- entry files from the data patterns
  for (const e of signals.entries) {
    const re = new RegExp(e.file)
    for (const f of files) if (re.test(f)) entries.push({ file: f, line: 1, text: e.kind })
  }

  // ---- source files: env reads, schemes, imports, entry lines, file refs, lines
  const envFallbackRes = Object.fromEntries(Object.entries(signals.envFallback.after).map(([l, s]) => [l, new RegExp(s)]))
  const envAlternateRes = Object.fromEntries(Object.entries(signals.envFallback.before).map(([l, s]) => [l, new RegExp(s)]))
  const envReadRes = Object.fromEntries(Object.entries(signals.envReads).map(([l, list]) => [l, list.map(s => new RegExp(s, 'gm'))]))
  const importRes = Object.fromEntries(Object.entries(signals.imports).filter(([l]) => l !== 'csharpTypes').map(([l, list]) => [l, list.map(s => new RegExp(s, 'gm'))]))
  const schemeList = services.flatMap(s => s.schemes.map(sc => ({ sc, id: s.id })))
  const schemeRe = schemeList.length ? new RegExp(`\\b(${schemeList.map(x => x.sc.replace(/[+]/g, '\\+')).join('|')})://`, 'g') : null
  const testRes = signals.testFiles.map(s => new RegExp(s))
  const entryLineRes = signals.entryLines.map(e => ({ ...e, re: new RegExp(e.pattern) }))
  const fileRefRe = new RegExp(signals.fileRefs.pattern, 'g')
  const skipRefs = new Set(signals.fileRefs.skipBasenames)
  const lineCount = new Map()
  const csTypes = new Map() // type name -> file
  const csFiles = []
  const fileRefs = [] // { file, line, target }

  /** Resolves a JS specifier to a repo file, or null for packages and misses. */
  const resolveJs = (from, spec) => {
    if (!spec.startsWith('.')) {
      const unit = units.find(u => u.kind === 'npm' && u.dir !== '' && (spec === u.name || spec.startsWith(u.name + '/')))
      if (!unit) return null
      return files.find(f => f.startsWith(unit.dir + '/') && langOf.get(f) === 'js') ?? null
    }
    const joined = path.posix.normalize(path.posix.join(dirOf(from), spec))
    const stems = [joined, joined.replace(/\.(m|c)?js$/, '')]
    for (const stem of stems) for (const suf of signals.jsResolve) if (fileSet.has(stem + suf)) return stem + suf
    return null
  }
  /** The file a Rust module path names, from a directory that holds module files. */
  const rustFile = (dir, mod) => [`${dir}/${mod}.rs`, `${dir}/${mod}/mod.rs`].map(p => p.replace(/^\//, '')).find(p => fileSet.has(p)) ?? null
  /** A Python module path (dotted or relative) as a repo file. */
  const resolvePy = (from, spec) => {
    let dir
    let rest
    if (spec.startsWith('.')) {
      const dots = /^\.+/.exec(spec)[0].length
      dir = dirOf(from)
      for (let i = 1; i < dots; i++) dir = dirOf(dir)
      rest = spec.slice(dots)
    } else {
      dir = ''
      rest = spec
    }
    const parts = rest.split('.').filter(Boolean)
    const roots = spec.startsWith('.') ? [dir] : ['', 'src']
    for (const r of roots) {
      for (let n = parts.length; n > 0; n--) {
        const p = [r, ...parts.slice(0, n)].filter(Boolean).join('/')
        for (const c of [`${p}.py`, `${p}/__init__.py`]) if (fileSet.has(c) && c !== from) return c
      }
    }
    return null
  }

  for (const f of files) {
    const lang = langOf.get(f)
    if (lang === undefined) continue
    const text = textOf(f)
    const at = lineFinder(text)
    lineCount.set(f, text === '' ? 0 : text.split('\n').length)
    const fallback = envFallbackRes[lang]
    const alternate = envAlternateRes[lang]
    for (const re of envReadRes[lang] ?? []) {
      re.lastIndex = 0
      for (const m of text.matchAll(re)) {
        // Optional when a default follows (`X ?? 'info'`) or it is itself the fallback (`flag ?? X`).
        const after = text.slice(m.index + m[0].length, m.index + m[0].length + 40)
        const before = text.slice(Math.max(0, m.index - 40), m.index)
        const isOptional = (fallback !== undefined && fallback.test(after)) || (alternate !== undefined && alternate.test(before))
        noteRead(m[1], { file: f, line: at(m.index), text: `${m[1]}` }, isOptional)
      }
    }
    // A name the code sets for itself or a child process (`env: { ...process.env, X: '1' }`) is defined.
    const defs = signals.envDefines[lang]
    if (defs !== undefined) {
      for (const s of defs.assign) for (const m of text.matchAll(new RegExp(s, 'gm'))) noteDefined(m[1], { file: f, line: at(m.index), text: `${m[1]}` }, 'code')
      if (defs.block !== undefined) {
        for (const b of text.matchAll(new RegExp(defs.block, 'g'))) {
          for (const k of b[1].matchAll(new RegExp(defs.key, 'g'))) noteDefined(k[1], { file: f, line: at(b.index + b[0].indexOf(b[1]) + k.index), text: `${k[1]}` }, 'code')
        }
      }
    }
    // A connection string in a test is a fixture, not a dependency.
    if (schemeRe && !testRes.some(r => r.test(f))) {
      for (const m of text.matchAll(schemeRe)) {
        const id = schemeList.find(x => x.sc === m[1])?.id
        if (id) addEvidence(implied, id, { file: f, line: at(m.index), text: `${m[1]}://` })
      }
    }
    for (const e of entryLineRes) {
      if (!e.langs.includes(lang)) continue
      const m = e.re.exec(text)
      if (m) entries.push({ file: f, line: at(m.index), text: e.kind })
    }
    for (const m of text.matchAll(fileRefRe)) {
      const target = m[1]
      if (skipRefs.has(path.posix.basename(target))) continue
      const hit = fileSet.has(target) ? target : files.find(x => x.endsWith('/' + target) && x.startsWith(dirOf(f).split('/')[0]))
      if (hit && hit !== f) fileRefs.push({ file: f, line: at(m.index), target: hit })
    }
    if (lang === 'js') {
      for (const re of importRes.js) {
        for (const m of text.matchAll(re)) {
          const to = resolveJs(f, m[1])
          if (to && to !== f) fileEdges.push({ from: f, to, line: at(m.index), text: base(to), source: 'regex', lang })
        }
      }
    } else if (lang === 'rust') {
      const isRootish = /(^|\/)(lib|main|mod)\.rs$/.test(f)
      const own = isRootish ? dirOf(f) : f.replace(/\.rs$/, '')
      const [modRe, crateRe] = importRes.rust
      for (const m of text.matchAll(modRe)) {
        const to = rustFile(own, m[1])
        if (to) fileEdges.push({ from: f, to, line: at(m.index), text: base(to), source: 'regex', lang })
      }
      const srcDir = [...crateIdents.values()].find(d => f.startsWith(d + '/')) ?? 'src'
      for (const m of text.matchAll(crateRe)) {
        const to = rustFile(srcDir, m[1])
        if (to && to !== f) fileEdges.push({ from: f, to, line: at(m.index), text: base(to), source: 'regex', lang })
      }
      for (const [ident, dir] of crateIdents) {
        for (const m of text.matchAll(new RegExp(`\\b${ident}::([a-z_][a-z0-9_]*)`, 'g'))) {
          const to = rustFile(dir, m[1])
          if (to && to !== f) fileEdges.push({ from: f, to, line: at(m.index), text: base(to), source: 'regex', lang })
        }
      }
    } else if (lang === 'python') {
      for (const re of importRes.python) {
        for (const m of text.matchAll(re)) {
          const to = resolvePy(f, m[1])
          if (to && to !== f) fileEdges.push({ from: f, to, line: at(m.index), text: base(to), source: 'regex', lang })
        }
      }
    } else if (lang === 'go') {
      for (const re of importRes.go) {
        for (const m of text.matchAll(re)) {
          if (!goModule || !m[1].startsWith(goModule + '/')) continue
          const dir = [goModuleDir, m[1].slice(goModule.length + 1)].filter(Boolean).join('/')
          const to = files.find(x => dirOf(x) === dir && x.endsWith('.go'))
          if (to) fileEdges.push({ from: f, to, line: at(m.index), text: dir, source: 'regex', lang })
        }
      }
    } else if (lang === 'csharp') {
      csFiles.push(f)
      for (const m of text.matchAll(new RegExp(signals.imports.csharpTypes, 'g'))) if (!csTypes.has(m[1])) csTypes.set(m[1], f)
    }
  }
  // C#: no imports inside a namespace, so a file uses another when it names a type declared there.
  for (const f of csFiles) {
    const text = textOf(f)
    const at = lineFinder(text)
    const seen = new Set()
    for (const m of text.matchAll(/\b[A-Z][A-Za-z0-9_]*\b/g)) {
      const to = csTypes.get(m[0])
      if (!to || to === f || seen.has(to)) continue
      seen.add(to)
      fileEdges.push({ from: f, to, line: at(m.index), text: `${m[0]} (${base(to)})`, source: 'regex', lang: 'csharp' })
    }
  }

  // ---- outside tools for better edges
  const sources = new Set()
  const jsFiles = files.filter(f => langOf.get(f) === 'js')
  let offerNpx = false
  // One JS file has no edges of its own to find: no tool, no offer.
  if (jsFiles.length > 1) {
    const local = path.join(root, req.tools.localDepcruise)
    let argv = null
    if (fs.existsSync(local)) argv = ['node', local, ...req.tools.depcruise.slice(req.tools.depcruise.indexOf('depcruise') + 1)]
    else if (req.allowNpx) argv = req.tools.depcruise
    else offerNpx = true
    if (argv) {
      const r = run(argv, root, req.tools.npxTimeoutMs, req.tools.shims)
      let doc = null
      try {
        doc = JSON.parse(r.stdout)
      } catch {
        notes.push(`dependency-cruiser failed: ${(r.stderr || 'no JSON').trim().split('\n')[0].slice(0, 160)}`)
      }
      if (doc && Array.isArray(doc.modules)) {
        // Its edges replace the regex ones for JS/TS: it resolves aliases and tsconfig paths.
        for (let i = fileEdges.length - 1; i >= 0; i--) if (fileEdges[i].lang === 'js') fileEdges.splice(i, 1)
        for (const m of doc.modules) {
          const from = slash(m.source)
          if (!fileSet.has(from)) continue
          for (const d of m.dependencies ?? []) {
            const to = slash(d.resolved ?? '')
            if (!fileSet.has(to) || to === from || d.coreModule || d.couldNotResolve) continue
            fileEdges.push({ from, to, line: lineOf(textOf(from), d.module), text: base(to), source: 'depcruise' })
          }
        }
        sources.add('depcruise')
      }
    }
  }
  if (files.some(f => base(f) === 'Cargo.toml' && /^\[workspace\]/m.test(textOf(f)))) {
    const r = run(req.tools.cargo, root, req.tools.timeoutMs, req.tools.shims)
    try {
      const meta = JSON.parse(r.stdout)
      const byName = new Map(meta.packages.map(p => [p.name, slash(path.relative(root, p.manifest_path))]))
      for (const p of meta.packages) {
        const from = slash(path.relative(root, p.manifest_path))
        for (const d of p.dependencies ?? []) {
          const to = byName.get(d.name)
          if (to && to !== from && d.path) fileEdges.push({ from, to, line: lineOf(textOf(from), d.name), text: d.name, source: 'cargo' })
        }
      }
    } catch {
      notes.push(`cargo metadata failed: ${(r.stderr || 'no JSON').trim().split('\n')[0].slice(0, 160)}`)
    }
  }

  // ---- modules: workspace units first, folders folded at the data depth, split while too few
  const sourceFiles = files.filter(f => langOf.has(f))
  const unitDirs = units.map(u => u.dir).sort((a, b) => b.length - a.length)
  const useUnits = units.length > 1 || (units.length === 1 && units[0].dir !== '')
  /** The module path a file starts in: its deepest unit, else its folder cut at the depth. */
  const firstModule = f => {
    if (useUnits) {
      const u = unitDirs.find(d => d === '' || f.startsWith(d + '/'))
      if (u !== undefined) return u
    }
    const parts = dirOf(f).split('/').filter(Boolean)
    return parts.slice(0, req.fold.depth).join('/')
  }
  const assign = new Map(sourceFiles.map(f => [f, firstModule(f)]))
  /** The child a file falls in below a module path: a sub-folder, or the file itself. */
  const childOf = (mod, f) => {
    const rest = mod === '' ? f : f.slice(mod.length + 1)
    const seg = rest.split('/')[0]
    return mod === '' ? seg : `${mod}/${seg}`
  }
  /** Where a module's files part ways: below any folder they all share (a crate's lone `src`). Null when they never do. */
  const splitOf = (mod, list) => {
    // A module of one file, or a file module, has nothing below it.
    if (list.length < 2 || list.includes(mod)) return null
    let at = mod
    for (;;) {
      const kids = new Set(list.map(f => childOf(at, f)))
      if (kids.size > 1) return new Map(list.map(f => [f, childOf(at, f)]))
      const only = [...kids][0]
      if (only === undefined || list.includes(only) || !list.every(f => f.startsWith(only + '/'))) return null
      at = only
    }
  }
  for (;;) {
    const groups = new Map()
    for (const [f, m] of assign) groups.set(m, [...(groups.get(m) ?? []), f])
    if (groups.size >= req.fold.minModules) break
    const biggest = [...groups.entries()].sort((a, b) => b[1].length - a[1].length).map(([m, list]) => splitOf(m, list)).find(s => s !== null)
    if (biggest === undefined) break
    for (const [f, m] of biggest) assign.set(f, m)
  }
  const moduleOf = f => {
    if (assign.has(f)) return assign.get(f)
    // Manifests and data files belong to the deepest module holding their folder.
    const mods = [...new Set(assign.values())].sort((a, b) => b.length - a.length)
    return mods.find(m => m === '' || f === m || f.startsWith(m + '/')) ?? null
  }
  const unitName = new Map(units.map(u => [u.dir, u.name]))
  const modIds = [...new Set(assign.values())].sort()
  const modules = modIds.map(id => {
    const own = sourceFiles.filter(f => assign.get(f) === id)
    const nameFromPath = id === '' ? path.basename(root) : id.split('/').pop().replace(/\.[a-z]+$/i, '')
    return {
      id: id === '' ? '.' : id,
      name: unitName.get(id) ?? nameFromPath,
      path: id === '' ? '.' : id,
      files: own.length,
      lines: own.reduce((n, f) => n + (lineCount.get(f) ?? 0), 0),
      churn: 0,
      isHot: false,
      entries: [],
      fanIn: 0,
      fanOut: 0,
      uses: [],
    }
  })
  const modById = new Map(modules.map(m => [m.id, m]))
  const idOf = f => {
    const m = moduleOf(f)
    return m === null ? null : m === '' ? '.' : m
  }

  for (const e of entries) {
    const id = idOf(e.file)
    const m = id === null ? undefined : modById.get(id)
    if (m && !m.entries.some(x => x.file === e.file && x.text === e.text)) m.entries.push(e)
  }

  // ---- edges folded to modules
  const folded = new Map()
  const edgeSources = new Set()
  for (const e of fileEdges) {
    const a = idOf(e.from)
    const b = idOf(e.to)
    if (a === null || b === null || a === b || !modById.has(a) || !modById.has(b)) continue
    const k = `${a}\u0000${b}`
    const cur = folded.get(k)
    if (cur) cur.count++
    else folded.set(k, { from: a, to: b, count: 1, via: { file: e.from, line: e.line, text: e.text } })
    edgeSources.add(e.source)
  }
  for (const s of edgeSources) sources.add(s)
  let edges = [...folded.values()].sort((x, y) => y.count - x.count)
  for (const e of edges) {
    modById.get(e.from).fanOut++
    modById.get(e.to).fanIn++
  }

  // ---- churn and hot spots
  if (isGit) {
    const log = run([req.tools.git, 'log', `--since=${req.fold.churnDays}.days`, '--numstat', '--format='], root, req.tools.timeoutMs, [])
    if (log.ok) {
      for (const raw of log.stdout.split('\n')) {
        const m = /^(\d+)\t(\d+)\t(.+)$/.exec(raw)
        if (!m || m[3].includes('=>')) continue
        const id = assign.has(m[3]) ? idOf(m[3]) : null
        if (id !== null && modById.has(id)) modById.get(id).churn += Number(m[1]) + Number(m[2])
      }
    }
  }
  const scored = modules.filter(m => m.churn * m.lines > 0).sort((a, b) => b.churn * b.lines - a.churn * a.lines)
  const hotCount = Math.min(scored.length, Math.ceil(modules.length * req.fold.hotShare))
  for (const m of scored.slice(0, hotCount)) m.isHot = true

  // ---- cycles: strongly connected modules, each shown by its shortest loop
  const adj = new Map(modules.map(m => [m.id, []]))
  for (const e of edges) adj.get(e.from).push(e.to)
  const cycles = []
  {
    let index = 0
    const idx = new Map()
    const low = new Map()
    const stack = []
    const on = new Set()
    const comps = []
    const strong = v => {
      idx.set(v, index)
      low.set(v, index++)
      stack.push(v)
      on.add(v)
      for (const w of adj.get(v)) {
        if (!idx.has(w)) {
          strong(w)
          low.set(v, Math.min(low.get(v), low.get(w)))
        } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)))
      }
      if (low.get(v) === idx.get(v)) {
        const comp = []
        let w
        do {
          w = stack.pop()
          on.delete(w)
          comp.push(w)
        } while (w !== v)
        if (comp.length > 1) comps.push(comp)
      }
    }
    for (const m of modules) if (!idx.has(m.id)) strong(m.id)
    for (const comp of comps) {
      const inComp = new Set(comp)
      const startId = [...comp].sort()[0]
      // Breadth first from the start back to itself, inside the component.
      const prev = new Map()
      const queue = [startId]
      let found = null
      while (queue.length && found === null) {
        const v = queue.shift()
        for (const w of adj.get(v)) {
          if (!inComp.has(w)) continue
          if (w === startId) {
            found = v
            break
          }
          if (!prev.has(w)) {
            prev.set(w, v)
            queue.push(w)
          }
        }
      }
      const loop = [startId]
      if (found !== null) {
        const back = []
        for (let v = found; v !== startId; v = prev.get(v)) back.push(v)
        loop.push(...back.reverse())
      }
      const via = loop.map((v, i) => folded.get(`${v}\u0000${loop[(i + 1) % loop.length]}`)?.via).filter(Boolean)
      cycles.push({ modules: loop, via })
    }
  }
  const orphans = edges.length === 0 ? [] : modules.filter(m => m.fanIn === 0 && m.fanOut === 0 && m.entries.length === 0).map(m => m.id)

  // ---- services: implied by env names in code, then joined with what provides them
  for (const [name, ev] of envRead) {
    for (const s of services) if (matchesAny(name, s.env)) addEvidence(implied, s.id, ev)
  }
  for (const s of services) {
    if (!implied.has(s.id)) continue
    for (const name of s.attachEnv) if (envRead.has(name)) addEvidence(implied, s.id, envRead.get(name))
  }
  const out = []
  for (const s of services) {
    const imp = implied.get(s.id) ?? []
    const pro = provided.get(s.id) ?? []
    if (imp.length === 0 && pro.length === 0) continue
    const names = new Set()
    for (const n of [...envRead.keys(), ...envDefined.keys()]) if (matchesAny(n, s.env) || (imp.length > 0 && s.attachEnv.includes(n))) names.add(n)
    const mods = new Set(imp.map(e => idOf(e.file)).filter(id => id !== null && modById.has(id)))
    out.push({ id: s.id, name: s.name, kind: s.kind, implied: imp, provided: pro, env: [...names].sort(), isEnvDefined: [...names].some(n => envDefined.has(n)), modules: [...mods].sort() })
  }
  const byTarget = new Map()
  for (const r of fileRefs) addEvidence(byTarget, r.target, { file: r.file, line: r.line, text: `${r.target}` })
  for (const [target, evs] of byTarget) {
    const mods = new Set(evs.map(e => idOf(e.file)).filter(id => id !== null && modById.has(id)))
    out.push({ id: `file:${target}`, name: path.posix.basename(target), kind: 'file', implied: evs, provided: [{ file: target, line: 1, text: signals.words.inRepo }], env: [], isEnvDefined: false, modules: [...mods].sort() })
  }
  for (const s of out) for (const id of s.modules) modById.get(id).uses.push(s.id)

  // ---- gaps
  const gaps = []
  const cap = list => list.slice(0, req.budgets.evidencePerGap)
  for (const f of secrets) gaps.push({ kind: 'secret', severity: 'warn', subject: f.file, evidence: [f] })
  for (const s of out) {
    const def = services.find(x => x.id === s.id)
    if (s.kind === 'resource' && s.implied.length > 0 && s.provided.length === 0) {
      gaps.push({ kind: 'unprovisioned', severity: 'warn', subject: s.name, evidence: cap(s.implied) })
    }
    if (s.kind === 'resource' && s.provided.length > 0 && s.implied.length === 0) {
      gaps.push({ kind: 'unused', severity: 'note', subject: s.name, evidence: cap(s.provided) })
    }
    if (s.kind === 'api' && def && ![...envDefined.keys()].some(n => matchesAny(n, def.env))) {
      gaps.push({ kind: 'apiKey', severity: 'note', subject: s.name, evidence: cap(s.implied) })
    }
  }
  for (const [name, ev] of [...envRead].sort((a, b) => a[0].localeCompare(b[0]))) {
    if (!envDefined.has(name)) {
      if (optionalOnly.get(name) === true) gaps.push({ kind: 'envOptional', severity: 'note', subject: name, evidence: cap([ev]) })
      else gaps.push({ kind: 'envMissing', severity: 'warn', subject: name, evidence: cap([ev]) })
    } else if (hasExample && !exampleNames.has(name) && !['ci', 'code'].includes(envDefined.get(name).source)) {
      gaps.push({ kind: 'envUndocumented', severity: 'note', subject: name, evidence: cap([ev, envDefined.get(name).ev]) })
    }
  }
  for (const [name, d] of [...envDefined].sort((a, b) => a[0].localeCompare(b[0]))) {
    if ((d.source === 'dotenv' || d.source === 'example') && !envRead.has(name) && !imageEnv.has(name)) {
      gaps.push({ kind: 'envUnused', severity: 'note', subject: name, evidence: cap([d.ev]) })
    }
  }
  gaps.sort((a, b) => KIND_RANK.indexOf(a.kind) - KIND_RANK.indexOf(b.kind))

  const names = [...new Set([...envRead.keys(), ...envDefined.keys()])].sort()
  const env = {
    hasExample,
    names: names.map(n => ({ name: n, read: envRead.get(n) ?? null, defined: envDefined.get(n)?.ev ?? null, isInExample: exampleNames.has(n) })),
  }
  if (sources.size === 0 && sourceFiles.length > 0) sources.add('regex')
  edges = edges.slice(0, req.budgets.edges)
  const keptMods = modules.slice().sort((a, b) => b.fanIn + b.fanOut + b.entries.length - (a.fanIn + a.fanOut + a.entries.length) || b.lines - a.lines).slice(0, req.budgets.modules)
  const keptIds = new Set(keptMods.map(m => m.id))
  const rootUnit = units.find(u => u.dir === '')
  return {
    version: 1,
    key,
    root: slash(root),
    name: rootUnit?.name ?? path.basename(root),
    head,
    scannedAt: req.now,
    files: files.length,
    services: out,
    runtimes: dedupeRuntimes(runtimes),
    env,
    gaps: gaps.slice(0, req.budgets.gaps),
    code: {
      sources: [...sources].sort(),
      isApproximate: sources.has('regex'),
      modules: modules.filter(m => keptIds.has(m.id)),
      edges: edges.filter(e => keptIds.has(e.from) && keptIds.has(e.to)),
      cycles,
      orphans,
    },
    offers: { npx: offerNpx },
    notes,
  }
}

/** A runtime label with its port, when there is one (`Dockerfile :8080`). */
function withPort(label, port) {
  return port === undefined ? label : label + signals.words.runtimes.port.replace('{port}', port)
}

/** One row per name and way of running. */
function dedupeRuntimes(list) {
  const seen = new Set()
  return list.filter(r => {
    const k = `${r.name}|${r.how}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// ---------------------------------------------------------------- main

let input = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', chunk => {
  input += chunk
})
process.stdin.on('end', () => {
  try {
    const req = JSON.parse(input)
    process.stdout.write(JSON.stringify(scan(req)))
  } catch (error) {
    process.stderr.write(String(error?.stack ?? error))
    process.exit(1)
  }
})
