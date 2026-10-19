---
name: dotnet-testing-plus
description: View and control the .NET Testing+ VS Code extension from an agent. Discover open VS Code sessions and their loaded .NET solutions, list tests, select or clear Visual Studio .playlist files, set text filters, run or debug tests, cancel runs, edit runsettings, and read live per-test results and extension logs over a shared local HTTP control API. Use whenever the user asks to run, debug, inspect, or cancel .NET tests or playlists through the .NET Testing+ extension (the "Playlist Tests" Test Explorer workflow).
---

# .NET Testing+ control API

The .NET Testing+ VS Code extension hosts a small JSON HTTP API on loopback so coding agents can view test state and drive runs. **Every VS Code window with the API enabled shares one API**: the first window to enable it hosts a *hub* and the others join it, so a single port exposes the sessions (windows) of all of them.

Two front ends share that API: the VS Code Test Explorer / extension webview, and the browser dashboard. They share discovered tests and run results, but each keeps its **own** scope — the VS Code playlist, text filter and result filters never change what the dashboard shows, and vice versa. Test lists therefore report every discovered test with its current state; only the endpoints that act on the VS Code tree (playlist/filter/select, and `run` with `{"all":true}`) are scoped by it.

## Concepts

- A **session** is one VS Code window (identified by its first workspace folder, lowercased and sanitized, e.g. `product`). Sessions are addressed in the URL.
- A **solution** is a loaded `.sln`/`.slnf`/`.slnx` inside a session, addressed by its sanitized file name (e.g. `mes`). `GET /api/sessions` lists both.

## Security model

- The API is **off by default**. It runs when `dotnetTestingPlus.controlApiEnabled` is `true` (or toggled on in the extension webview).
- It binds to `127.0.0.1` only; nothing outside the machine can reach it.
- If `dotnetTestingPlus.controlApiToken` is set, every `/api/...` request must send `Authorization: Bearer <token>`. The human-facing HTML pages (`/`, `/<session>/`) are public so the browser can prompt for the token; data endpoints are not.
- `dotnetTestingPlus.controlApiPort` (default `48265`) is the hub's port. Only the window that happens to host the hub uses it; the others find the host automatically. Prefer setting it at the **user** level so every window agrees.

## First-time setup (safe to automate)

1. Enable the API by setting `dotnetTestingPlus.controlApiEnabled: true` in workspace or user settings (or toggle it on in the "Playlist Tests" webview):

   ```json
   { "dotnetTestingPlus.controlApiEnabled": true }
   ```

   The setting applies immediately — no window reload needed.
2. The API lives inside the extension host. If the extension has not activated yet in this window (no solution loaded / Testing view never opened), open the Testing view or the extension's "Playlist Tests" panel once.
3. If a token is configured, send it on every `/api/...` request: `-H "Authorization: Bearer $TOKEN"`.

## Finding the endpoint

- Start with `curl -sf http://127.0.0.1:48265/api/sessions` (add the token header if set).
- **Connection refused**: check whether VS Code is running with the extension installed, and grep user/workspace settings files for `dotnetTestingPlus.controlApiPort` to find the configured port. Remember the API is hosted inside the extension host: if VS Code runs remotely (for example in WSL) while your shell runs on the host OS, WSL2 localhost forwarding usually bridges `127.0.0.1:<port>` to the remote side — try it before assuming the API is down.
- **401 Unauthorized**: the token setting is set. Find it in the same settings files or ask the user.
- **Empty `sessions` list**: no window currently has the API enabled, or the extension has not activated in any of them.
- **Port won't bind**: the extension first tries `dotnetTestingPlus.controlApiPort`; if that port is unavailable it falls back to an OS-assigned port and publishes it in the registry (`<globalStorage>/api-registry.json`). The webview's "Open Dashboard" link always shows the real URL. A WSL2 mirrored-networking setup or VPN port broker can silently reserve blocks of loopback ports (see the "Port won't bind" note) — pick another port (values ≥49152 often work) if you need a stable one.

