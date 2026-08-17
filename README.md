# dsh-update-checker

English | [中文](README.zh.md)

A permanent Cordis plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI that **auto-checks for new DeepSeek Harness releases AND installed third-party plugin updates** (the former standalone `dsh-plugin-checker` was merged in v1.1.0), asks the user, and one-click updates with success/failure feedback.

## Features

- **Full update lifecycle** — check, backup, update, **rollback**, and restart, all in one plugin.
- **Main program check** — compares the installed `@deepseek-ai/dsh` version against the npm latest (full packument, stable-first — a `latest` dist-tag pointing at a pre-release won't cause false positives; semver-aware).
- **Third-party plugin check** — scans installed non-official plugins (composition rows + `dsh` manifest, layout-agnostic, multi-location `node_modules` incl. pnpm hoisted layouts), cross-compares each against **npm + GitHub** (target = higher version). Local tools with no publish source (e.g. mcp-* clients) are moved to `ignored` instead of spamming "not on npm registry".
- **Working GitHub channel** — a dedicated HTTPS client for GitHub domains (`rejectUnauthorized:false` limited to github.com / *.githubusercontent.com, compatible with local S302 proxies that use self-signed certs; npm registry still uses strict TLS), with redirect following, download size caps, and timeouts. codeload tarballs are validated before install (entry file from `main`/`exports` exists, tag matches `package.json` version) so a source-only repo can never replace a runnable plugin.
- **In-GUI banner** — locale-aware (zh/en follows the DSH UI language), states update / up-to-date / failure, with a "don't remind me" suppression flag; the update banner shows a **change brief** (vX→vY + risk level major/minor/patch/pre, plus GitHub release notes when available).
- **One-click update with safety** —
  - Main program: **dry-run guard** (npm install --dry-run — abort if the plan contains any `remove`, protecting against pruning the deploy/global tree) → backup (lockfile + @deepseek-ai manifests + recorded old version) → **layout-adaptive install** (local project with a `package.json` → in-place `npm install`; global install without one → `-g`) → **post-install re-read check** `installed==latest` (no more constant success) → eco sync.
  - Plugins: temp-dir install + copy (never touches unrelated packages in `profiles/node_modules`), **dependency version reconciliation** (replace & back up deps whose installed version doesn't satisfy the new range), and automatic `--allow-scripts` pass on npm ≥ 12 for native deps (koffi/node-pty/sharp…).
- **Real rollback** — main program: `POST /rollback` reinstalls the recorded old version (same dry-run guard + sync + verify); plugins: `POST /plugin-rollback` restores the old directory from `.dsh-plugin-backups/<id>`; `GET /backups.json` lists both.
- **Restart with watchdog** — the launcher is **derived from the current process argv** (no more guessing `start-dsh.cmd`), kills by PID + port, and recovery is confirmed by **port listening + an HTTP 200 probe** (`/dsh-update-checker/status.json`); the result is written to JSON and exposed via `GET /restart-status.json`.
- **Write-route security** — besides `{ "confirm": true }`, all write routes require a **loopback source** (`req.socket.remoteAddress` of 127.0.0.1/::1), so LAN clients cannot remotely trigger update/restart/rollback.
- **Zero-config portability** — profile dir / `$DSH_HOME` / composition file are derived from the plugin's own install location; the deployment root is resolved via junction `realpath` with `DSH_DEPLOY_ROOT` / `process.cwd()` fallback. Works on any machine without editing code.

- **Host half** (`lib/index.js`) registers HTTP routes:
  - `GET /dsh-update-checker/status.json` — fetches the latest stable `@deepseek-ai/dsh` version from the npm registry, reads the locally installed version, compares with semver, returns JSON status (incl. the persisted `suppressUpToDate` flag and a `brief` change summary).
  - `POST /dsh-update-checker/suppress` — persists the "don't remind me again" flag (requires `{ "confirm": true }`).
  - `POST /dsh-update-checker/update` — **complete update**: dry-run guard (no `remove` allowed in the plan) → backup (lockfile + @deepseek-ai manifests + old version) → layout-adaptive `npm install` (in-place for local projects, `-g` for global installs) → post-install re-read check `installed==latest` → eco sync. Requires `{ "confirm": true }`; supports `{ "dry": true }` to preview (incl. dry-run output).
  - `POST /dsh-update-checker/rollback` — **main-program rollback**: reinstalls the old version recorded in the newest backup (same guards), taking a safety snapshot first. Requires `{ "confirm": true }`.
  - `GET /dsh-update-checker/backups.json` — lists main-program and plugin backups (rollback entry data).
  - `POST /dsh-update-checker/restart` — restarts the dsh web service (launcher derived from the current process argv, kill by PID + port; detached grandchild runs `restart-watchdog.ps1` which confirms recovery via an HTTP 200 probe and writes a result JSON). Requires `{ "confirm": true }`.
  - `GET /dsh-update-checker/restart-status.json` — the most recent watchdog result (whether the service recovered).
  - `GET /dsh-update-checker/plugins.json` — scans installed third-party plugins (multi-location `node_modules`, pnpm-hoisted aware), compares each against npm + GitHub (semver), returns update status plus an `ignored` list for local tools.
  - `POST /dsh-update-checker/plugin-update` — updates one plugin via temp-dir `npm install` (automatic `--allow-scripts` pass on npm ≥ 12) + copy, with **dependency version reconciliation**; GitHub-sourced plugins go through codeload with build-artifact validation and a staged dependency install. Requires `{ "confirm": true, "name" }`.
  - `POST /dsh-update-checker/plugin-rollback` — restores a plugin from `.dsh-plugin-backups/<id>`. Requires `{ "confirm": true, "id" }`.
- **Client half** (`lib/client.js`) is a web module (ModuleLoader format) that registers two cells in the root-scoped `shell.overlay` slot:
  - the **core banner** (top): update / up-to-date / failure states for the main program (立即更新 / 重新检查 / 知道了; 不再提示 persists suppression; when an update exists it shows the `brief` line: vX→vY + risk + notes),
  - the **plugin banner** (below, offset): lists updatable plugins (`installed → latest`) with single / update-all buttons and per-plugin success/failure feedback.
  On page load both check once, then re-check every 6 hours. The settings page ("检查更新") additionally shows **rollback buttons** for the main program and each plugin (when a backup exists).

## Localization

The banner follows the DSH UI language through the client `locale` service (`@deepseek-ai/dsh-client-locale`): **zh → 中文, en → English**, and only those two are shipped — any other locale falls back to Chinese. Switching DSH's language (Settings → General → Language) updates the banner text instantly without a reload. If the locale service is absent from the composition, the client falls back to the Chinese dictionary.

## Install & mount

The package is a [profile bundle](https://github.com/deepseek-ai/deepseek-harness) (its manifest declares `dsh.bundle.patch`).

```bash
# 1) put the package into $DSH_HOME/profiles/node_modules/ so the profile can resolve it.
#    ⚠️ Do NOT run `npm install` directly inside $DSH_HOME/profiles — it has no
#    package.json and npm would prune the entire node_modules (data loss).
#
#    Safe option A — install in a temp dir, then copy only this package:
npm i dsh-update-checker --prefix <temp-dir> --no-save
cp -r <temp-dir>/node_modules/dsh-update-checker $DSH_HOME/profiles/node_modules/
#
#    Safe option B — copy the package directory manually (from a git clone or tarball).

# 2) add the row to $DSH_HOME/profiles/web/cordis.patch.yml
```

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- insert:
    - id: dsh-update-checker
      name: 'dsh-update-checker'
```

Then let patch HMR apply it (or restart `dsh web`) and reload the page.

> Step-by-step guide with troubleshooting (中文): [docs/INSTALL.md](docs/INSTALL.md).

## Configuration & portability

All paths are **auto-detected at runtime — nothing is hardcoded**, so the same package works on any machine:

- **Plugin / profile directory** (`$DSH_HOME/profiles/node_modules`): derived from the plugin's own install location (`import.meta.url`), walking up to the enclosing `node_modules`. No configuration needed.
- **`$DSH_HOME`**: derived as the parent of the `profiles` root (state file, backups, and restart log all live there).
- **Composition file** (`cordis.patch.yml`): defaults to `$DSH_HOME/profiles/web/cordis.patch.yml`; if absent, any other `cordis.patch.yml` under `$DSH_HOME/profiles/` containing the plugin id is used.
- **Deployment root**: detected in two strategies, in order:
  1. **Junction resolution** — on machines where `profiles/node_modules/@deepseek-ai/dsh` is a junction (the common "save C-drive" setup), `realpath()` yields `<deploy-root>/node_modules/@deepseek-ai/dsh`, so the deployment root is derived automatically.
  2. **Fallback candidates** — environment variable `DSH_DEPLOY_ROOT`, then `process.cwd()` (launchers usually `cd` into the deployment directory). To point elsewhere, set `DSH_DEPLOY_ROOT` or append to `DEPLOY_ROOT_CANDIDATES` at the top of `lib/index.js`.
- **Restart launcher**: self-adapting — probes common names (`start-dsh.cmd`, `启动 dsh.bat`, `start-dsh.bat`, …) under the detected deployment root; the web port is read from the running `webServer.port`. No machine-specific paths are hardcoded in the restart flow.
- Persisted state (suppression flag, backups) lives under the detected `$DSH_HOME` — machine-independent.

## Platform & install-layout support

- **Detection (the checks)** is layout-agnostic: paths are derived from the plugin's own install location and work on any machine (see "Configuration & portability").
- **One-click update & restart are currently tuned for the layout they were developed on:**
  - **Windows only** — the restart flow spawns PowerShell (`taskkill` + a derived/`.cmd` launcher) and the watchdog script is PowerShell.
  - **Layout-adaptive main-program update** — if the deployment root has a `package.json` (a local project, e.g. a wrapper that declares only `@deepseek-ai/dsh`): in-place `npm install @deepseek-ai/dsh@latest` (`-g` would install into the global prefix and leave the deployment untouched). If there is no `package.json` (npm global install): `npm install -g @deepseek-ai/dsh@latest`. Both forms run a dry-run guard first (no `remove` allowed in the plan) and re-read the installed version afterwards. npm ≥ 12 automatically gets `--allow-scripts` (npm 11 runs dependency scripts by default, verified — no flag needed).
  - **Plugin updates** — temp-dir install + copy, compatible with npm 11/12+; GitHub-sourced plugins get build-artifact validation and a staged dependency install after extraction.
- On other platforms/layouts the banners and version checks still work, but the update/restart buttons will fail or need code adaptation. Linux/macOS support is a natural next step.

## Notes

- **Host code changes require a service restart to take effect** (the loader caches imported modules); client code changes are picked up by the client-modules HMR watch and apply on the next page refresh.
- The update/rollback/restart/suppress/settings POST routes are guarded by `{ "confirm": true }` **and** a loopback-source check (127.0.0.1/::1), so a stray request or a LAN client cannot trigger an install, rollback, or restart.
- Update safety: a backup (deployment `package-lock.json` + both @deepseek-ai version manifests + `backup-meta.json` with the old version) is written to `$DSH_HOME/dsh-update-checker-backups/<timestamp>/` before `npm install` runs; both main-program and plugin rollback routes are provided.

## Changelog

- **v1.4.0** — Full defect-list fix:
  - **GitHub channel works locally (R31)**: a dedicated HTTPS client for GitHub domains (`rejectUnauthorized:false` limited to github.com / *.githubusercontent.com, compatible with the local S302 proxy's self-signed cert), with redirect following, download size caps, and timeouts; codeload tarballs are validated before install (entry file from `main`/`exports` exists, tag matches `package.json` version) so source-only repos can't replace runnable plugins; GitHub-sourced plugins get a staged dependency install (with version reconciliation and native builds) after extraction.
  - **Plugin dependency version reconciliation**: deps whose installed version doesn't satisfy the new range are backed up and replaced (`satisfies` is a self-contained npm-semver-compatible subset — 1110 cross-check cases against npm's semver, 0 mismatches).
  - **Native dependency builds**: npm ≥ 12 automatically gets a second install pass with an `--allow-scripts` allow-list (npm 11 runs dependency scripts by default, verified empirically).
  - **Main-program update guards**: dry-run guard (no `remove` in the plan) → backup (incl. old version) → **layout-adaptive install** (in-place for local projects / `-g` for global) → **post-install re-read check** `installed==latest` (no more constant success).
  - **Real rollback**: `POST /rollback` (main program, reinstalls the recorded version + sync + verify), `POST /plugin-rollback` (restore from `.dsh-plugin-backups/<id>`), `GET /backups.json`; rollback buttons in the settings page.
  - **Multi-location scan**: `profiles/node_modules` + `profiles/*/node_modules` (pnpm hoisted compatible), deduped by realpath; unpublishable local tools move to `ignored` instead of spamming "not on npm registry".
  - **Loopback guard on write routes**: update/rollback/restart/plugin-update/plugin-rollback/suppress/settings require a 127.0.0.1/::1 source.
  - **Reliable watchdog**: launcher derived from the current process argv (no more filename guessing), kill by PID + port, recovery confirmed via an HTTP 200 probe, result written to JSON and exposed via `GET /restart-status.json`.
  - **Change brief**: main-program and plugin checks include `brief` (vX→vY + risk level + GitHub release notes), shown in the banner.
  - **Low-severity items**: readJsonBody now returns 413 on bodies > 1 MB (no silent truncation); npm channel uses the full packument with stable-first selection (a prerelease `latest` tag no longer causes false positives); codeload downloads have a size cap; header comments versioned; `npm test` adapted to the glob form for this machine.
- **v1.3.2** — Fix `runSync` failing to copy newly-added `@deepseek-ai` packages (a missing profile dir made `realpath` throw ENOENT and abort the sync); fix `parseGhRepo` truncating repository names that contain dots. Add integration tests that simulate real-copy and junction deployment layouts in a temp dir (via the `DSH_UC_PROFILE_NODE_MODULES` hook) covering eco-version reads, sync planning, sync execution, backup, and deploy-root detection. All tests run with `npm test` (30 assertions + host `apply()` smoke test).
- **v1.3.1** — GitHub cross-check for plugin updates: read each plugin's `repository` field and query `api.github.com/releases/latest`, cross-verify against npm (target version = the higher of the two, GitHub preferred as download source on ties), support plugins that exist only on GitHub (download via `codeload` tarball, backup + replace), show the update source (`[GH]` / `[GH/npm]`) in settings. If GitHub is unreachable it silently falls back to npm; if both sources fail the plugin reports a combined error (timeout included). Adds fetch timeouts (20s queries / 120s download).
- **v1.3.0** — Add a "检查更新" (Update Check) settings page: main-program and per-plugin version comparison with yellow/green status lamps, in-page one-click update + per-plugin update (serial queue with live progress "1/N" and per-row realtime refresh), independent re-check buttons, floating-banner / notification toggle switches (styled sliders), a single "don't remind" that suppresses both banners and is re-enableable from settings, draggable banners, and a plugin-update lock with a 10-minute takeover timeout (no more permanent 409 when an npm install hangs).
- **v1.2.3** — Plugin banner UX overhaul: per-plugin update now shows "{name} updated to vX.Y.Z" (no longer misleading "all up to date"), the banner stays visible after acknowledging a partial update (still lists the remaining updatable plugins instead of vanishing), long plugin/result lists scroll inside a viewport-height-capped area with styled scrollbars, batch update shows live progress "Updating {name}… (6/15)", acknowledging a fully-completed batch dismisses the banner cleanly, and both banners are draggable by their title/blank area.
- **v1.2.2** — One-click update now runs `npm install -g @deepseek-ai/dsh@latest` with `--allow-scripts` for the five native-dependency packages (npm 11 requirement), invoked through `process.execPath` + the bundled `npm-cli.js` (no PATH dependence). Fixes the previous non-`-g` `npm install` which, on machines where dsh is installed globally (global prefix without a `package.json`), would treat the whole global `node_modules` as extraneous and prune it.
- **v1.2.1** — README: add a Features section (full update lifecycle overview).
- **v1.2.0** — Auto-detect all paths (profile dir, `$DSH_HOME`, composition file, deploy root, restart launcher) from the plugin's own install location; merge the former standalone `dsh-plugin-checker` plugin-update capability.

## Development

- `lib/index.js` — Host half: plain ESM, depends only on Node built-ins. No build step. The pure helpers (`parseVersion`, `compareVersions`, `satisfies`, `pickNpmLatest`, `deriveRisk`, `tagToVersion`, `parseGhRepo`, `planSyncFromMaps`, `planDepMerges`, `resolveEntryFile`, `extractTarGzToDir`, `truncate`, `isLoopback`, …) are exported as named ESM exports for unit testing.
- `lib/client.js` — Client half: plain JS, `window.__ModuleLoader__` format, requires only `react`. No build step.
- Unit tests: `npm test` (alias for `node --test "scripts/*.test.mjs"`, Node ≥ 20 with the built-in test runner, no third-party deps). Coverage: semver comparison & tag/repo parsing (`unit-semver.test.mjs`), v1.4.0 pure helpers (`unit-v140.test.mjs`), sync planning (`unit-sync.test.mjs`), tar extraction incl. path-escape safety (`unit-tar.test.mjs`), plus the host `apply()` smoke test.
- `scripts/test-host-apply.mjs` — isolation test that drives `apply()` with a fake context (also picked up by `npm test`).
- `scripts/restart-service.ps1` — manual service restart helper (run with `-ExecutionPolicy Bypass`); pass `-Launcher` (or set `DSH_RESTART_LAUNCHER`) plus optional `-Port/-WorkingDir/-Log`.

## License

MIT
