# AGENTS.md — pi-devin

Pi package that registers the `devin` provider. Auth and the model catalog come from the local Devin CLI. Pi remains the harness.

## Layout

```
extensions/index.ts   # registerProvider("devin"), /login, /devin-status, /devin-refresh
src/cli.ts            # locate + spawn `devin`
src/credentials.ts    # ~/.local/share/devin/credentials.toml
src/models.ts         # `devin models list --format json` → ProviderModelConfig[]
src/stream.ts         # streamSimple via GetChatMessage (Connect/protobuf)
src/jwt.ts            # GetUserJwt cache
src/metadata.ts       # Metadata proto (Windsurf/Devin Desktop version gate)
src/wire.ts           # protobuf + Connect framing
src/context-map.ts    # Pi Context → Cognition chat history
```

## Contract

- `/login devin` must call `devin auth login` when credentials are missing, not a custom Windsurf paste flow.
- Model IDs must come from `devin models list`, not a hardcoded cloud allowlist.
- Do not depend on Zed or ACP. Pi keeps tools, permissions, and the session tree.
- Client identity stays `devin-desktop`. Never hardcode a fallback Desktop version: resolve it from a valid trusted launch-environment override, installed Devin Desktop `product.json`, a validated six-hour cache, or the fixed official stable update manifest, and fail closed when no verified version is available. Query the fixed `darwin-arm64` endpoint only for its cross-host `windsurfVersion` value; never install/download its artifact or send credentials/identifying headers. Disable persistent caching without secure no-follow/directory/nonblocking flags. Same-UID cache mutation is outside the integrity boundary.
- Package must stay installable as a Pi package: `keywords: ["pi-package"]` and `pi.extensions`.
