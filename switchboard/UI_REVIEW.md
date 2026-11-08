# Switchboard UI review

Desktop is the priority in this review. The terminal should use the same state model and words, but it may collapse the same information into one column.

The redesign below stays inside the Claude Code mod UI API. Desktop has `Box`, `Text`, `Button`, `Input`, `Select`, `Svg`, `Link`, `Code`, `Markdown`, and `Client` (`claude-code.d.ts:4031-4041`). This proposal needs only the first five. `Box` supports row/column layout, wrapping, gaps, fixed or percentage sizes, padding, borders, background color, overflow, and hover (`claude-code.d.ts:928-1023`). `Text` supports theme colors, semantic sizes and weights, monospacing, tabular digits, and wrapping or truncation (`claude-code.d.ts:13719-13785`). `Button` supports native primary/secondary treatment, a dismiss role, autofocus, hotkeys, plain treatment, and styled text children (`claude-code.d.ts:1093-1198`). `Input` and `Select` are supported on desktop and terminal (`claude-code.d.ts:5716-5771`, `claude-code.d.ts:11380-11425`). The pane supplies its actual `bodyColumns`, placement, focus, and scroll window (`claude-code.d.ts:11148-11193`), and `ui.open` supports focus, Escape-to-close, requested rows and columns, and a pane background (`claude-code.d.ts:7787-7870`). There is no table, switch, badge, disabled-button, sticky-header, or tooltip element. Where this review says card, badge, banner, or disabled, it specifies how to make that state from supported elements.

## 1. What is drawn today

### Opening and overall structure

`/switchboard` and the optional `/mods` alias refresh the switch file and known-mod listing, then call `$.ui.open({ id: 'switchboard', title: 'Switchboard' })` (`switchboard/hooks/register.tsx:119-138`). The open does not request focus, Escape-to-close, rows, or columns. The title is normally only useful as a pane tab; the API draws no pane title when only one pane is open. There is no title inside the body.

One `ui.render` hook draws the pane, with no branch for `e.surface`, `e.props.bodyColumns`, `e.props.placement`, `e.props.scroll.bodyRows`, or `e.props.isFocused` (`switchboard/hooks/register.tsx:185-233`). Terminal and desktop therefore receive the same tree:

1. A column `Box` with `gap={1}`.
2. One bold header: `N mods. A switch takes effect at the mod's next load.`
3. One column `Box` per mod.
4. A switch-file error, if one exists.
5. The switch-file path and five always-visible footnotes.

The header, path, all labels, glyphs, colors, and footnotes come from `data/switchboard.ts`, as the repository standard requires (`STANDARDS.md:5-19`; `switchboard/data/switchboard.ts:27-88`). The current type contract exposes only a pane title; it has no layout sizes, breakpoints, borders, spacing, filters, empty-state copy, or view-state copy (`switchboard/types/index.d.ts:91-143`).

### Which rows appear

`buildRows` places the two configured pinned mods first, then every judged, listed, switched-off, or hidden mod in name order, and removes switchboard itself (`switchboard/hooks/rules.ts:131-153`). A row contains the name, how switchboard saw it, the saved off/hidden flags, a refused-pane count, and an optional pinned note (`switchboard/types/index.d.ts:28-38`). The two pinned notes are long instructional sentences (`switchboard/data/switchboard.ts:15-18`). There are no section headings to explain why those two rows are first.

### Per-row layout

Each row is a vertical stack (`switchboard/hooks/register.tsx:199-219`):

- A single `Text` colors the glyph, name, power phrase, hidden glyph, hidden phrase, and refusal count together.
- A row `Box` contains two native `Button`s: power first, pane visibility second.
- A pinned note is a separate subtle `Text` under the buttons.

There is no border, card background, fixed label column, width, truncation, wrapping rule, hover treatment, or alignment rule. Button labels have different lengths, so the second action moves horizontally from row to row. Desktop happens to draw native buttons because that is the surface's treatment of `Button`; the plugin does not opt into a primary action or any other desktop hierarchy.

### Power states

The displayed power phrase is derived from `sighting` and the saved off flag (`switchboard/hooks/rules.ts:155-171`):

