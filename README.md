# pi-devin

A [Pi](https://pi.dev) package that uses **Devin Local** models inside Pi.

Pi stays the harness. The local [Devin CLI](https://docs.devin.ai/cli) owns login and the live model catalog (`devin auth`, `devin models list`). This package does **not** wrap Devin as an ACP agent and does **not** use the old `pi-devin-auth` cloud-only shim.

## Why this exists

`pi-devin-auth` treated Devin as Cascade cloud chat. Models like Sol High, Opus 5, and Fable 5 then failed with:

```text
This model is only in Devin Local.
```

Zed works because it launches `devin acp` — Devin Local. This package uses that same local CLI for auth + catalog, then streams completions into Pi so Pi's tools, sessions, and UI stay in charge.

## Requirements

- Pi Coding Agent 0.80+
- A signed-in [Devin CLI](https://docs.devin.ai/cli) (`devin auth status`)
- Node 18+

The CLI binary is resolved in this order:

1. `$DEVIN_CLI`
2. `~/.local/bin/devin`, Homebrew, `/usr/local/bin/devin`
3. Devin.app
4. Zed's ACP registry install (`~/Library/Application Support/Zed/external_agents/registry/devin/.../bin/devin`)
5. `which devin`

## Install

Local (this repo):

```bash
pi install /Users/kashyab/pi-devin
```

After you publish to npm:

```bash
pi install npm:pi-devin
```

From git:

```bash
pi install git:github.com/<you>/pi-devin
```

Restart Pi or run `/reload`.

## Usage

```text
/login devin
/model devin/claude-opus-5-high
/model devin/claude-5-fable-high
/model devin/gpt-5-6-sol-high
```

`/login devin` runs `devin auth login` if `~/.local/share/devin/credentials.toml` is missing. If you already signed in through Devin Desktop, the CLI, or Zed, that file is reused.

Commands:

- `/devin-status` — CLI path, version, auth
- `/devin-refresh` — reload `devin models list --format json`

## What this is / is not

| This package | Not this package |
|---|---|
| Pi is the agent | Devin ACP taking over the session |
| Devin CLI for auth + catalog | Fake Windsurf OAuth paste flow |
| Live CLI families (Opus 5, Fable 5, Sol, …) | Hardcoded 11-model cloud allowlist |
| Completions streamed into Pi tools | `devin acp` as the editor host |

## Publish

This is a standard Pi package (`keywords: ["pi-package"]` + `pi.extensions`). After you push to npm with that keyword, it can show up on [pi.dev/packages](https://pi.dev/packages).

## License

MIT. Unofficial. Not affiliated with Cognition.