## Endpoints

All file paths in requests and responses are paths on the **extension-host machine** (POSIX like `/home/user/src/...` when VS Code runs in WSL, Windows like `C:\src\...` when local). If your shell runs on a different OS than the extension host, map paths accordingly (WSL `/home/...` ↔ `\\wsl.localhost\<distro>\home\...`).

Please note the `/api` prefix and the `/<session>` (and, for solution-scoped calls, `/<solution>`) path segments.

| Method | Path | Body | Purpose |
|---|---|---|---|
| GET | `/` | — | Sessions landing page: one card per open session, linking to its dashboard |
| GET | `/<session>/` | — | Browser dashboard for one session |
| GET | `/api/sessions` | — | List open sessions and, for each, its solutions (ids, labels, test counts, readiness) |
| GET | `/api/<session>/events[?token=<token>]` | — | Server-Sent Events stream: `state`, `testState`, `runStart`, `runEnd` for that session |
| GET | `/api/<session>/state` | — | Solutions (id/label/path/ready/loading/testCount/playlistPath), active solution, `runInProgress`, the VS Code text filter, per-state result counts, playlist not-found tests, runsettings mode/path |
| GET | `/api/<session>/log?lines=200` | — | Recent extension output lines for that session's window |
| POST | `/api/<session>/run` | `{"all":true}` or `{"fqns":["Ns.C.M"]}` | Start a run; replies `{started, matched, missing}`. `{"all":true}` runs the tree-visible tests; `{"fqns":[...]}` runs exactly those (need not be tree-visible). Add `"debug":true` to debug, `"solution":"<solution-id>"` to scope an `all` run |
| POST | `/api/<session>/cancel` | `{}` or `{"loading":true}` | Cancel the latest tracked run (UI- or API-started); `{"loading":true}` also cancels discovery |
| POST | `/api/<session>/filter` | `{"text":"class:X & (project:Y|class:Z)"}` | Set the VS Code text filter (`""` clears it); narrows the Test Explorer tree, not the test lists |
| POST | `/api/<session>/screenshot` | `{"fqns":["Ns.C.M"],"groupBy":"project"}` | Render a structured test-result snapshot for exactly the requested tests |
| GET | `/api/<session>/<solution>/tests` | — | Every discovered test in that solution with its current state: `fqn`, `name`, `class`, `project`, `state`, `durationMs`, `file`, `line` |
| GET | `/api/<session>/<solution>/code?fqn=<fqn>` | — | Source code of a specific test method |
| POST | `/api/<session>/<solution>/playlist` | `{"path":"/abs/file.playlist"}` or `{"clear":true}` | Select or clear a Visual Studio `.playlist` file in the VS Code tree; replies with matched/not-found counts |
| POST | `/api/<session>/<solution>/select` | `{}` | Switch the VS Code active solution tab to this solution |
| GET | `/api/<session>/<solution>/runsettings` | — | Current runsettings state: active base file, candidates, overridable values and TestRunParameters |
| POST | `/api/<session>/<solution>/runsettings` | see below | Apply one runsettings change; returns the new state |

`runsettings` actions (`POST` body): `{"action":"selectFile","path":"/abs/x.runsettings"}` (or omit `path` for the default), `{"action":"setValue","key":...,"value":...}`, `{"action":"resetValue","key":...}`, `{"action":"lockValue","key":...,"isPermanent":true}`, `{"action":"addParameter"}`, `{"action":"updateParameter","id":...,"field":"name"|"value","value":...}`, `{"action":"removeParameter","id":...}`, `{"action":"lockParameter","id":...,"isPermanent":true}`.

## Standard run workflow

