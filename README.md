# pi-devin

A [Pi](https://pi.dev) package that uses **Devin Local** models inside Pi.

Pi stays the harness. The [Devin CLI](https://docs.devin.ai/cli) owns login and the live model catalog (`devin auth`, `devin models list`). This is not an ACP integration and does not use Zed.

## Why this exists

`pi-devin-auth` treated Devin as Cascade cloud chat. Models like Sol High, Opus 5, and Fable 5 then failed with:

```text
This model is only in Devin Local.
```

Those models are available through the local Devin CLI. This package uses that CLI for auth + catalog, then streams completions into Pi so Pi's tools, sessions, and UI stay in charge.

## Requirements

- Pi Coding Agent 0.86+
- A signed-in [Devin CLI](https://docs.devin.ai/cli) (`devin auth status`)
- Node 22.19+ (required by Pi 0.86)

The CLI binary is resolved in this order:

1. `$DEVIN_CLI`
2. `~/.local/bin/devin`, Homebrew, `/usr/local/bin/devin`
3. Devin.app's bundled `devin` binary
4. `which devin`

On Windows, discovery checks the CLI installer and Devin Desktop locations, then uses `where.exe` to search PATH. Native executables and `.cmd`/`.bat` wrappers are supported, including paths with spaces. `DEVIN_CLI` takes precedence on every platform.

## Install

From git:

```bash
pi install git:github.com/kashyab12/pi-devin
```

From npm:

```bash
pi install npm:pi-devin
```

Version 0.2.0 requires Pi 0.86+ and Node 22.19+. It restores system instructions and tools on the current Pi transcript format and sends system instructions through Devin's dedicated prompt field. Version 0.1.2 predates Pi 0.86 support.

`pi-devin-local` is a separate npm package maintained in the [mizorewww/pi-devin fork](https://github.com/mizorewww/pi-devin). Changes merged here do not update that package. Install only one: both packages register the `devin` provider, so their registrations can overwrite each other.

Local checkout:

```bash
pi install /Users/kashyab/pi-devin
```

Restart Pi or run `/reload`.

## Usage

```text
/login devin
/model devin/claude-opus-5-high
/model devin/claude-5-fable-high
/model devin/gpt-5-6-sol-high
```

`/login devin` runs `devin auth login` if `~/.local/share/devin/credentials.toml` is missing. If you already signed in through the Devin CLI or Devin Desktop, that file is reused.

Commands:

- `/devin-status` — CLI path, version, auth
- `/devin-refresh` — reload `devin models list --format json`
- `/devin-usage` — show account daily/weekly quota, reset times, plan status, and your on-demand usage

### Account usage

Run `/devin-usage` to fetch billing information using your existing CLI login. It only runs on demand, makes no model requests, and does not poll in the background. Results appear as a UI notification, outside the model context and session history. Quota percentages show consumption, not remaining allowance; reset times use your local timezone. These are account quotas, not token usage or a cost estimate for the current Pi session.

This command sends the CLI Bearer credential only to the fixed `https://app.devin.ai` origin. It discovers your current organization through `/api/users/current-membership`, then reads `/billing/quota/usage`, `/billing/status`, and `/billing/quota/my-on-demand-usage` under that organization's `/api/<org-id>` path. It ignores configured alternative webapp hosts, rejects redirects, caps response sizes, and times out after 20 seconds. Membership personal data and raw responses are not displayed or persisted. `PI_OFFLINE=1` blocks the lookup.

These are undocumented portal APIs and may change or be unavailable for some credentials, plans, or permissions. Partial failures leave available sections visible. Positive on-demand amounts are labeled as raw API amounts because their unit has not been verified; they are not presented as currency.

The model catalog is cached for six hours in `$XDG_CACHE_HOME/pi-devin/models.json` (or `~/.cache/pi-devin/models.json`). A fresh cache avoids the CLI call at startup; an older cache remains available while it refreshes in the background. Set `PI_OFFLINE=1` to skip automatic catalog refreshes. `/devin-refresh` still requests a refresh explicitly.

## What this is / is not

| This package | Not this package |
|---|---|
| Pi is the agent | Devin taking over the session |
| Devin CLI for auth + catalog | Fake Windsurf OAuth paste flow |
| Live CLI families (Opus 5, Fable 5, Sol, …) | Hardcoded 11-model cloud allowlist |
| Completions streamed into Pi tools | An editor host for Devin |

## Publish

This is a standard Pi package (`keywords: ["pi-package"]` + `pi.extensions`). After you push to npm with that keyword, it can show up on [pi.dev/packages](https://pi.dev/packages).

## License

MIT. Unofficial. Not affiliated with Cognition.