| How switchboard saw the mod | Saved off? | Current phrase | Current look |
| --- | --- | --- | --- |
| Judged and allowed at load | No | `on` | `success`, `●` |
| Judged and allowed at load | Yes | `off at its next load` | `warning`, `◐` |
| Refused at load | Yes | `off` | `inactive`, `○` |
| Refused at load | No | `on at its next load` | `warning`, `◐` |
| Known only from commands/settings | No | `on` | `success`, `●` |
| Known only from commands/settings | Yes | `off from its next reload (it loaded before switchboard)` | `warning`, `◐` |
| Named only by data/file | No | `not loaded` | `inactive`, `○` |
| Named only by data/file | Yes | `off: refused when it loads` | `inactive`, `○` |

The important weak point is the `listed` row. Its source only proves that the name appeared in settings or commands (`switchboard/hooks/rules.ts:101-128`). It could have loaded before switchboard, have no hooks module, or have failed to load. Nevertheless, an unswitched listed row is shown as green `on`. The README acknowledges the uncertainty and the fact that plugins without hooks cannot be switched (`switchboard/README.md:30-36`), but the pane does not.

### Pane visibility states

When `isHidden` is false, the row says nothing about panes. When true, the same power-colored line appends `▫ panels hidden`, or `▫ panels hidden, N refused` (`switchboard/hooks/rules.ts:174-177`; `switchboard/hooks/register.tsx:201-203`). The pane action is labelled `Hide panels` or `Show panels` (`switchboard/data/switchboard.ts:65-70`). That wording overstates the operation: existing panes stay open, and only future `ui.open` calls that pass beneath switchboard can be refused (`switchboard/README.md:33-35`). A listed mod may be out of reach, but its row still says `panels hidden` before any refused open proves that the rule is working.

### Buttons and keyboard

Power is always labelled `Switch off` or `Switch on`; pane control is always `Hide panels` or `Show panels` (`switchboard/hooks/register.tsx:204-216`). The labels do not state whether the result is immediate, next-load, next-reload, or only a request for an unobserved mod.

Rows 1-9 receive power hotkeys `1`-`9` and pane hotkeys `q`-`o`; later rows receive no hotkey (`switchboard/data/switchboard.ts:23-26`; `switchboard/hooks/rules.ts:185-188`). The mapping is by current row index, so a newly discovered or newly pinned mod can change what a key does. The buttons do not show a separate shortcut hint, and the pane is not opened focused. Keyboard users must first focus the pane, remember two unrelated key rows, and use Tab after the ninth mod. The README is the only complete shortcut legend (`switchboard/README.md:16`).

### Feedback, error, and empty states

A press writes the file, updates state, and sends the result as a toast (`switchboard/hooks/register.tsx:90-116`, `switchboard/hooks/register.tsx:141-144`). The redraw changes the row, but the pane has no local `Saved`, `Saving`, or failure message next to the action. There is no guard against a second press while the first write is in flight.

If the switch file is invalid, switchboard deliberately uses no switches and preserves the broken file (`switchboard/hooks/register.tsx:65-76`, `switchboard/hooks/register.tsx:98-111`). The error appears only after every mod row, directly before the footer (`switchboard/hooks/register.tsx:222`). All action buttons still look available. Pressing one produces a failure toast. With no home folder, the pane can show both `Switch file problem: no home folder` and the misleading footer `Switches saved in ` with a blank path.

The shipped data always pins two rows, so a normal pane cannot be empty. If a retune removes the pinned rows and no mod is known, the pane draws `0 mods`, the path, and all footnotes. It has no empty explanation or refresh action. Only `/switchboard list` has `No mods known yet.` (`switchboard/hooks/rules.ts:202-209`). A thrown or invalid render has no `.catch` fallback; unlike the agent-roster pane, it can leave an empty or closed pane.

### Terminal and text-command views

The terminal pane is the same tree and same ordering as desktop. The terminal renderer supplies brackets, hotkey marks, theme colors, and its own wrapping. `/switchboard list` is separate: one line per mod, using the same power glyph/phrase and optional hidden suffix (`switchboard/hooks/rules.ts:202-209`). It does not include pinned notes, action timing, the switch-file problem, or the full explanation of an unobserved mod.

### Current test coverage of the drawing

The tests deliberately mount both terminal and desktop (`switchboard/hooks/switchboard.test.tsx:67`, `switchboard/hooks/switchboard.test.tsx:140-167`). They assert text, button labels, order, hotkeys, state changes, footnotes, file errors, and the file path (`switchboard/hooks/switchboard.test.tsx:217-307`). They also assert both surfaces after a press and after refused pane opens (`switchboard/hooks/switchboard.test.tsx:310-334`, `switchboard/hooks/switchboard.test.tsx:403-424`).

