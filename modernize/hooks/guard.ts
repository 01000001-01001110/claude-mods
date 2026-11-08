//! Pure rules for the legacy guard: resolve the path a write or edit names
//! against the session folder and say whether it lands inside the legacy
//! folder. Windows paths are normalised (backslashes, drive-letter case) and
//! compared without case there, since NTFS treats `Legacy` and `legacy` as one.

/** Forward slashes, `.` and `..` folded, no trailing slash. A Windows drive letter is lower-cased. */
export function normalise(path: string): string {
  const p = path.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d: string) => `${d.toLowerCase()}:`)
  // A UNC path (`//server/share`) keeps both slashes; a posix root keeps one.
  const lead = p.startsWith('//') ? '//' : p.startsWith('/') ? '/' : ''
  const out: string[] = []
  for (const part of p.split('/')) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      // Never climb above a drive or the root.
      if (out.length > 0 && !/^[a-z]:$/.test(out[out.length - 1]!)) out.pop()
      continue
    }
    out.push(part)
  }
  return lead + out.join('/')
}

/** True for `C:/x`, `/x` and `\\server\x`: a path that does not need the session folder. */
export function isAbsolute(path: string): boolean {
  return /^([A-Za-z]:)?[\\/]/.test(path)
}

/** True when the normalised path is a Windows path (drive letter or UNC), compared without case. */
function isWindows(path: string): boolean {
  return /^[a-z]:/.test(path) || path.startsWith('//')
}

/**
 * True when `target` (absolute or relative to `cwd`) is the legacy folder or
 * inside it.
 * @param legacy the legacy folder name, relative to `cwd` (data `dirs.legacy`).
 */
export function insideLegacy(target: string, cwd: string, legacy: string): boolean {
  if (target.trim() === '') return false
  const full = normalise(isAbsolute(target) ? target : `${cwd}/${target}`)
  const root = normalise(`${cwd}/${legacy}`)
  const fold = isWindows(root) ? (s: string) => s.toLowerCase() : (s: string) => s
  const a = fold(full)
  const b = fold(root)
  return a === b || a.startsWith(`${b}/`)
}

/** The first path field of a tool input that holds text. */
export function pathOf(input: Record<string, unknown>, fields: string[]): string | undefined {
  for (const f of fields) {
    const v = input[f]
    if (typeof v === 'string' && v !== '') return v
  }
  return undefined
}
