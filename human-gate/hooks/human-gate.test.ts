//! Tests for human-gate, run against the policy that ships (data/gate.ts):
//! the pure rules on a table of commands and tools, then the tool.check hook
//! with an engine verdict beneath it.

import { describe, expect, test } from 'claude-code/testing'
import type { On } from 'claude-code'

import { policy } from '../data/gate'
import { checkShell, checkTool, segments } from './gate'

/** Category held for a shell command, 'pending' for a plain push, or null. */
function shell(command: string): string | null {
  const found = checkShell(command, policy)
  if (found === null) return null
  return 'pending' in found ? 'pending' : found.category
}

describe('shell commands', () => {
  const cases: [string, string | null][] = [
    ['npm publish', 'publish'],
    ['npm test && npm publish --access public', 'publish'],
    ['pnpm -r publish', 'publish'],
    ['npm publish --dry-run', null],
    ['git commit -m "explain npm publish"', null],
    ["echo 'terraform apply' > notes.txt", null],
    ['terraform -chdir=infra apply', 'deploy'],
    ['terraform plan', null],
    ['kubectl apply -f app.yaml --dry-run=client', null],
    ['kubectl apply -f app.yaml --dry-run=none', 'deploy'],
    ['kubectl get pods', null],
    ['vercel --prod', 'deploy'],
    ['vercel', null],
    ['gh workflow run deploy.yml', 'deploy'],
    ['az webapp deploy --name x --src-path app.zip', 'deploy'],
    ['docker push registry/app:1', 'publish'],
    ['docker build -t app .', null],
    ['git push origin main', 'push-main'],
    ['git push origin HEAD:main', 'push-main'],
    ['git push -f origin +refs/heads/master', 'push-main'],
    ['git push --all', 'push-main'],
    ['git push origin feature/x', null],
    ['git push', 'pending'],
    ['git -C ~/repo push', 'push-main'],
    ['git status | cat', null],
    ['psql -c "DELETE FROM users"', 'data'],
    ['psql -c "DELETE FROM users WHERE id = 1"', null],
    ['psql -c "delete from users where 1=1"', 'data'],
    ['sqlite3 app.db "DROP TABLE sessions"', 'data'],
    ['echo "DROP TABLE x"', null],
    ['npx prisma migrate deploy', 'data'],
    ['npx prisma migrate dev', null],
  ]
  for (const [command, expected] of cases) {
    test(`${command} -> ${expected ?? 'not held'}`, () => {
      expect(shell(command)).toBe(expected)
    })
  }

  test('segments split outside quotes only', () => {
    expect(segments('a && b || c ; d | e').map(s => s.bare)).toEqual(['a', 'b', 'c', 'd', 'e'])
    expect(segments('git commit -m "a && b"').map(s => s.bare)).toEqual(['git commit -m ""'])
  })

  test('a plain push after cd marks the directory unknown', () => {
    const found = checkShell('cd ../other && git push', policy)
    expect(found !== null && 'pending' in found && found.pending.hasCd).toBe(true)
  })
})

describe('tools', () => {
  const cases: [string, unknown, string | null][] = [
    ['mcp__plugin_stripe_stripe__create_refund', {}, 'money'],
    ['mcp__plugin_stripe_stripe__list_customers', {}, null],
    ['mcp__billing__create_payout', {}, 'money'],
    ['mcp__billing__list_invoices', {}, null],
    ['mcp__slack__slack_post_message', {}, 'outbound'],
    ['mcp__gmail__send_email', {}, 'outbound'],
    ['mcp__gmail__create_draft', {}, null],
    ['mcp__github__add_issue_comment', {}, 'outbound'],
    ['mcp__blog__get_post', {}, null],
    ['mcp__vercel__deploy_to_vercel', {}, 'deploy'],
    ['mcp__db__execute_sql', { query: 'TRUNCATE TABLE audit' }, 'data'],
    ['mcp__db__execute_sql', { query: 'SELECT * FROM audit' }, null],
    ['Read', { file_path: 'x' }, null],
  ]
  for (const [tool, input, expected] of cases) {
    test(`${tool} -> ${expected ?? 'not held'}`, () => {
      expect(checkTool(tool, input, policy)?.category ?? null).toBe(expected)
    })
  }
})

/** Stands in for the engine: answers its verdict and the git branch question. */
function engine(on: On, verdict: Record<string, unknown>, branch = 'feature/x'): void {
  on('tool.check', () => verdict as never)
  on('session.cwd', () => ({ value: '/repo' }))
  on('process.run', () => ({
    value: { exitCode: 0, stdout: `${branch}\n`, stderr: '', isStdoutTruncated: false, isStderrTruncated: false },
  }))
  on('ui.status', () => ({ value: undefined }))
}

describe('tool.check', () => {
  test('an allowed publish is held for a person', async ($, on) => {
    engine(on, { decision: 'allow', rule: 'Bash(npm:*)' })
    const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'npm publish' } })
    expect(verdict.decision).toBe('ask')
    expect(verdict.reason).toContain('publish')
  })

  test('a deny beneath stands', async ($, on) => {
    engine(on, { decision: 'deny', reason: 'rule' })
    const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'npm publish' } })
    expect(verdict.decision).toBe('deny')
  })

  test('a plain push is held only on a protected branch', async ($, on) => {
    engine(on, { decision: 'allow' }, 'main')
    expect((await $.tool.check({ tool: 'Bash', input: { command: 'git push' } })).decision).toBe('ask')
  })

  test('a plain push from a feature branch is left alone', async ($, on) => {
    engine(on, { decision: 'allow' }, 'feature/x')
    expect((await $.tool.check({ tool: 'Bash', input: { command: 'git push' } })).decision).toBe('allow')
  })

  test('a read-only call skips the engine prompt', async ($, on) => {
    engine(on, { decision: 'ask' })
    const verdict = await $.tool.check({ tool: 'Read', input: { file_path: '/x' }, isReadOnly: true })
    expect(verdict.decision).toBe('allow')
  })

  test('a rule that asks wins over the fast lane', async ($, on) => {
    engine(on, { decision: 'ask', rule: 'Read(/secret/**)' })
    const verdict = await $.tool.check({ tool: 'Read', input: { file_path: '/x' }, isReadOnly: true })
    expect(verdict.decision).toBe('ask')
  })

  test('MCP read-only claims and never-fast tools keep their prompt', async ($, on) => {
    engine(on, { decision: 'ask' })
    const mcp = await $.tool.check({ tool: 'mcp__notes__list_notes', input: {}, isReadOnly: true })
    const fetch = await $.tool.check({ tool: 'WebFetch', input: { url: 'https://x' }, isReadOnly: true })
    expect(mcp.decision).toBe('ask')
    expect(fetch.decision).toBe('ask')
  })
})
