# dsh-update-checker

English | [中文](README.zh.md)

A permanent Cordis plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI that **auto-checks for new DeepSeek Harness releases and installed third-party plugin updates** (the former standalone `dsh-plugin-checker` was merged in v1.1.0), asks the user, and one-click updates with success/failure feedback.

## Features

- **Full update lifecycle** — check, backup, update, **rollback**, and restart, all in one plugin.
- **Main program check** — compares the installed `@deepseek-ai/dsh` against the npm latest (full packument, stable-first, semver-aware — a pre-release `latest` tag won't cause false positives).
- **Third-party plugin check** — scans installed non-official plugins (layout-agnostic, incl. pnpm-hoisted `node_modules`), cross-compares each against **npm + GitHub** (target = higher version); local tools with no publish source go to `ignored`.
- **Working GitHub channel** — dedicated HTTPS client for GitHub domains (tolerates self-signed local proxies; the npm registry still uses strict TLS), with redirects, size caps and timeouts; codeload tarballs are validated before install.
- **In-GUI banner** — locale-aware (zh/en follows the DSH UI language), states update / up-to-date / failure, with a suppression flag and a **change brief** (vX→vY + risk level + release notes when available).
- **One-click update with safety** — main program: dry-run guard (abort if the plan contains `remove`) → backup → layout-adaptive install (in-place or `-g`) → post-install check `installed==latest`; plugins: temp-dir install + copy, dependency version reconciliation, auto `--allow-scripts` for native deps on npm ≥ 12. **Updates (and rollbacks) persist to the profile `package.json` + lockfile** (`pnpm install --lockfile-only` / `npm install --package-lock-only`), so a later install never silently reverts the plugin — no more "same plugin keeps asking for the same update" loops.
- **Real rollback** — main program via `POST /rollback`, plugins via `POST /plugin-rollback`; `GET /backups.json` lists both.
- **Restart with watchdog** — launcher derived from the current process argv, kill by PID + port, recovery confirmed by port listening + an HTTP 200 probe (`GET /restart-status.json`).
- **Write-route security** — all write routes require `{ "confirm": true }` **and** a loopback source (127.0.0.1/::1), so LAN clients can't trigger update/restart/rollback.
- **Zero-config portability** — profile dir / `$DSH_HOME` / composition file / deploy root are all derived from the plugin's own install location; works on any machine without editing code.

### Host & Client

- **Host** (`lib/index.js`) — HTTP routes: `status.json` (check), `suppress`, `update` (with `dry` preview), `rollback`, `backups.json`, `restart`, `restart-status.json`, `plugins.json`, `plugin-update`, `plugin-rollback`.
- **Client** (`lib/client.js`) — renders two banners in the root `shell.overlay` slot: a core banner (main-program update state) and a plugin banner (updatable plugins with single / update-all buttons). Both check on page load, then every 6 hours; the settings page ("检查更新") adds rollback buttons.

## Install & mount

The package is a [profile bundle](https://github.com/deepseek-ai/deepseek-harness) (its manifest declares `dsh.bundle.patch`).

```bash
# 1) put the package into $DSH_HOME/profiles/node_modules/ so the profile can resolve it.
#    ⚠️ Never run `npm install` directly inside $DSH_HOME/profiles — it has no
#    package.json and npm would prune the whole node_modules (data loss).
#    Safe option A — install in a temp dir, then copy only this package:
npm i dsh-update-checker --prefix <temp-dir> --no-save
cp -r <temp-dir>/node_modules/dsh-update-checker $DSH_HOME/profiles/node_modules/
#    Safe option B — copy the package directory manually (git clone or tarball).

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

All paths are **auto-detected at runtime — nothing is hardcoded**:

- **Plugin / profile dir** — derived from the plugin's own install location (`import.meta.url`).
- **`$DSH_HOME`** — the parent of the `profiles` root (state, backups, restart log live there).
- **Composition file** — defaults to `$DSH_HOME/profiles/web/cordis.patch.yml`.
- **Deployment root** — junction `realpath` first, then `DSH_DEPLOY_ROOT`, then `process.cwd()`, then the **npm global prefix** (parent of `npm root -g`'s output; v1.4.9+ covers `npm -g` installs).
  - systemd / `npm -g` escape hatch: if auto-detection ever misses your setup, set `DSH_DEPLOY_ROOT` to the directory that contains `node_modules/@deepseek-ai/dsh` (e.g. `<npm prefix>/lib` on Linux).
- **Node / npm executables** — `resolveNodeExe()` finds the real Node: `DSH_UC_NODE_EXE` override → `npm_node_execpath` → `process.execPath` when it is Node → common install dirs → `PATH`. This is what makes DSH Desktop (Electron, where `process.execPath` is `electron.exe`) able to run npm for plugin updates. If your Desktop build bundles Node elsewhere, set `DSH_UC_NODE_EXE` to it.
- **Restart launcher** — self-adapting: probes common launcher names under the deployment root; the web port is read from the running `webServer.port`.

## Platform & install-layout support

- **Detection (checks)** — layout-agnostic, works on any machine.
- **One-click update & restart** — tuned for the layout they were developed on:
  - **Windows only** — the restart flow spawns PowerShell.
  - Main-program update adapts: in-place `npm install` when the deploy root has a `package.json`, `npm install -g` otherwise; both run the dry-run guard and re-read the installed version afterwards.
  - Plugin updates — temp-dir install + copy, npm 11/12+ compatible.
- Other platforms/layouts: banners and version checks still work, but the update/restart buttons need code adaptation. Linux/macOS support is the natural next step.

## Notes

- **Host code changes require a service restart** (the loader caches imported modules); client changes are picked up by HMR and apply on the next page refresh.
- Update/rollback/restart/suppress/settings routes are guarded by `{ "confirm": true }` **and** a loopback-source check (127.0.0.1/::1).
- Before `npm install`, a backup (deployment `package-lock.json` + both @deepseek-ai version manifests + `backup-meta.json`) is written to `$DSH_HOME/dsh-update-checker-backups/<timestamp>/`; both main-program and plugin rollback routes are provided.

## Changelog

- **v1.4.13** — npm deadlock fast-fuse: npm resolving the huge dsh dependency tree can deadlock with **no output** (this machine: guaranteed, BUG evidence #7). `runNpm`/`runNpmProgress` now kill the child after **120 s of zero output** (`ENPMDEADLOCK`) instead of waiting out the 600 s timeout, so the main-program update falls back to the whole-tree tarball install after ~2 minutes instead of ~10 — the update completes in roughly 5 minutes instead of 16.

- **v1.4.12** — Make the main-program update actually reach the target version on slow/blocked npm trees + restart usability:
  - **Tarball fallback now updates the WHOLE `@deepseek-ai` tree, not just `@deepseek-ai/dsh`**: v1.4.10's fallback only replaced the main package, so the post-install integrity check (`verifyDeployTree`: every `dsh-*` package must equal the target version) was *guaranteed* to fail → rollback → "update complete but still the old version after restart". The fallback now downloads the tarball of the main package **and every `dsh-*` subpackage whose version differs** from the target and extracts them over the deployment tree (registry-direct, no npm resolution), with per-package progress and a failure list that the integrity check still validates.
  - **`/restart` lock auto-expires**: `restartScheduled` was never reset on the success path, so after the first restart every later attempt returned 409 "restart already scheduled". It now expires 180 s after scheduling.
  - **Settings page gains a manual "Restart service" button** (Display & control box) — the update flow itself no longer calls `/restart` (the worker restarts internally, v1.4.11), so this is the explicit, observable way to restart and verify the watchdog works.

- **v1.4.11** — Fix "update completes instantly but the restart does nothing / still the old version", Electron (DSH Desktop) plugin updates, and banner UX:
  - **Main-program update no longer restarts prematurely** ([#9](https://github.com/Airmetro/dsh-update-checker/issues/9) — reported by Airmetro): `/update` only *starts* the detached worker (stop service → install → verify → restart → health check). The client previously treated that HTTP 200 as "update done" and immediately called `/restart`, racing the worker's install (file locks → install fails → rollback → the service came back on the old version). Now the banner and the settings page poll `update-progress.json` until the worker reports `phase=done`/`error`, and only then show "update complete" and reload the page. The worker itself restarts the service, so no separate restart call is needed.
  - **DSH Desktop (Electron) plugin updates fixed** ([#8](https://github.com/Airmetro/dsh-update-checker/issues/8)): all npm/pnpm subprocesses were spawned with `process.execPath`, which under Electron is `electron.exe` — npm never ran, producing `WSALookupServiceBegin…10108` / "npm install produced no package". New `resolveNodeExe()` finds the real Node (env override `DSH_UC_NODE_EXE` → `npm_node_execpath` → execPath-if-node → common install dirs → PATH), and `getNpmCli()` derives npm-cli.js from it. The main-update worker is also spawned with the real Node.
  - **Banner shows only after both checks finish**: the main-program banner and the plugin banner now wait for *both* checks to complete before showing anything (no more two-stage popups). Plugin checks also run concurrently (were sequential).
  - **Settings "Display & control" renders immediately**: the toggles and download-source select are rendered right away with defaults instead of waiting for `settings.json` (the whole controls box used to be empty until the network round-trip).
  - `probeNpmGlobalRoot` caches failures for 60s instead of per-process (npm -g layout still covered).
  - New pure function `buildNodeExeCandidates()` (unit-tested); test suite 110 pass.

- **v1.4.10** — Main-program update hardened into a safe state machine (fixes the 2026-08-20 incident where an in-place `npm install` while the service was running corrupted `node_modules` and took the web UI down):
  - **D2 (critical)** — the update no longer runs `npm install` while the service is alive. `/update` now backs up, writes a worker script, and detaches it via a two-level spawn; the worker **stops the service first** (taskkill + port-release wait), installs, verifies, restarts, and health-checks — killing the old process can no longer corrupt the install.
  - **D1 (critical)** — the install now has a real timeout (spawn watchdog; previously `opts.timeout` was ignored). On npm failure/timeout it falls back to a **registry tarball direct install** (this machine's npm deadlocks resolving the 587-package dsh tree — BUG evidence #7); if that also fails it **rolls back from the backup** and restarts the service.
  - **D3** — post-install integrity check (`verifyDeployTree`): all `@deepseek-ai/dsh-*` packages must match the target version, `dsh-web-frontend/dist` assets must match `index.html` references, and every client package must have a real entry file (no empty shells).
  - **D4** — after restart, a health check fetches `/` (HTTP 200) **and** every `/assets/` + `/plugins/` reference, rejecting any that return `text/html` (SPA fallback would fool a status-code-only check).
  - **D5** — after a successful install the deploy-root `package.json` declaration is rewritten to the exact installed version (no `^` range, killing the downgrade bomb).
  - **D6** — error logs now carry the child's stderr/stdout tail and the failure code (no more bare "Command failed").
  - **D7** — a dry-run timeout is treated as "this tree cannot be resolved" and the update aborts (no more skipping the guard and installing blind).
  - Main-program version selection also switched to npm+GitHub dual sources with `pickMainLatest()` (no stable-first — the main program is all pre-releases), so an rc published to the `next` channel is no longer hidden.
  - New: `verifyDeployTree()`, `stopDshService()`, `startDshService()`, `healthCheckDsh()`, `rollbackMainFrom()`, `syncDeployDeclaration()`, `main-update-worker.mjs` (detached worker), `pickMainLatest()`, `mainTagToVersion()`. Tests 104 pass.

- **v1.4.9** — Fix `findDeployRoot` missing npm -g global installs ([#7](https://github.com/Airmetro/dsh-update-checker/issues/7)) + preferred download source:
  - **Deploy-root detection now also probes the npm global prefix** (`npm root -g`'s parent dir, e.g. `<prefix>/lib/node_modules` → `<prefix>/lib`): on Linux servers where dsh is installed `npm -g` and the web service is managed by systemd, both previous probes missed (the profile dir is a plain directory under pnpm hoisting, not a junction, and the working directory is the user's home), so the installed version showed `?`. The probe is async + cached and silently skipped on failure; a `DSH_UC_NPM_GLOBAL_ROOT` test hook lets integration tests simulate the layout.
  - **Preferred download source setting** (settings page): when npm and GitHub have the **same version (tie)**, you can now choose the preferred source — `GitHub (default)` / `npm` / `Smart (try GitHub first, then npm)`. Non-tie cases still follow the higher version. In `smart` mode a tie falls back to npm on **any** GitHub failure (not just the `ENOBUILD`/`ETAGMISMATCH`/`ETOOBIG`/`EDOWNLOAD` whitelist), so users who cannot reach GitHub can still update; non-tie updates keep the version-higher rule and the error-code whitelist to avoid downgrades.
  - New pure function `pickTargetSource()` (unit-tested); integration test for the npm -g layout.

- **v1.4.8** — GitHub download failures now fall back to npm:
  - When the GitHub codeload download fails (HTTP 5xx/429, network error, timeout) or the tarball is corrupt, the error is tagged `EDOWNLOAD` and the update **automatically falls back to the npm channel** when the plugin exists on npm (previously a `502` had no error code and aborted the update). Fixes the real-world case where a local GitHub proxy returns `502` for `codeload.github.com` (e.g. hosts-hijacked S302 proxy) and plugin updates died with "GitHub download HTTP 502".
  - New pure function `isGhFallbackable()` (unit-tested); GitHub→npm fallback now covers `ENOBUILD` / `ETAGMISMATCH` / `ETOOBIG` / `EDOWNLOAD`.

- **v1.4.7** — Robust pnpm discovery for lockfile sync:
  - `findPnpm` now also probes the **npm global prefix derived from `NPM_CLI`** and a **PATH fallback** (`pnpm.cmd` / `pnpm`), and uses `corepack.cmd`/`corepack.exe` on Windows instead of the bash-only `corepack` shim (an extension-less `#!/bin/sh` file that `cmd.exe` cannot run). This makes plugin-update persistence sync `pnpm-lock.yaml` on Windows user-level npm prefixes (e.g. `%APPDATA%\npm`) and Linux standalone pnpm installs, not just node-dir-adjacent layouts.
  - New pure function `pnpmCandidates()` (unit-tested) returns the cross-platform candidate list.

- **v1.4.6** — Fix the "same plugin keeps asking for the same update" loop:
  - **Plugin updates now persist to the profile manifest + lockfile**: previously the one-click update only swapped files inside `node_modules/<plugin>` — the profile's `package.json` still declared the old version and `pnpm-lock.yaml`/`package-lock.json` still pinned it, so the next `pnpm install`/`npm install` (or a profile reinstall) silently reverted the plugin to the old version and the banner asked for the same update again, forever. After an update (or rollback) the checker now writes the new dependency spec back into every profile `package.json` that declares the plugin and syncs the lockfile via `pnpm install --lockfile-only` / `npm install --package-lock-only` (no `node_modules` churn, no install scripts). Spec rewrite is conservative: `^0.12.3 → ^0.13.1` (operator preserved), exact pins stay exact, complex ranges become npm-default `^new`, `github:owner/repo` gets pinned to the release tag (`github:owner/repo#tag`), and non-derivable specs (`file:`, `workspace:`, aliases) are left untouched. Rollback is symmetric: the pre-update spec is recorded in `backup-info.json` and written back on rollback.
  - Persistence failure never vetoes the update itself (files are already replaced); the result is reported in the API response and recorded in the ops log (`persistedManifest` / `persistedLock`).
- **v1.4.5** — New red lamp state in the settings page:
  - **Three-color status lamps**: yellow = update available; green = up to date; **red = three abnormal states** — ① the author deleted the repo (no source found on either npm or GitHub); ② the author rolled back (the locally installed version is higher than both publish sources); ③ the publish source cannot be queried. Hover a red lamp to see the specific reason.
  - The plugin banner is back to the same position as the main banner (`top:64px`) instead of being offset below.
- **v1.4.4** — Fix two community-reported issues:
  - **No more false update flags for monorepo subpackages** ([#3](https://github.com/Airmetro/dsh-update-checker/issues/3)): when checking the GitHub source, the release tag is only trusted if the `name` in the repo-root `package.json` matches the locally installed plugin name. A main-repo tag (monorepo root name ≠ subpackage name) is treated as unrelated to the plugin, so only the npm source is used — no more perpetual yellow light followed by a failed update (e.g. `@tt-a1i/archify-dsh`, `@vectorize-io/hindsight-coding-agents`). If the root package name cannot be fetched (rate limit / network), the previous behavior is kept so GitHub-only plugins are not affected.
  - **Banner no longer hidden behind the session header / context-injection chips** ([#5](https://github.com/Airmetro/dsh-update-checker/issues/5)): the `shell.overlay` container sits in a low stacking context, so a child `z-index` cannot lift the banner above it. The whole overlay layer is now raised above headers/chips (≤100) and below full-screen overlays (1000), and the banner's initial position is moved down clear of the header area.
- **v1.4.3** — Fix two issues reported from the field:
  - `NPM_CLI` resolution now supports multiple node prefix layouts (incl. the standard Linux `<prefix>/lib/node_modules`), and `readNpmMajor` reads npm's version from the resolved location — plugin updates work on standard Linux layouts.
  - Optional GitHub API token authentication (`GH_TOKEN` / `GITHUB_TOKEN` env var, set per machine): only `api.github.com` gets `Authorization: Bearer`, raising the anonymous 60/h rate limit to 5000/h; codeload tarball downloads stay anonymous. The 403 error text now distinguishes rate limiting from an invalid token.
- **v1.4.1** — Update pipeline & backup management hardening:
  - Main-program update no longer times out / fakes success: explicit version instead of `@latest` (fast path ~1s vs full re-resolve ~145s), plus `forceReifyMain` (rename dir + reinstall) to work around npm 11's reify fast-path skip.
  - Live progress bar for main-program update (`update-progress.json`, staged phases), shown in banner and settings.
  - Plugin GitHub→npm automatic fallback when the GitHub source is source-only / tag mismatch / too big.
  - Scan dedup by package name; cross-UI update-state sync (banner ↔ settings); "Dismiss" (知道了) now actually closes the banner.
  - Backup management: configurable backup folder (native Windows folder picker + "Open folder"), "Clear backup cache" button, legacy location auto-migrated.
  - Operations log appended to `$DSH_HOME/dsh-update-checker-ops.log`.
- **v1.4.0** — Full defect-list fix:
  - Working GitHub channel: dedicated HTTPS client for GitHub domains (self-signed proxy compatible), codeload tarballs validated before install, staged dependency install for GitHub-sourced plugins.
  - Plugin dependency version reconciliation (backup + replace out-of-range deps); native builds (`--allow-scripts` allow-list on npm ≥ 12).
  - Main-program update guards: dry-run (no `remove`) → backup (incl. old version) → layout-adaptive install → post-install `installed==latest` check.
  - Real rollback (`POST /rollback`, `POST /plugin-rollback`, `GET /backups.json`) with settings-page rollback buttons.
  - Multi-location scan (pnpm-hoisted compatible, deduped); loopback guard on all write routes; reliable watchdog (argv-derived launcher + HTTP 200 recovery probe); change `brief` in banners.
  - Low-severity items: 413 on bodies > 1 MB, full-packument stable-first npm channel, codeload size caps, versioned header comments.
- **v1.3.2** — Fix `runSync` failing to copy newly-added `@deepseek-ai` packages (missing profile dir made `realpath` throw ENOENT); fix `parseGhRepo` truncating repo names containing dots. Add integration tests for real-copy and junction deployment layouts (`npm test`: 30 assertions + host `apply()` smoke test).
- **v1.3.1** — GitHub cross-check for plugin updates: query `api.github.com/releases/latest` from each plugin's `repository`, cross-verify against npm (target = higher version, GitHub preferred as download source on ties), support GitHub-only plugins (codeload), show source (`[GH]` / `[GH/npm]`) in settings; silent npm fallback when GitHub is unreachable; fetch timeouts (20s queries / 120s download).
- **v1.3.0** — New "检查更新" settings page: status lamps, one-click + per-plugin update (serial queue with live progress), re-check buttons, banner toggles, unified "don't remind" (re-enableable), draggable banners, plugin-update lock with 10-minute takeover timeout.
- **v1.2.3** — Plugin banner UX overhaul: accurate per-plugin success text, banner stays visible after partial updates, viewport-capped scrolling list, live batch progress, draggable banners.
- **v1.2.2** — One-click update now runs `npm install -g @deepseek-ai/dsh@latest --allow-scripts` (npm 11) via `process.execPath` + bundled `npm-cli.js` (no PATH dependence); fixes the previous non-`-g` install pruning a global `node_modules` without a `package.json`.
- **v1.2.1** — README: add Features section (full update lifecycle overview).
- **v1.2.0** — Auto-detect all paths (profile dir, `$DSH_HOME`, composition file, deploy root, restart launcher) from the plugin's own install location; merge the former standalone `dsh-plugin-checker` plugin-update capability.

## Development

- `lib/index.js` — Host half: plain ESM, Node built-ins only, no build step; pure helpers exported as named ESM exports for unit testing.
- `lib/client.js` — Client half: plain JS (`window.__ModuleLoader__`), requires only `react`, no build step.
- Tests: `npm test` (Node ≥ 20 built-in test runner, no third-party deps).
- `scripts/restart-service.ps1` — manual restart helper (run with `-ExecutionPolicy Bypass`).

## License

MIT
