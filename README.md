# dsh-update-checker

English | [中文](README.zh.md)

A permanent Cordis plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI that **auto-checks for new DeepSeek Harness releases and installed third-party plugin updates** (the former standalone `dsh-plugin-checker` was merged in v1.1.0), asks the user, and one-click updates with success/failure feedback.

## Features

- **Full update lifecycle** — check, backup, update, **rollback**, and restart, all in one plugin.
- **Main program check** — compares the installed `@deepseek-ai/dsh` against the npm latest (full packument, **stable-first**, semver-aware — pre-release builds like `alpha`/`beta`/`rc` are skipped unless you enable the `allowPrerelease` setting, so the checker never auto-promotes the harness into an unintended pre-release channel).
- **Third-party plugin check** — scans installed non-official plugins (layout-agnostic, incl. pnpm-hoisted `node_modules`), cross-compares each against **npm + GitHub** (target = higher version); local tools with no publish source go to `ignored`. When a plugin name has multiple copies, the one in the **composition-owning profile's `node_modules`** wins (the rest are listed as `copies`), and each plugin can be excluded from prompts (`excludedPlugins`, re-enableable in the settings page).
- **Working GitHub channel** — dedicated HTTPS client for GitHub domains (tolerates self-signed local proxies; the npm registry still uses strict TLS), with redirects, size caps and timeouts; codeload tarballs are validated before install.
- **In-GUI banner** — locale-aware (zh/en follows the DSH UI language), states update / up-to-date / failure, with a suppression flag and a **change brief** (vX→vY + risk level + release notes when available).
- **One-click update with safety** — main program: dry-run guard (abort if the plan contains `remove`) → snapshot backup (version manifests + a `main-snapshot` copy of the `@deepseek-ai` tree for offline rollback) → layout-adaptive install (in-place or `-g`) → post-install check `installed==latest`; plugins: temp-dir install + copy, dependency version reconciliation, auto `--allow-scripts` for native deps on npm ≥ 12. **Updates (and rollbacks) persist to the profile `package.json` + lockfile** (`pnpm install --lockfile-only` / `npm install --package-lock-only`), so a later install never silently reverts the plugin — no more "same plugin keeps asking for the same update" loops.
- **Real rollback** — main program via `POST /rollback`, plugins via `POST /plugin-rollback`; `GET /backups.json` lists both.
- **Restart with watchdog** — launcher derived from the current process argv, kill by PID + port, recovery confirmed by port listening + an HTTP 200 probe (`GET /restart-status.json`).
- **Write-route security** — all write routes require `{ "confirm": true }` **and** a loopback source (127.0.0.1/::1), so LAN clients can't trigger update/restart/rollback.
- **Zero-config portability** — profile dir / `$DSH_HOME` / composition file / deploy root are all derived from the plugin's own install location; works on any machine without editing code.

### Host & Client

- **Host** (`lib/index.js`) — HTTP routes: `status.json` (check), `suppress`, `update` (with `dry` preview), `rollback`, `backups.json`, `restart`, `restart-status.json`, `plugins.json`, `plugin-update`, `plugin-rollback`, `plugin-exclude`.
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
- **Node / npm executables** — `resolveNodeExe()` finds the real Node: `DSH_UC_NODE_EXE` override → `npm_node_execpath` → `process.execPath` when it is Node → common install dirs → `PATH`. This is what makes DSH Desktop (Electron, where `process.execPath` is `electron.exe`) able to run npm for plugin updates. If your Desktop build bundles Node elsewhere, set `DSH_UC_NODE_EXE` to it. If your Node is managed by **mise / asdf / nvm** and your `PATH` only exposes the version-manager **shim** (e.g. `~/.local/share/mise/shims/node`), the shim directory has no `npm` beside it; v1.4.22+ resolves the real binary by running `node -p process.execPath` through the shim. If that still fails (or you want to skip the lookup), set `DSH_UC_NODE_EXE` to the real binary, e.g. `mise which node` / `asdf which node`.
- **Restart launcher** — self-adapting: probes common launcher names under the deployment root; the web port is read from the running `webServer.port`.
- **Tuning env vars** — `DSH_UC_UPDATE_PORT` sets the port the update worker stops/starts/probes (default `3080`), and `DSH_UC_RESTART_WINDOW_MS` sets how long the worker keeps observing a slow first start before giving up (default `150000`; the progress record streams the whole time).

