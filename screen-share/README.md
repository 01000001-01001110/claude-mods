# screen-share

Masks private details on screen while you present, stream or record, and shows a red ON AIR mark the whole time. It masks only what is drawn. The stored conversation, and what Claude reads, stay as they were.

Inspired by [screen-share](https://github.com/kenny1798/claude-mods).

## What it masks

| Category | Examples | Drawn as |
| --- | --- | --- |
| Keys, tokens and passwords | `sk-…`, `ghp_…`, `AKIA…`, JWTs, `Authorization:` and `Bearer` values, `password=`, `"api_key": "…"`, `--token …`, `user:pass@` in URLs, `?token=` in query strings, private key blocks | `••••••`, always six, so the length gives nothing away |
| Environment values | `export NAME=…`, `set NAME=…`, `NAME=…` in upper case, `$env:NAME = …` | `••••••` after the name |
| Home folders and user paths | `C:\Users\<you>`, `/c/Users/<you>`, `/mnt/c/Users/<you>`, `/Users/<you>`, `/home/<you>`, also with JSON-escaped slashes | `C:\Users\█████` |
| Emails | `ada@example.com` | `█` per character, up to 24 |
| Phone numbers | 9 to 15 digits with optional `+`, brackets, spaces, dots or dashes | `█…` |
| Money amounts | `$12,500`, `€3.5k`, `3.2k USD`, `100 dollars` | `█…` |
| IP addresses | IPv4, except `127.0.0.1` and `0.0.0.0` | `█…` |
| Names | two or more capitalised words in a row that are not common words (`Ada Lovelace`, but not `Claude Code`), plus the words in the `names` option | `█…` |

It also reads this machine's home folder, user name, machine name and user domain at session start, and masks them wherever they appear, as written.

## Where it masks

Everything a mod may rewrite before it is drawn, on the terminal and the desktop:

- Transcript rows: your prompts, Claude's replies, tool rows (input and output), tool results, slash command output, the run-in-background hint, the spinner text (on the desktop it names the file being worked on), and the notices under the logo.
- Folded tool groups (`Read 3 files`) are unfolded while on air, so each call gets its own masked row. Turn `unfoldGroups` off to keep them folded.
- Other mods: their panes, bands, placed rows, toasts, status lines, notices and log lines (`maskOtherMods`).

When you switch it on, rows already drawn in the live transcript are drawn again, masked.

## What it cannot mask

The mod API gives no way to rewrite these, so check them yourself before you share:

- **Dialogs the engine draws**: permission prompts, question dialogs, the trust prompt.
- **Built-in screens**: `/config`, `/context`, `/model`, `/status`, `/help`, the resume picker, the tasks list.
- **Status-line command output**: your `statusLine` script's line is printed as it is.
- **The prompt draft**: what you are typing, and anything pasted into the prompt box.
- **Rows printed before the toggle** into the terminal's scrollback (outside fullscreen mode). The terminal already holds that text. Clear the screen before you share.
- **The echo of a slash command's arguments**, such as the line above `/screen-share test <text>`'s reply.
- **Mods above screen-share** in the hook order: what they draw after it has had its turn.
- **The desktop app's own chrome**: window title, sidebar and session list.

It does not catch every secret either. A key with no known prefix and no `key=` or `token:` label in front of it shows unmasked, as does a single first name not given in the `names` option. It also masks some things that are not private, such as long runs of digits, which read as phone numbers.

## Use

| Command | Does |
| --- | --- |
| `/screen-share` | Switches it on or off. |
| `/screen-share on`, `off` | Switches it on or off. |
| `/screen-share status` | Says whether it is on and lists each category with its switch. |
| `/screen-share test <text>` | Shows how the text would look masked, whether or not it is on. |

While on air:

- a red `● ON AIR` band sits above the prompt with a **Turn off** button (hotkey `x` while the band has focus);
- the status line reads `● ON AIR`;
- the mode labels at the right of the footer include `on air`.

The switch is kept across sessions (`remember`), so a restart in the middle of a stream starts masked.

## Options

`names` (the plugin's settings): a comma-separated list of names or words to mask whenever it is on, such as clients, companies or your own name.

## Tuning

Everything is in [`data/screen-share.ts`](data/screen-share.ts):

- `categories`: each category's switch, its label in `/screen-share status`, and its mask style.
- `masks`: the glyph and length of each mask style.
- `rules`: one regular expression per rule, run in order. A named group `keep` at the start and `tail` at the end stay showing. `minDigits`, `allow` and `skipCommonWords` filter matches.
- `notNames`: capitalised words that are never names. `alwaysHide` and `minHideLength`: words to mask beside the `names` option.
- `machine`: which of this machine's values are masked, under which category and from what length.
- `deepLimit`, `unfoldGroups`, `maskOtherMods`, `remember`, `colors`, `hotkeys`, `verbs`, `text`.

## Checks

```sh
claude plugin validate screen-share
npx -p typescript tsc -p screen-share
claude plugin test screen-share
node screen-share/scripts/check-data.mjs
```

## Install

At the prompt of a Claude Code terminal session:

```
/plugin install screen-share --marketplace 01000001-01001110/claude-mods
```
