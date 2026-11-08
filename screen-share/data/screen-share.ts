//! Tuning for screen-share: every masking rule, mask glyph, category switch,
//! word list and line of text the mod shows. The hooks and the tests both
//! import this file, so a re-tune here changes the mod and its tests together.
//!
//! Rules run top to bottom. Secrets come first so a key is masked whole before
//! a looser rule (env assignments, phone numbers) cuts it up. In a pattern, a
//! named group `keep` at the start and `tail` at the end stay showing.

import type { Tuning } from '../types'

export const tuning: Tuning = {
  verbs: { on: 'on', off: 'off', status: 'status', test: 'test' },

  categories: {
    secrets: { on: true, label: 'keys, tokens and passwords', mask: 'dots' },
    env: { on: true, label: 'environment values', mask: 'dots' },
    paths: { on: true, label: 'home folders and user paths', mask: 'block' },
    emails: { on: true, label: 'emails', mask: 'block' },
    phones: { on: true, label: 'phone numbers', mask: 'block' },
    money: { on: true, label: 'money amounts', mask: 'block' },
    ips: { on: true, label: 'IP addresses', mask: 'block' },
    names: { on: true, label: 'names', mask: 'block' },
  },

  masks: {
    // Fixed length: a key's length can tell which vendor issued it.
    dots: { glyph: '•', length: 'fixed', size: 6 },
    block: { glyph: '█', length: 'match', size: 24 },
  },

  rules: [
    // --- secrets ---------------------------------------------------------
    {
      id: 'private-key-block',
      category: 'secrets',
      pattern: String.raw`(?<keep>-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----\r?\n?)[\s\S]*?(?:(?<tail>\r?\n?-----END [A-Z0-9 ]*PRIVATE KEY-----)|$)`,
      flags: 'g',
    },
    {
      id: 'authorization-header',
      category: 'secrets',
      pattern: String.raw`(?<keep>\b(?:proxy-)?authorization["']?\s*[:=]\s*["']?(?:bearer|basic|token|digest)?\s*)[^\s"',;]+`,
      flags: 'gi',
    },
    { id: 'bearer', category: 'secrets', pattern: String.raw`(?<keep>\bbearer\s+)[A-Za-z0-9._~+/=-]{8,}`, flags: 'gi' },
    {
      id: 'vendor-key',
      category: 'secrets',
      pattern: String.raw`\b(?:sk-(?:ant-|proj-|svcacct-)?[A-Za-z0-9_-]{16,}|(?:sk|rk|pk)_(?:live|test)_[A-Za-z0-9]{12,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|glpat-[A-Za-z0-9_-]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{16}|AIza[0-9A-Za-z_-]{30,}|npm_[A-Za-z0-9]{30,}|hf_[A-Za-z0-9]{30,})`,
      flags: 'g',
    },
    { id: 'jwt', category: 'secrets', pattern: String.raw`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`, flags: 'g' },
    {
      id: 'url-credentials',
      category: 'secrets',
      pattern: String.raw`(?<keep>\b[a-z][a-z0-9+.-]*://[^\s/:@]+:)[^\s/@]+(?<tail>@)`,
      flags: 'gi',
    },
    {
      id: 'url-query-secret',
      category: 'secrets',
      pattern: String.raw`(?<keep>[?&](?:access_token|refresh_token|id_token|token|api_key|apikey|key|secret|password|sig|signature)=)[^&\s#"']+`,
      flags: 'gi',
    },
    {
      id: 'secret-flag',
      category: 'secrets',
      pattern: String.raw`(?<keep>--(?:token|password|passwd|pass|api-key|apikey|secret|client-secret|access-token|auth-token)(?:=|\s+))[^\s"']+`,
      flags: 'gi',
    },
    {
      id: 'key-value-secret',
      category: 'secrets',
      pattern: String.raw`(?<keep>\b[\w.-]*(?:api[_-]?key|access[_-]?key|secret[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|client[_-]?secret|token|secret|password|passwd|pwd|passphrase)["']?\s*[:=]\s*["']?)[^\s"',;&]+`,
      flags: 'gi',
    },

    // --- environment values -------------------------------------------
    {
      id: 'shell-assignment',
      category: 'env',
      pattern: String.raw`(?<keep>(?<![\w$])(?:export\s+|set\s+|setx\s+)?[A-Z][A-Z0-9_]{2,}=)(?:"[^"]*"|'[^']*'|[^\s"';&|]+)`,
      flags: 'g',
    },
    {
      id: 'powershell-env',
      category: 'env',
      pattern: String.raw`(?<keep>\$env:[A-Za-z_][A-Za-z0-9_]*\s*=\s*)(?:"[^"]*"|'[^']*'|[^\s;]+)`,
      flags: 'gi',
    },

    // --- home folders and user paths ----------------------------------
    {
      id: 'windows-user-path',
      category: 'paths',
      pattern: String.raw`(?<keep>(?:\b[A-Za-z]:|/[A-Za-z]|/mnt/[A-Za-z])(?:\\+|/)Users(?:\\+|/))[^\\/\s"'<>|:*?]+`,
      flags: 'gi',
    },
    { id: 'unix-user-path', category: 'paths', pattern: String.raw`(?<keep>(?<![\w.])/(?:Users|home)/)[^/\s"'<>|:]+`, flags: 'g' },

    // --- people and money ---------------------------------------------
    { id: 'email', category: 'emails', pattern: String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}`, flags: 'g' },
    {
      id: 'ipv4',
      category: 'ips',
      pattern: String.raw`(?<![\d.])(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}(?![\d.])`,
      flags: 'g',
      allow: ['127.0.0.1', '0.0.0.0'],
    },
    {
      id: 'phone',
      category: 'phones',
      pattern: String.raw`(?<![\w.-])(?!\d{4}-\d{2}-\d{2})\+?\(?\d(?:[ .()-]{0,2}\d){8,14}(?![\w-])`,
      flags: 'g',
      minDigits: 9,
    },
    {
      id: 'money',
      category: 'money',
      pattern: String.raw`(?:[$€£¥₹]\s?\d[\d,]*(?:\.\d+)?(?:\s?(?:k|m|bn|b)\b)?|\b\d[\d,]*(?:\.\d+)?\s?(?:k|m|bn)?\s?(?:USD|EUR|GBP|JPY|INR|CAD|AUD|dollars?|euros?|pounds?)\b)`,
      flags: 'gi',
    },
    {
      id: 'name-pair',
      category: 'names',
      pattern: String.raw`(?<![\p{L}])\p{Lu}\p{Ll}+(?:[ '-]\p{Lu}\p{Ll}+)+(?![\p{L}])`,
      flags: 'gu',
      skipCommonWords: true,
    },
  ],

  notNames: [
    'I', 'A', 'An', 'The', 'This', 'That', 'These', 'Those', 'And', 'But', 'Or', 'If', 'When', 'Then', 'So', 'Now',
    'Here', 'There', 'What', 'Why', 'How', 'Who', 'Which', 'Where', 'Yes', 'No', 'Ok', 'Okay', 'Please', 'Thanks',
    'Claude', 'Code', 'Anthropic', 'Opus', 'Sonnet', 'Haiku', 'Fable', 'Desktop', 'Terminal', 'Chrome', 'Google',
    'Drive', 'Docs', 'Sheets', 'Gmail', 'Calendar', 'Microsoft', 'Windows', 'Mac', 'Linux', 'Apple', 'Slack',
    'Notion', 'Github', 'GitHub', 'Git', 'Visual', 'Studio', 'Power', 'Shell', 'PowerShell', 'Node', 'Type', 'Script',
    'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday', 'January', 'February', 'March',
    'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December',
    'Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Task', 'Agent', 'Plan', 'Step', 'Next', 'Done', 'New', 'Mode',
    'Screen', 'Share', 'Tool', 'Tools', 'File', 'Files', 'Note', 'Notes', 'Turn', 'Off', 'On', 'Air', 'Test', 'Tests',
    'Error', 'Warning', 'Hello', 'World', 'Pull', 'Request', 'Me', 'Project', 'Projects', 'Program', 'Users',
  ],
  alwaysHide: [],
  minHideLength: 2,

  machine: { use: ['home', 'user', 'host', 'domain'], category: 'paths', minLength: 3 },

  deepLimit: 12,
  unfoldGroups: true,
  maskOtherMods: true,
  remember: true,

  colors: { onAir: 'error', note: 'subtle' },
  hotkeys: { off: 'x' },

  text: {
    onAir: '● ON AIR',
    bandNote: 'screen share: private details are masked on screen',
    turnOff: 'Turn off',
    status: '● ON AIR',
    mode: 'on air',
    turnedOn: 'Screen share on: {categories} are masked on screen. Claude still sees everything.',
    turnedOnScrollback: 'Rows printed before now may still show in the scrollback; clear the screen before you share.',
    turnedOff: 'Screen share off: nothing is masked.',
    alreadyOn: 'Screen share is already on.',
    alreadyOff: 'Screen share is already off.',
    statusOn: 'Screen share is ON AIR.',
    statusOff: 'Screen share is off.',
    statusCategories: 'Categories:',
    statusCategoryOn: '  on   {label}',
    statusCategoryOff: '  off  {label}',
    statusWords: '{count} words from this machine and the names option are masked as written.',
    testResult: 'Masked: {masked}',
    testEmpty: 'Nothing to mask: /screen-share test <text>',
    usage: 'Usage: /screen-share [on|off|status|test <text>] (no argument switches it)',
    commandDescription: 'Screen share mode: mask keys, paths, emails, phone numbers, money and names on screen',
  },
}
