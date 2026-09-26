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
/model devin/claude-opus-5
/model devin/claude-fable-5
/model devin/gpt-5.6-sol
```

Families with multiple reasoning variants keep their catalog slug as the Pi model id. Pi's thinking level selects the Devin model UID sent on the wire; for example, `devin/swe-2` maps `medium`, `high`, and `max` to `swe-2-medium`, `swe-2-high`, and `swe-2-max`. Levels absent from the live family are hidden instead of falling back to another variant.

`/login devin` runs `devin auth login` if `~/.local/share/devin/credentials.toml` is missing. If you already signed in through the Devin CLI or Devin Desktop, that file is reused.

Commands:

- `/devin-status` — CLI path, version, auth
- `/devin-refresh` — reload `devin models list --format json`

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