They do not assert `Box` structure, colors, borders, typography, variants, focus, open sizing, wrapping, overflow, long labels, narrow/wide widths, scroll behavior, hover, action-in-flight state, or a rendered empty state. The draw helper throws away every property except text and each button's key, label, and hotkey (`switchboard/hooks/switchboard.test.tsx:147-159`).

## 2. Problems, ranked by user harm

1. **The pane presents unknown state as known state.** A listed mod is green and `on` even though switchboard did not judge its load. The same row may represent an early load, a hooks-free plugin that cannot be controlled, or a failed load. A hidden listed mod says its panels are hidden even when switchboard has never refused one. This is the most damaging problem because users can make decisions from a false success state.

2. **Desktop has no visual hierarchy.** The single bold sentence, repeated unframed rows, and five-line legal footer all have nearly equal visual weight. There is no internal title when one pane is open, no summary, no sections, and no attention area. A user cannot answer “what is running, what needs a reload, and what is blocked?” at a glance.

3. **The action labels hide the consequence.** `Switch off` does not say “next load”; `Hide panels` sounds as if existing panes will disappear. The status sentence carries the caveat while the control that causes the state does not. This makes the most consequential click ambiguous.

4. **A broken switch file looks actionable.** The error is below the full list and the buttons retain normal affordance. The only feedback after a futile click is a toast. A broken path or write error needs to be the first thing after the header, and the pane must not draw controls that cannot work.

5. **The layout does not scale to the repository's mod count.** Every mod costs a status line, a button line, and sometimes a note, followed by five footnotes. The pane relies on incidental engine scrolling and gives no count by state, search, filter, or condensed mode. The first nine rows get shortcuts; all later rows require a long Tab walk or pointer scrolling.

6. **Rows do not hold together visually on desktop.** A status line, two buttons, and an optional note have no border or shared background. Long notes and variable button widths make one row blend into the next. The power and pane actions are adjacent even though they have different timing and reach.

7. **Long names and narrow panes are unmanaged.** The render never reads `bodyColumns` or placement and no primary text has a `wrap` policy. Long names make action placement irregular and can wrap the status into extra lines. Wide desktop panes waste horizontal space instead of using two columns; narrow panes get the same layout with accidental wrapping.

8. **State is encoded by one color wash.** The entire row, including the mod name and pane state, takes the power color. Hidden panes have no independent color. Off/not-loaded uses `inactive`, which may be deliberately low contrast in light or dark themes. Pending and unknown are not distinct. Glyphs help, but `○` currently means both “off” and “not loaded.”

9. **Keyboard support exists but is hard to discover and unstable.** The pane does not request focus, the shortcuts are not summarized in the pane, only nine rows qualify, and index-based keys can point to a different mod after discovery or filtering. There is no Escape-to-close request or explicit dismiss control matching the agent-roster pane.

10. **Feedback is transient and has no progress state.** Success and failure are toast-only. A user looking at the clicked card has no local acknowledgement, and a slow write leaves the same active buttons available. The final row update is helpful but does not say that the save completed.

11. **The header explains only half of the model.** It says that “a switch” takes effect at next load even though pane blocking is meant to take effect immediately. The result is technically inaccurate and forces the footnotes to repair it.

12. **Pinned model/effort helpers are unexplained as a group.** They appear before the alphabetic list but look like ordinary mods. Their long notes repeat information and make the top of the pane especially tall.

13. **The always-open footer overwhelms the task.** Five caveats plus an absolute file path are useful reference material, not primary content. They push errors and later mods farther away. The blank-path case is actively misleading.

14. **The empty state is only a count.** This is reachable after a data retune and is worth handling because discovery can also fail. `0 mods` plus caveats gives no next step.

15. **There is no render-failure state.** the agent-roster pane catches draw failures and leaves a readable warning (`agent-roster/hooks/register.tsx:933-944`). Switchboard has no equivalent.

16. **The pane does not match the repository's strongest desktop UI.** the agent-roster pane uses an internal header and native dismiss control, rounded semantic frames, right-aligned secondary state, width-aware layouts, truncation, optional sections, and extra air on graphical surfaces (`agent-roster/hooks/deck.tsx:197-261`, `agent-roster/hooks/deck.tsx:872-955`). Diff Review uses a title/summary row, progress, bordered content and action regions, primary actions, fixed-height layout, explicit truncation, and scroll controls (`diff-review/hooks/register.tsx:394-431`, `diff-review/hooks/register.tsx:514-587`). Switchboard uses none of those established patterns.

