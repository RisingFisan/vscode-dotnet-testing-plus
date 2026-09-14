---
name: dotnet-testing-plus
description: View and control the .NET Testing+ VS Code extension from an agent. Discover loaded .NET solutions and their tests, select or clear Visual Studio .playlist files, set text filters, run or debug tests, cancel runs, and read live per-test results and extension logs over a local HTTP control API. Use whenever the user asks to run, debug, inspect, or cancel .NET tests or playlists through the .NET Testing+ extension (the "Playlist Tests" Test Explorer workflow).
---

# .NET Testing+ control API

The .NET Testing+ VS Code extension hosts a small JSON HTTP API on loopback so coding agents can view test state and drive runs. The API reuses the extension's UI code paths: every response reflects exactly what the Test Explorer tree shows — playlist selection, the text filter, and result filters all apply.

## Security model

- The API is **off by default**. It runs only when the setting `dotnetTestingPlus.controlApiEnabled` is `true` (or toggled on in the extension webview) and `dotnetTestingPlus.controlApiPort` is a positive port (defaults to `48265`).
- It binds to `127.0.0.1` only; nothing outside the machine can reach it.
- If `dotnetTestingPlus.controlApiToken` is set, every request must send `Authorization: Bearer <token>`.

## First-time setup (safe to automate)

1. Enable the API by setting `dotnetTestingPlus.controlApiEnabled: true` in workspace settings (`.vscode/settings.json`) or user settings (or toggle it on in the "Playlist Tests" webview):

   ```json
   { "dotnetTestingPlus.controlApiEnabled": true }
   ```

   The port defaults to `48265`. If you need a custom port, set `dotnetTestingPlus.controlApiPort`. The setting applies immediately — no window reload needed. (Prefer workspace settings for solution-specific setups so the port is stable per project.)
2. The API lives inside the extension host. If the extension has not activated yet in this window (no solution loaded / Testing view never opened), open the Testing view or the extension's "Playlist Tests" panel once.
3. If a token is configured, send it on every request: `-H "Authorization: Bearer $TOKEN"`.

## Finding the endpoint

- Start with `curl -sf http://127.0.0.1:48265/state`.
- **Connection refused**: check whether VS Code is running with the extension installed, and grep user/workspace settings files for `dotnetTestingPlus.controlApiPort` to find the configured port. Remember the API is hosted inside the extension host: if VS Code runs remotely (for example in WSL) while your shell runs on the host OS, WSL2 localhost forwarding usually bridges `127.0.0.1:<port>` to the remote side — try it before assuming the API is down.
- **401 Unauthorized**: the token setting is set. Find it in the same settings files or ask the user.
- **Port won't bind**: if the extension's output shows `Control API error: listen EADDRINUSE` while nothing visible listens on that port (check with `netstat`/`Get-NetTCPConnection`), a WSL2 mirrored-networking setup or VPN port broker may silently reserve blocks of loopback ports. Pick a different port (values ≥49152 often work) — the setting applies immediately, no reload needed.

## Endpoints

All file paths in requests and responses are paths on the **extension-host machine** (POSIX like `/home/user/src/...` when VS Code runs in WSL, Windows like `C:\src\...` when local). If your shell runs on a different OS than the extension host, map paths accordingly (WSL `/home/...` ↔ `\\wsl.localhost\<distro>\home\...`).

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/state` | — | Loaded solutions (sessions: key/label/solutionPath/ready/loading/testCount/playlistPath), active session, `runInProgress`, text filter, per-state result counts, playlist not-found tests, runsettings mode/path |
| GET | `/tests[?solution=<key>]` | — | Visible tests: `fqn`, `name`, `class`, `project`, `state`, `durationMs`, `file`, `line` |
| GET | `/log?lines=200` | — | Recent extension output lines (diagnose discovery or run failures) |
| POST | `/run` | `{"all":true}` or `{"fqns":["Ns.C.M"]}` | Start a run; respond immediately with `{started, matched, missing}`. Add `"debug":true` to debug, `"solution":"<key>"` to scope to one solution |
| POST | `/cancel` | `{}` or `{"loading":true}` | Cancel the latest tracked run (UI- or API-started); `{"loading":true}` also cancels solution discovery |
| POST | `/playlist` | `{"path":"/abs/file.playlist"}` or `{"clear":true}` | Select or clear a Visual Studio `.playlist` file; accepts `"solution":"<key>"`; replies with matched/not-found counts |
| POST | `/filter` | `{"text":"class:X & (project=Y|class:Z)"}` | Set the active session's text filter (`""` clears it). Grammar: `|` ORs, `&` ANDs (tighter), parentheses group, juxtaposition is AND; `class:`/`project:` (contains) and `class=`/`project=` (exact) qualify terms |
| POST | `/session` | `{"key":"<key>"}` | Switch the active solution tab |

Session keys are canonical solution paths as returned by `GET /state`.

## Standard run workflow

1. **Health check**: `GET /state`. Note `runInProgress`, the active session, whether sessions are `ready` or `loading` (wait for `ready` before running).
2. **Scope (optional)**: `POST /playlist` to narrow to a playlist, `POST /filter` to narrow further, `POST /session` to switch solutions. `GET /tests` after scoping shows exactly what will run.
3. **Start**: `POST /run` with `{"all":true}` or specific `{"fqns":[...]}`. It returns immediately; a full run can take minutes.
4. **Poll**: `GET /tests` every ~2 seconds (or `GET /state` for `runInProgress`) until no test has state `queued` or `running`.
5. **Report**: counts per state, then failures with `file`/`line` and `durationMs`. Use `GET /log` if results look wrong or a run stalled.
6. **Stop**: `POST /cancel` if the user asks to abort.

## Gotchas

- **Only tree-visible tests are listed and runnable.** A playlist, an active text filter, or result filters ("show only failed") prune the tree. `POST /run` reports unrunnable FQNs in `missing` — clear the filter (`{"text":""}`), clear the playlist (`{"clear":true}`), or reset result filters, then retry.
- Test runs use `dotnet test --no-build` per owning project; build the solution beforehand if sources changed.
- `debug:true` requires an interactive debugger session in the VS Code window; prefer regular runs from an agent.
- Poll at a reasonable interval (~2s); the API is shared with the UI on the extension host.

## Examples

```bash
# Health check
curl -s http://127.0.0.1:48265/state

# List visible tests of the active session
curl -s http://127.0.0.1:48265/tests

# Run two specific tests
curl -s -X POST http://127.0.0.1:48265/run \
  -H "Content-Type: application/json" \
  -d '{"fqns":["Mes.E2E.Cart.CartTests.AddItemIncreasesCount","Mes.E2E.Cart.CartTests.RemoveItemDecreasesCount"]}'

# Run everything currently visible in one solution
curl -s -X POST http://127.0.0.1:48265/run \
  -H "Content-Type: application/json" \
  -d '{"all":true,"solution":"/home/user/src/MES.sln"}'

# Select a playlist, then check what matched
curl -s -X POST http://127.0.0.1:48265/playlist \
  -H "Content-Type: application/json" \
  -d '{"path":"/home/user/src/dummy.playlist"}'
curl -s http://127.0.0.1:48265/state

# Clear the text filter
curl -s -X POST http://127.0.0.1:48265/filter \
  -H "Content-Type: application/json" -d '{"text":""}'

# Cancel the current run
curl -s -X POST http://127.0.0.1:48265/cancel -H "Content-Type: application/json" -d '{}'
```
