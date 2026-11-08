/**
 * human-gate policy: what is held for a person and what takes the fast lane.
 *
 * This is the mod's data file: a plain literal, no logic. It is TypeScript,
 * not JSON, because a hooks module can only import script files, and the
 * tests import this same file so they check the policy that ships.
 * Regexes are JavaScript source strings, matched without regard to case.
 */

import type { Policy } from '../types'

export const policy: Policy = {
  "categories": [
    "deploy",
    "publish",
    "push-main",
    "money",
    "outbound",
    "data"
  ],
  "shellTools": [
    "Bash",
    "PowerShell"
  ],
  "protectedBranches": [
    "main",
    "master",
    "production",
    "prod",
    "release"
  ],
  "dryRun": "--dry-run(?!=(none|false)\\b)|\\s-WhatIf\\b",
  "readOnlyFastLane": true,
  "trustMcpReadOnly": false,
  "neverFastLane": [
    "WebFetch",
    "WebSearch",
    "Agent",
    "Task",
    "SendMessage",
    "Skill"
  ],
  "readOnlyVerbs": "^(list|get|retrieve|search|read|fetch|describe|find|count|query_read|show|view|preview)(_|$)",
  "shell": {
    "deploy": [
      "\\bwrangler\\b.*\\b(deploy|publish)\\b",
      "\\bvercel\\b(?=.*\\s--prod\\b)",
      "\\b(fly|flyctl)\\b(\\s+-\\S+)*\\s+deploy\\b",
      "\\bkubectl\\b.*\\s(apply|delete|replace|patch|scale|rollout\\s+restart)\\b",
      "\\bhelm\\b.*\\s(install|upgrade|uninstall|rollback)\\b",
      "\\b(terraform|tofu)\\b(\\s+-\\S+)*\\s+(apply|destroy|import)\\b",
      "\\bgh\\b\\s+workflow\\s+run\\b",
      "\\bnetlify\\b.*\\bdeploy\\b(?=.*\\s--prod\\b)",
      "\\bfirebase\\b\\s+deploy\\b",
      "\\bgcloud\\b.*\\bdeploy\\b",
      "\\baz\\b\\s+(webapp|functionapp|containerapp|staticwebapp)\\b.*\\b(deploy|up|delete|create)\\b",
      "\\baz\\b\\s+deployment\\b.*\\b(create|delete)\\b",
      "\\baz\\b\\s+group\\s+delete\\b"
    ],
    "publish": [
      "\\b(npm|pnpm|yarn|bun)\\b(\\s+-\\S+)*\\s+(publish|unpublish)\\b",
      "\\bcargo\\b\\s+publish\\b",
      "\\btwine\\b\\s+upload\\b",
      "\\bpoetry\\b\\s+publish\\b",
      "\\bdocker\\b(\\s+-\\S+)*\\s+(push|image\\s+push)\\b",
      "\\bgh\\b\\s+release\\s+(create|upload|delete)\\b",
      "\\bdotnet\\b\\s+nuget\\s+push\\b",
      "\\bgem\\b\\s+push\\b",
      "\\b(vsce|ovsx)\\b\\s+publish\\b"
    ],
    "data": [
      "\\bprisma\\b\\s+migrate\\s+(deploy|reset)\\b",
      "\\bprisma\\b\\s+db\\s+push\\b",
      "\\balembic\\b.*\\b(upgrade|downgrade)\\b",
      "\\brails\\b\\s+db:(migrate|drop|reset|rollback)\\b",
      "\\bdrizzle-kit\\b\\s+(push|migrate)\\b",
      "\\bdotnet\\b\\s+ef\\s+database\\s+(update|drop)\\b"
    ]
  },
  "sqlClients": "\\b(psql|mysql|mariadb|sqlite3|sqlcmd|duckdb)\\b",
  "sql": {
    "destructive": "\\b(DROP|TRUNCATE)\\s+(TABLE|DATABASE|SCHEMA|ROLE|USER|INDEX|VIEW)\\b|\\bALTER\\s+(TABLE|DATABASE|SCHEMA|ROLE|USER)\\b",
    "unboundedWrite": "^\\s*(DELETE\\s+FROM|UPDATE\\s+\\S+\\s+SET)\\b",
    "where": "\\bWHERE\\b",
    "trivialWhere": "\\bWHERE\\s+(1\\s*=\\s*1|TRUE|1|'1'\\s*=\\s*'1')\\s*($|;|\\bRETURNING\\b|\\bLIMIT\\b|\\bORDER\\b)"
  },
  "tools": {
    "deploy": [
      "^mcp__.+__(deploy_\\w*|delete_project|create_deployment|promote_deployment|rollback_deployment)$"
    ],
    "money": [
      "^mcp__(?:(?!__).)*stripe",
      "^mcp__.+__\\w*(refund|payout|charge|transfer|payment_intent|invoice)\\w*$"
    ],
    "outbound": [
      "^mcp__.+__(\\w+_)?(send|forward|reply|post|publish|share)(_\\w+)?$",
      "^mcp__.+__(\\w+_)?(add|create)_\\w*comment\\w*$"
    ]
  },
  "status": "gate: {held} held · {fast} fast-laned",
  "heldReason": "human-gate held this ({category}): {why}. A person decides."
}
