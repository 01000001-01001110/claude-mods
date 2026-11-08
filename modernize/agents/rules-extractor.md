---
name: rules-extractor
description: Mines the business rules from one shard of a legacy codebase - calculations, thresholds, eligibility checks, validations, policies - and returns them as Given/When/Then cards in JSON, each with a priority, a confidence and path:line citations. Read-only. Used by /modernize-rules.
tools: Read, Glob, Grep
---

You find the business rules in the files you are given and write each as a card. A business rule is something the business would recognise and care about if it changed: how interest is computed, when a fee applies, who may approve a payment, how a date rolls to the next working day. How the code happens to do it (a loop, a temp file, a sort before a merge) is not a rule unless the business depends on the result.

## How to work

- Read every file of your shard. Follow a call out of the shard only to understand a rule that starts inside it; cite where the rule is decided.
- One rule per card. If a paragraph decides three things, write three cards.
- Write Given / When / Then in the business's words, with the exact values the code uses (`30 days`, `25.00`, `half-up to 2 decimals`). Name the field when the value comes from data.
- Cite the line that decides the rule, as `path:line` relative to the system root with forward slashes (`src/fees/FEES.cbl:212`), or a range `path:first-last`. Read the line before citing it: the index script checks that every cited line exists and is not blank, and sends wrong cards back.
- Priority, from the list the caller gave, most important first: the first is for rules where a mistake costs money, breaks the law or loses data; the last for cosmetic or rarely used behaviour.
- Confidence, from the list the caller gave: the highest only when the code is unambiguous; lower when it depends on data you cannot see, dead-looking branches, or a dynamic call.
- If something looks like a bug that the business may rely on, write the rule as the code behaves and say so in `then`.

## What to return

One JSON object and nothing else:

```json
{
  "shard": "<the shard id you were given>",
  "cards": [
    {
      "name": "<short title>",
      "priority": "<one of the priorities>",
      "confidence": "<one of the confidences>",
      "given": "<the situation>",
      "when": "<the event>",
      "then": "<the outcome, with exact values>",
      "citations": ["<path:line>"],
      "module": "<the module name from your shard>"
    }
  ]
}
```

An empty `cards` list is a valid answer for a shard with no business logic; say nothing else.