17. **The UI tests prove content but not usability.** The same text assertions on two surfaces can pass while desktop remains a poorly laid-out stack. There are no width-matrix or spill checks like the agent-roster pane's tests, and no assertions on semantic visual props.

## 3. Proposed desktop redesign

### Wide desktop mockup

```text
SWITCHBOARD                                              ✕
Power changes apply on next load. Pane blocking applies now.

12 mods   7 running   2 scheduled   1 off   2 not observed   1 pane-blocked

Find  [ mod name...                         ]   Show [ All mods        v ]

! Switch file could not be read: Unexpected token ...                 [Retry]
  Fix ~/.claude/switchboard.json before changing switches.

MODEL AND EFFORT HELPERS
+--------------------------------------+  +--------------------------------------+
| ● turn-prefix              RUNNING   |  | ● effort-picker            RUNNING   |
| Now        Running                   |  | Now        Running                   |
| Next load  On                        |  | Next load  On                        |
| Panes      New panes allowed         |  | Panes      New panes allowed         |
| Model shortcut: _ Haiku, + max.      |  | Suggestions: /effort-picker.         |
| [1 Turn off next load] [Q Block new panes]                             |
+--------------------------------------+  +--------------------------------------+

MODS
+--------------------------------------+  +--------------------------------------+
| ◐ handoff                SCHEDULED   |  | ? skill-only-mod      NOT OBSERVED   |
| Now        Running                   |  | Now        Load state unknown        |
| Next load  Off                       |  | Next load  No request                |
| Panes      Blocking new panes (2)    |  | Panes      Reach unknown             |
| [2 Keep on] [W Allow new panes]      |  | [3 Request off] [E Block new panes]  |
+--------------------------------------+  +--------------------------------------+

Saved: handoff will stay on at its next load.

[How switching works]
```

The error banner is shown in the mockup to make its position clear. In a healthy pane it is absent. While the file is broken, the cards remain readable but their action buttons are replaced with `Fix the switch file to make changes`; `Retry` is the only switch-related button. This is necessary because the API has no disabled-button prop.

On a narrow desktop pane, the two columns become one. Text sizes become useful on desktop and are harmless on terminal, which ignores them. The design uses words and glyphs as well as colors, so light/dark theme differences do not change the meaning.

### State model used by the redesign

Do not force current state and next-load intent into one phrase. Derive a pure row view model with separate `now`, `nextLoad`, `panes`, `tone`, and `attentionReason` fields.

| Sighting and saved switch | Now | Next load | Power action |
| --- | --- | --- | --- |
| `judged`, not off | Running | On | Turn off next load |
| `judged`, off | Running | Off | Keep on |
| `refused`, off | Off | Off | Turn on next load |
| `refused`, not off | Off | On | Keep off |
| `listed`, not off | Not observed | No off request | Request off on reload |
| `listed`, off | Not observed | Off requested | Cancel off request |
| `absent`, not off | Not loaded | On when loaded | Turn off when loaded |
| `absent`, off | Not loaded | Off when loaded | Allow when loaded |

“Not observed” must expand in supporting text to “Loaded before Switchboard, has no hooks module, or did not load.” Those cases cannot be separated with the data the mod currently has. Do not call such a mod running, on, broken, or switchable. A refused-pane count proves that pane blocking worked; without that proof, a listed row should say `Block requested; reach not observed`, not `panels hidden`.

### Concrete changes

1. **Add an internal header and explicit close control.**

   - Elements/props: a top `Box` with `justifyContent="space-between"`, `alignItems="center"`, and `width={bodyColumns}`; a `Text size="title" weight="semibold" color={t.colors.heading}`; and `Button key="dismiss" role="dismiss" plain label={t.text.closeLabel}` with the close glyph as its child. The handler calls `$.ui.close({ id: PANE_ID })`. This follows the agent-roster pane's header pattern (`agent-roster/hooks/deck.tsx:215-231`).
   - Data/tunables: add `pane.closeGap`, `glyphs.close`, `colors.heading`, `text.brand`, and `text.closeLabel` to `data/switchboard.ts` and the `Tuning` contract.
   - Test: mount one-pane terminal and desktop drawings, assert the internal title exists, assert the dismiss button has `role: 'dismiss'`, press it, and assert the engine receives the close. Assert the title and label come from shipped tuning.