## Platform & install-layout support

- **Detection (checks)** — layout-agnostic, works on any machine.
- **One-click update & restart** — tuned for the layout they were developed on:
  - **Windows only** — the restart flow spawns PowerShell.
  - Main-program update adapts: in-place `npm install` when the deploy root has a `package.json`, `npm install -g` otherwise; both run the dry-run guard and re-read the installed version afterwards.
  - Plugin updates — temp-dir install + copy, npm 11/12+ compatible.
- Other platforms/layouts: banners and version checks still work. On Linux/macOS the main-framework update route now refuses immediately with `501 E_PLATFORM_UNSUPPORTED` (install/restart there still need code adaptation) instead of hanging at 8% and leaving a stuck banner; plugin updates and rollback work. Full POSIX support is the natural next step.

## Notes

- **Host code changes require a service restart** (the loader caches imported modules); client changes are picked up by HMR and apply on the next page refresh.
- Update/rollback/restart/suppress/settings routes are guarded by `{ "confirm": true }` **and** a loopback-source check (127.0.0.1/::1).
- Before `npm install`, a backup (deployment `package.json` + `package-lock.json` + both @deepseek-ai version manifests + `backup-meta.json` + a `main-snapshot` copy of the `@deepseek-ai` framework tree) is written to `$DSH_HOME/dsh-update-checker-backups/<timestamp>/`; both main-program and plugin rollback routes are provided, and main-program rollback restores from the `main-snapshot` when present instead of re-installing from the registry.

## Changelog

