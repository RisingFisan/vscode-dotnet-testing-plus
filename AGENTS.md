# AGENTS.md

VS Code extension ".NET Testing+": loads a Visual Studio `.playlist`, runs those tests per project via `dotnet test <csproj> --no-build`, shows them in a custom "Playlist Tests" view inside the Testing panel. TypeScript, single package.

## Commands

- `npm run compile` — tsc to `out/`
- `npm run lint` — eslint; must pass before packaging
- Package: `npx --yes @vscode/vsce package --allow-missing-repository` (keep `dummy-mes/**` in `.vscodeignore` — it's local harness data and must not ship in the VSIX)
- Install: `code --install-extension dotnet-testing-plus-<version>.vsix --force`
- No test suite. Verification is done with throwaway Node harnesses: stub `require('vscode')` via `Module._resolveFilename` (see deleted `vscode-stub.js` pattern), run against the real WSL data below, then delete the harness files.

## Version bumping

Every change that requires recompiling the project must bump the version (in `package.json` **and** the hardcoded version in the activation `log(...)` string in `src/extension.ts` — they have drifted before), unless told otherwise.

- New feature → bump the minor (X.Y+1.Z).
- Bug fix or minor change → bump the patch (X.Y.Z+1).
- Neither → ask the user which to bump.

## Release checklist

1. Bump `version` per the version-bumping rules above (both locations).
2. `npm run compile && npm run lint`
3. Package, install, delete older `*.vsix` files.

## Architecture

- `src/extension.ts` — state machine: solution resolution → discovery (`dotnet test --list-tests` + source scan) → playlist match → tree build. Context keys `dotnetTestingPlus.*` gate the view/title buttons and run-all enablement. Runsettings has three persisted modes (`runsettingsMode` in workspaceState): **Default** (auto-picked file next to the `.sln`, used as-is), **Override** (default file + user overrides materialized to extension storage at run time; overrides are kept dormant, never discarded, when leaving Override), **Custom** (user-picked `runsettingsPath`, never overridable). The default file is re-detected via `findDefaultRunsettings` on every activation (no cached path — a window refresh/folder change must not keep stale references); if it's gone, mode is coerced to Custom with nothing selected (`coerceRunsettingsMode`). `activeFilter` holds the session-only test filter. The full tree is built **once** from all known tests (`showAllTests`), grouped by project via the source scan's FQN→csproj map; loading a playlist only **prunes** that tree (`filterTree`), never rebuilds it (`treeIsPruned` tracks when a restore is needed).
- `src/solutionDiscovery.ts` — runs `dotnet test <sln> --list-tests --nologo -v q --tl:off`; retries 3× on ENOENT (remote PATH may not be ready at activation); strips ANSI; parses bare names.
- `src/sourceScan.ts` — static scan of all solution projects building bare-name→FQN index, FQN→file/line locations, **and** FQN→owning-csproj mapping. Always run it during discovery, even on cache hit (it's fast; the cache in `src/cache.ts` only skips the slow `dotnet --list-tests`).
- `src/testRunner.ts` — first builds the solution once, then runs tests per owning project with `dotnet test <csproj> --no-build --filter ...` so only the relevant test project(s) are executed. Chunks are per-project (chunk size from setting `dotnetTestingPlus.chunkSize`, default 100). Two live result channels: a bundled VSTest logger streams per-test JSONL (see below) and per-project TRX files are parsed as they stream (see gotchas). Cancellation listens to **both** the profile-handler token and `TestRun.token` — the Test Results view's cancel button only fires the latter (it cancels a single task, never the profile token). `request.exclude` is honored at **every** tree level: VS Code excludes the top-most hidden nodes (whole class/project subtrees) when the explorer filter hides them (e.g. "Show only failed tests"); excluded tests are left untouched (not run, not marked skipped). `__readTrxForTest`/`__processLineForTest`/`__reportStreamedLineForTest`/`__collectTestsToRunForTest` exports exist only for harnesses. When debugging (`VSTEST_HOST_DEBUG=1`), the vstest testhost injects a `Debugger.Break()` right after attach; the `dotnetTestingPlus.skipPreBreakpoint` setting lets the extension auto-continue that first stop.
- `logger/` — C# source of `Playlist.TestLogger.dll`, a VSTest `ITestLogger` (FriendlyName `playliststream`) that appends one JSON line per test to `$PLAYLIST_STREAM_LOG` as each test finishes. The built DLL is checked in at `assets/logger/` and packaged into the VSIX; `testRunner.ts` passes it via `--test-adapter-path` and tails the JSONL file. Rebuild after editing (needs dotnet; from Windows use WSL): copy `logger/` to a WSL dir, `dotnet build -c Release`, then copy `bin/Release/netstandard2.0/Playlist.TestLogger.dll` back to `assets/logger/`.
- `src/testTree.ts` — native TestController tree (holds results; items carry `uri`+`range` for Go to Test); this is the **only** place tests are shown. `buildTree` builds the full project→class→test tree; `filterTree` prunes it in place to a visible FQN set (keeps surviving items' run state), used for playlist selection. The custom `playlistView` sub-tab is a **webview** (`src/mainView.ts`) hosting the "Advanced Search" filter input, Playlist row (selected file name + Select/Clear buttons), the Runsettings row (Default/Override/Custom dropdown + file name + Select button in Custom mode; the override editor `<details>` only renders in Override mode), and a "Skip pre-breakpoint" checkbox that toggles `dotnetTestingPlus.skipPreBreakpoint` (default true). The old sub-view tree (`src/playlistTreeView.ts`) and its per-test status store (`src/runState.ts`) were removed — see `docs/restore-playlist-subview.md` to bring them back.
- `src/testFilter.ts` — parses the custom filter (the native Testing search bar matches labels only and cannot be extended with `class:` syntax; tree rows can't host text inputs, hence the webview). Expression grammar, spaces insignificant: `|` ORs, `&` ANDs (tighter precedence), parentheses group, and juxtaposed terms are implicitly AND-ed (so old space-separated filters still work). `class:`/`project:` qualify a term, or a parenthesized group when placed before `(` (distributes; inner qualifiers override); unqualified terms match test name. The parser is tolerant (empty operands/stray parens dropped). The webview posts `filter` messages (debounced 300 ms) → `applyFilterInput` in `extension.ts`; applied to entries right before `buildTree` in `matchPlaylist`/`showAllTests`. Run All/Debug All run only the filtered (visible) tree.
- `src/runsettingsManager.ts` — auto-picks `.runsettings` next to the `.sln` (priority: `<SlnName>.runsettings` → `default.runsettings` → any); parses the XML into overridable values/parameters and materializes an overridden copy into extension storage for Override mode.

## dotnet / target-solution gotchas (verified against the user's WSL env)

- Target: a large multi-project solution in WSL; dotnet installed via `mise` (SDK 10.x).
- **Microsoft.Testing.Platform mode**: `dotnet test --list-tests` (and even `dotnet vstest --ListTests`) prints only **bare method names**, never FQNs. `-p:TestingPlatformDotnetTestSupport=false` does not help. This is why the source-scan mapping exists — do not try to "fix" list-tests.
- **`dotnet test` on a solution writes one TRX per test project next to that project** (`<proj>/TestResults/...`), ignoring any `LogFileName` directory. It emits a `Results File: <path>` line per project **as each finishes** — the runner parses each TRX the moment its line streams (live results). There are **no per-test `Passed/Failed` stdout lines**; don't try to parse them. Per-project test runs use the same TRX behavior but no longer trigger the "No test matches the given testcase filter" warnings because each filter targets the owning project.
- Paths: extension host runs in WSL (POSIX `/src/...` valid); Windows-side Node harnesses must use `\\wsl.localhost\<distro>\...`. Real paths may contain `/src/` twice — never blind-replace `/src/`.
- **Custom VSTest loggers**: the assembly filename MUST end with `TestLogger.dll` and `--test-adapter-path` must be a **directory** (a file path is silently rejected), otherwise vstest reports "Could not find a test logger". The `TestLoggerEvents` event is `TestResult` (not `TestResultHandler`). Custom loggers coexist fine with `--logger trx`. The streamed FQN is the real FQN (no bare-name problem).
- Never cache empty (0-test) discovery results; cached empty lists are treated as invalid.

## VS Code API constraints

- `TestController` trees can only live in the Testing view. The own-tab requirement is solved with `contributes.views` under the existing `"testing"` container: tests show **only** in the native Test Explorer, and the custom `playlistView` sub-tab is a `type: webview` view holding the filter box, playlist/runsettings rows, and the skip-pre-breakpoint toggle. Operational buttons (solution select/switch, stop loading, refresh, show output) are `view/title` contributions scoped to `view == dotnet-testing-plus.playlistView` (so their icons appear in the Playlist Tests tab's title bar, not the Test Explorer's).
- The native Testing search bar matches only `TestItem.label` (glob-aware, `!` negation) plus exact tags via `@ctrlId:tagId`; extensions cannot hook it — hence the custom filter command.
- TreeView has no double-click event; item `command` fires on click. Go-to-source is a click, not a double-click.
- `TestItem.uri` is readonly per old `@types/vscode` typings — a cast is used in `testTree.ts`.

## Editing hazards

- `src/testRunner.ts` `ANSI_RE` contains a **literal ESC byte (0x1B)** before `\[` — string-replacement edits that include that line will fail to match, and eslint needs the `no-control-regex` disable comment above it.
- `src/sourceScan.ts` regexes are deliberately shaped: `CLASS_RE` is anchored at line start (the word "class" appears in comments/strings and once silently dropped a test), `METHOD_RE` tolerates combined attributes (`[TestMethod, TestCategory(...)]`), and all `class` bodies are scanned (partial classes split `[TestClass]` and methods across files). Don't tighten these without re-running a harness against the target solution.
- The repo owner hand-edits files between sessions (versions, commands, context keys). **Always re-read a file before editing it.**