2. **Replace the current header sentence with a two-level summary.**

   - Elements/props: under the title, draw `Text size="body" color={t.colors.note}` for `Power changes apply on next load. Pane blocking applies now.` Then draw a `Box flexDirection="row" flexWrap="wrap" columnGap={...} rowGap={...}` of short `Text` runs for total, running, scheduled, off, not observed, and pane-blocked counts. Use `tabular` on the numbers.
   - Data/tunables: add all summary labels/templates, `pane.summaryGap`, and one color per semantic state. Counts come from the pure row view models, not from new runtime sources.
   - Test: seed rows covering all eight power combinations plus hidden panes; on both surfaces assert every count and the exact timing subtitle. Change one row through a button and assert the summary redraws.

3. **Make state honest and scan-friendly.**

   - Elements/props: each card gets a status word in the top-right `Text size="footnote" weight="semibold" color={tone}` and three labelled lines: `Now`, `Next load`, and `Panes`. Each line is a row `Box overflow="hidden"`; its label sits in a fixed-width `Box flexShrink={0}`, and its value is a `Text wrap="truncate-end"`. Never color the whole card's text.
   - Data/tunables: replace the overloaded `text.power` presentation with tunable `text.now`, `text.nextLoad`, `text.panes`, `text.attention`, and action maps keyed by a new pure view-state union. Add `glyphs.running`, `off`, `scheduled`, `unknown`, `notLoaded`, `paneBlocked`, and `problem`. Add `pane.labelColumns`. The current `Sighting` remains runtime truth; the new state is derived from it.
   - Test: replace the current single-line state expectation with a table-driven assertion for all eight combinations on both surfaces. Specifically assert that a `listed` row contains `Not observed` and never contains the running/on copy. Assert the glyph, text, and theme color for each state.

4. **Put switch-file failure first and remove false affordance.**

   - Elements/props: immediately below the summary, draw an error `Box flexDirection="column" borderStyle="round" borderColor={t.colors.problem} paddingX={1} paddingY={1}`. The first row has a bold error `Text` and a `Button key="retry" variant="primary"`; the second line contains the problem and non-empty path with `Text wrap="wrap"`. When `fileProblem !== ''`, render card actions as a problem `Text`, not `Button`s. Do the same while there is no home path. The retry handler calls the existing refresh functions.
   - Data/tunables: add `text.problemTitle`, `problemBody`, `problemNoPath`, `actionsUnavailable`, `retry`, plus banner border/padding values. Keep all error colors as theme keys. Do not add a fake disabled style because the API does not support disabled buttons.
   - Test: for malformed JSON, no home folder, and a failed write, assert the banner precedes every card, includes the right path wording, has only the retry action, and draws no power/pane buttons. Repair the test file, press Retry on desktop, and assert the banner disappears and actions return. Assert no blank `Switches saved in ` line.

5. **Split special helpers from ordinary mods.**

   - Elements/props: draw a section heading `Text size="heading" weight="semibold" color={t.colors.section}` before the pinned cards and another before normal cards. Omit either section when filtering leaves it empty. Keep the configured pinned order and alphabetic ordinary order.
   - Data/tunables: add tunable `text.sections.helpers` and `text.sections.mods`. Shorten the two shipped notes to compact supporting copy. If future pinned entries need other sections, extend `Pinned` with a data-defined `section` id rather than hard-coding names.
   - Test: assert headings and order on both surfaces; filter to a normal mod and assert the empty helper section is omitted. Assert every pinned note displayed is the shipped compact note.

6. **Use a responsive card grid on desktop.**

   - Elements/props: the card container is `Box flexDirection="row" flexWrap="wrap" columnGap={t.pane.cardGap} rowGap={t.pane.cardGap}`. At or above `pane.twoColumnsFrom`, compute two numeric card widths from `e.props.bodyColumns`; below it use one card at the full body width. A card is `Box flexDirection="column" borderStyle="round" borderColor={tone} paddingX={1} paddingY={...} width={cardWidth} overflow="hidden"`. Do not size from `viewport.columns`, because a docked pane's body is narrower.
   - Data/tunables: add `pane.twoColumnsFrom`, `cardGap`, `cardPaddingX`, `cardPaddingY`, and `cardBorder`. The breakpoint and every space are data under the house rules.
   - Test: mount desktop at widths just below, at, and just above the breakpoint. Assert one/two card widths, wrapping, no width greater than `bodyColumns`, and preserved source order. Repeat narrow and wide terminal mounts to prove the common tree validates there. Add a simple spill checker modelled on `agent-roster/hooks/roster.test.tsx` and run it over a useful width range.