- **v1.4.23** — Live main-program progress, stale-update recovery, safe plugin replacement (issues #17 #18 #20 #21 #25, PRs #23 #24):
  - **Real progress during the dependency-tree check (#18 + the "6% → 64%" report)**: the download phase used to sit at 4–6% for the whole `npm install --dry-run` (minutes) and then jump straight to 64%. Every phase now runs a monotonic *creep* ticker that rewrites the progress record once per second (`phaseCreepPercent`, exported and unit-tested), and real npm/tarball counts only push the floor forward. The milestones were rescaled (`download 10→55`, `stop 58`, `install 62→78`, `verify 84→87`, `sync-decl 88`, `restart 92→95`, `health 96`, `restart-pending 97–98`, `done 100`) so no phase teleports. The 30-second service start and the restart watch also stream progress while they block.
  - **Restart is observed instead of reported as failure (#18)**: after install + integrity + declaration sync succeed, a failed restart no longer ends the update. The worker enters `restart-pending`, keeps streaming progress, re-probes the port and re-spawns the launcher for up to `DSH_UC_RESTART_WINDOW_MS` (default 150000 ms), and only then fails with `E_RESTART` — with `installed`, `restartPending: true` and text stating the install itself succeeded. A later port appearing becomes a normal success.
  - **Progress counters fixed (#18)**: the install phase no longer divides npm's http-line counter by a hardcoded `587`; the total now comes from the real lockfile (`countLockPackages`, `null` when unknown) and `done` is clamped to it, so `done > total` cannot be displayed. The banner also states that closing the page does not interrupt the update.
  - **An auth-gated frontend is no longer mistaken for a broken service (#18, real-world)**: the health check required `GET /` to return 200, so on a host whose `/` answers **401/403** (a password/token-gated UI) *every* successful install ended as `E_RESTART: update installed <version> but restart/health failed: GET / -> 401`, while the crash-recovery started the service right after — the user was told the update failed when it had actually succeeded. Health classification is now a pure exported helper (`classifyHealthStatus`): 200 → full dist/asset verification; 401/403/407 → the service is up but the frontend is auth-gated, so the update succeeds and the asset sweep is skipped (recorded as `main-update-health-auth-gated`); timeouts, 5xx and other 4xx still fail. The `E_RESTART` text now quotes both the launcher error and the health problems.
  - **Stale progress/state reconciliation (#25)**: `writeProgress` no longer let the cached record overwrite the `at` timestamp — it froze at the first write, which is exactly why a killed update could look "fresh" or a live one look stale. Progress records now carry the owning `workerPid`/`hostPid`; `isStaleProgress` treats a record as stale when its owner process is gone (or, without pids, after 10 minutes without an update), and at startup / on read the host rewrites it to `running:false`, `phase:error`, `code:E_INTERRUPTED` and releases the update lock. A stale lock no longer blocks a new update for 10 minutes: locks older than the 2-minute spawn grace are dropped when no live worker owns them.
  - **A crashed worker can no longer leave `running:true` (#25)**: `uncaughtException`/`unhandledRejection` and a fatal `main()` rejection write an `error` progress record and release the lock; previously the process simply died. `startService`/`taskkill` spawns got `error` handlers (a POSIX `ENOENT` or a batch-file `EINVAL` used to become an unhandled error event that killed the worker mid-update), and a failed launch fails fast instead of waiting 30 seconds.
  - **Plugin replacement is now stage-then-swap (#21)**: `backupAndReplace` copies the new content into `.dsh-uc-staging-*` next to the target, renames the old directory to `.dsh-uc-trash-*`, renames the staged tree into place, and only then best-effort deletes the trash. Deleting a directory that contains a native module currently mapped by the running host used to raise `EPERM` *after* the delete-then-copy had already removed everything, leaving the package gutted (a locked `.node` file and nothing else, `package.json` included) and breaking the host. Any failure before the swap now leaves the installed package untouched, and a locked trash directory is simply swept on the next update. The two "stop reminding" buttons also stopped writing each other's flag.
  - **Transient request failures no longer reload the page (#20)**: the client's 1.5-second status probe treated any single failed fetch (LLM streaming, tool work, a proxy hiccup) as "the service restarted" and called `location.reload()` unconditionally, refreshing the page mid-conversation. Reloading is now driven by a server `instanceId`: the page reloads only when the reported instance actually changes, at most once per instance (`sessionStorage` guard), so transient failures are ignored entirely.
  - **Locale-service race fixed (#22/#23)**: the client half waits for the `locale` service (`ctx.inject(["slots", "locale"])`) before registering dictionaries and slot bindings, instead of reading `ctx.get("locale")` at apply time and silently binding `fallbackT()` (the Chinese dictionary) on an English UI.
  - **POSIX core updates fail fast (#24)**: the main-framework `/update` route returns `501 E_PLATFORM_UNSUPPORTED` immediately on Linux/macOS — before lock creation, backup or the Windows-only PowerShell spawn — instead of hanging at 8% with a stuck banner. Full POSIX support remains open (upstream PR #19).

- **v1.4.22** — Node version-manager shim resolution (issue #17):
  - `resolveNodeExe()` resolves a version-manager shim (mise/asdf/nvm) to the real Node binary by running `node -p process.execPath` through it, and `getNpmCli()` no longer falls back to a path that cannot exist — it throws `ENPMCLI` naming `DSH_UC_NODE_EXE` instead of producing `MODULE_NOT_FOUND` at npm time.

- **v1.4.21** — Main-program update across the npm -g nested layout (#16) + external-daemon / file-lock recovery (#15) + early wrong-deploy-root guard (#14):
  - **npm -g nested-layout verify** (#16): `verifyTree`/`verifyDeployTree` now locate `dsh-web-frontend` at its real path — top-level or nested inside `dsh/node_modules/@deepseek-ai` — instead of only the top-level path, so a global install no longer rolls back with `integrity check failed: dsh-web-frontend dist/index.html unreadable`.
  - **External daemon / EBUSY recovery** (#15): the stop step re-probes the port and re-kills listeners an external watchdog may have respawned; before every install it ensures the service is stopped; and an install failing with a file-lock (`EBUSY`/`EPERM`/…) or a re-occupied port retries up to 3 times instead of silently dying, always writing `running:false` + error to progress so the UI shows the failure.
  - **Early wrong-deploy-root guard** (#14): the update route now checks the resolved root actually contains `dsh-web-frontend` (top-level or nested) before touching anything, failing fast with `E_LAYOUT` instead of installing to the wrong place and rolling back.
  - **Stale-lockfile detection hardened**: `readLockedDshVersion` also inspects `node_modules/.package-lock.json`, and the reset is extracted into a testable unit so a lockfile claiming the target but physically lagging the tree is reliably cleared.

## Development

- `lib/index.js` — Host half: plain ESM, Node built-ins only, no build step; pure helpers exported as named ESM exports for unit testing.
- `lib/client.js` — Client half: plain JS (`window.__ModuleLoader__`), requires only `react`, no build step.
- Tests: `npm test` (Node ≥ 20 built-in test runner, no third-party deps).
- `scripts/restart-service.ps1` — manual restart helper (run with `-ExecutionPolicy Bypass`).

## License

MIT