1. **Find sessions**: `GET /api/sessions`. Pick a session (and note its solutions).
2. **Health check**: `GET /api/<session>/state`. Note `runInProgress`, the active solution, and whether solutions are `ready` or `loading` (wait for `ready` before running).
3. **Scope (optional)**: `POST /api/<session>/<solution>/playlist`, `POST /api/<session>/filter` and `POST /api/<session>/<solution>/select` scope the **VS Code tree**, which is what `run {"all":true}` follows. Test lists always report every discovered test; to run a computed subset, pass its FQNs explicitly.
4. **Start**: `POST /api/<session>/run` with `{"all":true}` or specific `{"fqns":[...]}`. It returns immediately; a full run can take minutes.
5. **Poll**: `GET /api/<session>/<solution>/tests` every ~2 seconds (or `GET /api/<session>/state` for `runInProgress`) until no test has state `queued` or `running`.
6. **Report**: counts per state, then failures with `file`/`line` and `durationMs`. Use `GET /api/<session>/log` if results look wrong or a run stalled.
7. **Stop**: `POST /api/<session>/cancel` if the user asks to abort.

## Gotchas

- **Test lists show everything, but `run {"all":true}` runs only the tree-visible tests.** A VS Code playlist, text filter or result filter prunes the tree, and `{"all":true}` follows that pruning. `{"fqns":[...]}` ignores it, so prefer explicit FQNs for anything you computed. FQNs that do not belong to a loaded solution come back in `missing`.
- The dashboard's search box, selection and playlist are its own: they never change the VS Code filter/tree, and the VS Code filter/playlist never change what the dashboard shows.
- Results are shared: a run started from VS Code, the dashboard, or another window's agent updates the per-test `state` in the test list and streams on `/events`.
- Sessions and solutions are addressed by **sanitized ids**, not raw paths. Use `GET /api/sessions` and `GET /api/<session>/state` to resolve ids; the raw paths are in the responses.
- If the window that hosts the hub is closed, another window takes over the same port automatically; open dashboards and `EventSource` clients reconnect on their own.
- Test runs use `dotnet test --no-build` per owning project; build the solution beforehand if sources changed.
- `debug:true` requires an interactive debugger session in the VS Code window; prefer regular runs from an agent.
- Poll at a reasonable interval (~2s); the API is shared with the UI on the extension host.

## Examples

```bash
# List open sessions and their solutions
curl -s http://127.0.0.1:48265/api/sessions

# Health check for a session
curl -s http://127.0.0.1:48265/api/product/state

# List discovered tests of one solution (all of them, with current states)
curl -s http://127.0.0.1:48265/api/product/mes/tests

# Run two specific tests
curl -s -X POST http://127.0.0.1:48265/api/product/run \
  -H "Content-Type: application/json" \
  -d '{"fqns":["Mes.E2E.Cart.CartTests.AddItemIncreasesCount","Mes.E2E.Cart.CartTests.RemoveItemDecreasesCount"]}'

# Run everything currently visible in the VS Code tree for one solution
curl -s -X POST http://127.0.0.1:48265/api/product/run \
  -H "Content-Type: application/json" \
  -d '{"all":true,"solution":"mes"}'

# Select a playlist, then check what matched
curl -s -X POST http://127.0.0.1:48265/api/product/mes/playlist \
  -H "Content-Type: application/json" \
  -d '{"path":"/home/user/src/dummy.playlist"}'
curl -s http://127.0.0.1:48265/api/product/state

# Edit a runsettings value, then lock it as a permanent override
curl -s -X POST http://127.0.0.1:48265/api/product/mes/runsettings \
  -H "Content-Type: application/json" -d '{"action":"setValue","key":"RunConfiguration.TargetFrameworkVersion","value":"net10.0"}'
curl -s -X POST http://127.0.0.1:48265/api/product/mes/runsettings \
  -H "Content-Type: application/json" -d '{"action":"lockValue","key":"RunConfiguration.TargetFrameworkVersion","isPermanent":true}'

# Clear the text filter
curl -s -X POST http://127.0.0.1:48265/api/product/filter \
  -H "Content-Type: application/json" -d '{"text":""}'

# Cancel the current run
curl -s -X POST http://127.0.0.1:48265/api/product/cancel -H "Content-Type: application/json" -d '{}'
```