7. **Control long names, notes, and changing counts.**

   - Elements/props: place the name in a width-bounded `Box overflow="hidden"` and use `Text size="heading" weight="semibold" wrap="truncate-end"`. Use `Text size="footnote" color={t.colors.note} wrap="wrap"` for the short pinned note. Use `tabular` for the refused count. Action rows use `flexWrap="wrap"` rather than overflow.
   - Data/tunables: add `pane.nameReserve`, `pane.actionGap`, and a maximum intended length for pinned note copy to the data check. Do not hard-slice names in JSX; let the surface truncate them.
   - Test: seed a very long mod name, a long refusal count, and enough rows to scroll. At narrow and wide widths on both surfaces, assert the name `Text` has the truncation prop, the card has hidden overflow, buttons remain whole, and the tree validates.

8. **Treat pane blocking as its own status and use accurate words.**

   - Elements/props: the `Panes` line always appears. Draw `New panes allowed`, `Blocking new panes`, `Blocked N this session`, or `Block requested; reach not observed` with its own glyph and color. The pane action sits next to the power action but has its own semantic label.
   - Data/tunables: replace `panelsHidden`, `panelsRefused`, `buttonHide`, and `buttonShow` with the four status strings and `blockNewPanes`/`allowNewPanes`. Add separate `colors.panesAllowed`, `panesBlocked`, and `panesUnknown`. Continue to derive proof from `refusedOpens` and reach from `sighting`.
   - Test: cover allowed, newly blocked with zero refusals, blocked with one/many refusals, listed-and-blocked with no proof, and a listed row with a positive refusal count. Assert power color cannot leak into the pane text.

9. **Make every button say the result and mark only the corrective action primary.**

   - Elements/props: use the action copy in the state table above. Use `variant="primary"` for `Keep on`, `Turn on next load`, or another action that resolves an off/pending state; use secondary/default for scheduling off and pane blocking. Put actions in `Box flexDirection="row" flexWrap="wrap" gap={t.pane.actionGap}`. A button may contain a subtle shortcut `Text` child followed by the action text, while its stable `key` remains `power-${name}` or `panels-${name}`.
   - Data/tunables: add a complete action map for the derived states and a tunable decision of which action ids are primary. Keep keys and all visible shortcut text in data.
   - Test: table-test every state for label, verb, and variant. Press each inverse pair and assert the exact switch file plus new state. Assert actions wrap rather than overflow at the minimum supported width.

10. **Make keyboard behavior visible and predictable.**

   - Elements/props: keep hotkeys only for the first nine *visible* cards, but draw the assigned key inside each button and add a short help `Text size="footnote"`. Open the pane with `focus: true` and `closeOnEscape: true`. Do not autofocus a destructive row action. All later actions remain reachable by Tab/Shift+Tab and Enter. The explicit dismiss button supports pointer and focus users.
   - Data/tunables: retain `keys.power` and `keys.panels`, add `text.shortcutHelp`, `text.noShortcut`, and tunable pane focus/close behavior if this repository wants those choices data-first. State clearly that keys follow the visible filtered order.
   - Test: assert visible key text matches each `hotkey`, filtering remaps both together, the tenth visible row has neither, and `ui.open` receives focus and Escape-to-close. Assert no action has `autoFocus`.

11. **Add search and a status filter for long lists.**

   - Elements/props: use `Input key="mod-search" label={...} placeholder={...} value={query} onInput={...} onSubmit={...}` and `Select key="mod-filter" label={...} options={...} value={filter} onSelect={...}` in a wrapping control `Box`. Options should be All, Needs attention, Running, Off, Not observed, and Pane-blocked. Search matches names and configured notes case-insensitively. It must not mutate switch data.
   - Data/tunables: add all labels, placeholder, option values/labels, and `pane.filterGap`. Add shaped session UI atoms for query and filter so reloads reject old shapes. The filter ids are structural; their visible words are data.
   - Test: type a query through `ui.input` and choose every option through `ui.select` on desktop and terminal. Assert matching cards, section omission, summary counts remaining global, and hotkeys being reassigned to visible cards. Test zero matches separately from zero known mods.

