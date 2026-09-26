# AGENTS.md — pi-devin

Pi package that registers the `devin` provider. Auth and the model catalog come from the local Devin CLI. Pi remains the harness.

## Layout

```
extensions/index.ts   # registerProvider("devin"), /login, /devin-status, /devin-refresh
src/cli.ts            # locate + spawn `devin`
src/credentials.ts    # ~/.local/share/devin/credentials.toml
src/models.ts         # `devin models list --format json` → ProviderModelConfig[]
src/thinking.ts       # thinking summary + opaque signature round-trip
src/stream.ts         # streamSimple via GetChatMessage (Connect/protobuf)
src/jwt.ts            # GetUserJwt cache
src/metadata.ts       # Metadata proto (Windsurf/Devin Desktop version gate)
src/wire.ts           # protobuf + Connect framing
src/context-map.ts    # Pi Context → Cognition chat history
```

## Contract

- `/login devin` must call `devin auth login` when credentials are missing, not a custom Windsurf paste flow.
- Model IDs must come from `devin models list`, not a hardcoded cloud allowlist.
- Signed thinking must round-trip: retain `delta_signature` and `delta_signature_type`, then replay the summary, signature, redaction flag, and signature type in prompt fields 11/12/13/18.
- Only the server-provided thinking summary is readable; signature bytes remain opaque and must never be surfaced as reasoning text.
- Do not depend on Zed or ACP. Pi keeps tools, permissions, and the session tree.
- Package must stay installable as a Pi package: `keywords: ["pi-package"]` and `pi.extensions`.