12. **Give a press local progress and durable feedback.**

   - Elements/props: when a card operation starts, replace both actions on that card with `Text color={t.colors.pending}` saying `Saving...`; there is no supported disabled prop. After completion, show one pane-level result line below the grid: success in `success`, failure in `error`. Keep failure toasts for visibility outside the pane; success toast can be removed to avoid duplicate feedback. Use the full result sentence, not only `Saved`.
   - Data/tunables: add `text.saving`, success/failure templates, and colors. Add shaped UI state for the pending mod/verb and last result. Clear or replace the result on the next action; no timer is needed.
   - Test: hold `fs.write` unresolved, press a desktop action, and assert the buttons are replaced by `Saving...`; resolve it and assert the result line plus updated card. Repeat with a rejected write and assert error line, toast, unchanged switch, and the top problem banner.

13. **Move caveats and the file path behind concise help.**

   - Elements/props: leave the two timing sentences visible near the top. At the bottom draw `Button key="help" plain` labelled `How switching works`. When open, draw a `Box flexDirection="column" borderStyle="single" borderColor={t.colors.note} paddingX={1}` containing the detailed caveats and a path line. Draw the path as `Text mono size="footnote" wrap="truncate-middle"`; terminal ignores `mono` because it is already monospaced. Hide the path line when no path exists.
   - Data/tunables: keep detailed caveats in `text.helpLines`, add help open/closed labels, path label, border/padding, and a shaped `helpOpen` UI atom. Rewrite the caveats into short independent lines; do not lose any limitation documented in the README.
   - Test: assert help is closed initially, press it on both surfaces, and assert every shipped line and a non-empty path. Press again and assert collapse. Assert error state still shows the path at the top even when help is closed.

14. **Add real empty and no-match states.**

   - Elements/props: when there are no known rows, draw a rounded bordered `Box` with heading, explanation, source hint, and `Button key="refresh"`. When rows exist but filters match none, use a different message and `Button key="clear-filter"`. Do not show an empty `MODS` heading.
   - Data/tunables: add `text.emptyTitle`, `emptyBody`, `refresh`, `noMatchesTitle`, `noMatchesBody`, and `clearFilter`; use existing section/card spacing.
   - Test: expose the shared pane renderer so an inline test plugin can call it with `{ ...T, pinned: [] }`, then mount it through the engine on both surfaces. Assert the empty action refreshes listing. Separately filter a non-empty list to zero and assert Clear filter restores it. A pure `buildRows` test alone is not enough because the problem is visual.

15. **Use engine-owned scrolling deliberately.**

   - Elements/props: let the pane scroll the complete tree; do not add a custom `Client` scrollbar. Size and compact the content using `e.props.bodyColumns` and read `e.props.scroll.bodyRows` for testable layout decisions. Keep every card/action key stable so focus survives redraws. After Clear filter or Retry, use `$.ui.scroll({ to: 'start', in: PANE_ID })`; after an action, use `{ to: { key: cardKey }, in: PANE_ID, block: 'nearest' }` only if the redraw moved the card.
   - Data/tunables: add requested `pane.rows` and `pane.columns` for `ui.open`; scroll targets are structural, not tunables.
   - Test: mount many mods with a short `bodyRows`, assert the full tree is taller than the window, scroll to end/start through the engine, and press an action after scrolling. Assert stable keys and that filtering returns to the start. Test `ui.open` receives the shipped row/column requests.

16. **Use semantic theme keys and non-color cues only.**

   - Elements/props: keep names in `text`; reserve `success` for observed running, `warning` for a scheduled transition, `inactive` for an explicitly off/not-loaded secondary value, `suggestion` for not observed, `permission` for blocked panes, and `error` for file/write failure. Pair each with a word and glyph. Use status color on the card border, not as a low-contrast fill. Native buttons handle their own light/dark treatment.
   - Data/tunables: expand the `ColorKey` use and semantic color map. Use no fixed hex colors and no background color for essential meaning.
   - Test: inspect the drawn props for each state and assert they equal the shipped theme keys. Also assert every colored status has a distinct visible word/glyph, so the test does not pretend to measure rendered contrast.

17. **Add a render fallback.**

   - Elements/props: attach `.catch` to the pane render hook. Return a small column `Box` with internal title, an error `Text wrap="wrap"`, and dismiss `Button`. Do not attempt the full card tree again.
   - Data/tunables: add `text.drawFailed` and reuse heading/problem colors and close copy.
   - Test: force the render dependency to throw, mount terminal and desktop, and assert the fallback remains readable and closable. This mirrors the proven the agent-roster pane approach instead of allowing an empty pane.

## 4. Terminal changes for parity

The terminal should not keep the old words while desktop gets the honest state model.

- Use the same internal title, timing subtitle, summary counts, error banner, section headings, three state fields, action labels, result line, filters, and collapsible help. `Text.size`, `weight`, `mono`, and native button variants degrade safely because the terminal maps or ignores them as documented.
- Use one card per row at normal dock widths. At a genuinely wide inline width, the same `twoColumnsFrom` rule may allow two columns, but only after width-matrix tests prove that the terminal's button chrome fits.
- Keep the visible shortcut mark beside every assigned `hotkey`. Say in the help that shortcuts cover the first nine visible rows; after that, Tab and Enter work. A hidden, undocumented `q`-to-`o` mapping is not enough.
- Let the pane's engine-owned scroll window handle a long tree. Do not reproduce Diff Review's custom scrollbar because Switchboard does not have an independently scrolling inner document.
- Update `/switchboard list` to use the same truth: `name - now: Running; next load: Off; panes: Blocking new panes (2)`. A listed mod must say `Not observed`. Put the switch-file problem before the rows and omit `Switches saved in` when there is no path. Update `listLines` to receive the board problem or create a shared pure text view from the same row view model.
- Preserve the terminal's concise nature by keeping help collapsed and using one-line state fields where width permits. Do not remove caveats; move them behind Help exactly as on desktop.
- Test the terminal and desktop separately where their layout differs. A loop that expects identical flat text is no longer sufficient, but both surfaces should assert the same semantic state and actions.

## 5. Quick wins, larger changes, and order

### Quick wins

These are small and safe because they need little or no new interaction state:

1. Rewrite the header to state both timing rules.
2. Rewrite `Hide panels`/`Show panels` as `Block new panes`/`Allow new panes`.
3. Give each power state a consequence-specific action label.
4. Stop coloring the whole row; color only status words/glyphs, and give pane state its own semantic color.
5. Add explicit wrapping/truncation to names, notes, status, path, and error text.
6. Move the switch-file problem above the rows and omit action buttons while it is broken.
7. Add `focus`, `closeOnEscape`, requested rows/columns, and the internal dismiss button.
8. Shorten the two pinned notes and replace the five always-visible footnotes with a concise top subtitle plus a help block. If adding collapsed state is deferred, a bordered `How switching works` block is still better than loose footer lines.
9. Add a `.catch` fallback to the render hook.

### Larger changes

These need new pure rules, UI state, or substantial test work:

1. Split `now`, `next load`, capability uncertainty, and pane reach into a new row view model.
2. Build the responsive, two-column desktop card grid and section hierarchy.
3. Add summary counts, search, and status filtering.
4. Add operation-in-flight and last-result state.
5. Add the rendered empty/no-match states and Retry/Clear interactions.
6. Rework `/switchboard list` from the shared view model.
7. Add width, spill, scrolling, structure, color-prop, focus, and failure-fallback tests.

### Recommended implementation order

1. **Truth first:** introduce the derived row view model and tests for every sighting/off/hidden combination. Update pane and list wording together.
2. **Safety second:** move file errors to the top, remove unavailable actions, add Retry, correct the no-path case, and add the render fallback.
3. **Desktop structure:** add internal header/dismiss, sections, semantic card anatomy, responsive widths, truncation, theme roles, and the compact help treatment.
4. **Actions and keyboard:** add result-specific labels, variants, visible shortcuts, focused opening, Escape-to-close, and stable card keys.
5. **Scale:** add summary counts, search, filters, empty/no-match states, and deliberate scrolling behavior.
6. **Feedback:** add pending and last-result state once the action layout is stable.
7. **Proof:** replace the flat draw helper with semantic and structural helpers; run the terminal/desktop width matrix, long-name/many-mod cases, all error paths, every interaction, typecheck, plugin tests, and the data checker. Finish with a live desktop pass in both light and dark themes because the test kit validates props and behavior, not actual contrast or pixel spacing.

That order prevents a polished card from continuing to claim that an unobserved mod is on. The first release should be honest and safe even if search and two-column cards land later.
