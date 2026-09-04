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
- Before `npm install`, a backup (deployment `package.json` + `package-lock.json` + both @deepseek-ai version manifests + `backup-meta.json` + a `main-snapshot` copy of the `@deepseek-ai` framework tree) is written to `$DSH_HOME/dsh-update-checker-backups/<timestamp>/`; both main-program and plugin rollback routes are provided, and main-program rollback restores from the `main-snapshot` when present instead of re-installing from the registry.

## Changelog

- **v1.4.21** — Main-program update across the npm -g nested layout (#16) + external-daemon / file-lock recovery (#15) + early wrong-deploy-root guard (#14):
  - **npm -g nested-layout verify** (#16): `verifyTree`/`verifyDeployTree` now locate `dsh-web-frontend` at its real path — top-level or nested inside `dsh/node_modules/@deepseek-ai` — instead of only the top-level path, so a global install no longer rolls back with `integrity check failed: dsh-web-frontend dist/index.html unreadable`.
  - **External daemon / EBUSY recovery** (#15): the stop step re-probes the port and re-kills listeners an external watchdog may have respawned; before every install it ensures the service is stopped; and an install failing with a file-lock (`EBUSY`/`EPERM`/…) or a re-occupied port retries up to 3 times instead of silently dying, always writing `running:false` + error to progress so the UI shows the failure.
  - **Early wrong-deploy-root guard** (#14): the update route now checks the resolved root actually contains `dsh-web-frontend` (top-level or nested) before touching anything, failing fast with `E_LAYOUT` instead of installing to the wrong place and rolling back.
  - **Stale-lockfile detection hardened**: `readLockedDshVersion` also inspects `node_modules/.package-lock.json`, and the reset is extracted into a testable unit so a lockfile claiming the target but physically lagging the tree is reliably cleared.

- **v1.4.20** — Main-program update robustness: stale-lockfile reify fix + frontend-dist verify via realpath (issue #14):
  - **Stale-lockfile reify fix**: when the target version is already declared in `package-lock.json` / `node_modules/.package-lock.json` (a leftover from a failed or partial update) but the physically installed `@deepseek-ai` tree is still older, npm's reify trusted the lockfile and skipped re-installing, so the update ended in `E_VERSION: update did not reach <target> (installed=<old>)` and rolled back — a perpetual "fake update" loop. The worker now detects this mismatch (lockfile-declared version ≠ physical version, and physical ≠ target) and deletes both stale lockfiles before installing, forcing npm to re-resolve and really re-install the target version.
  - **Frontend-dist verify via realpath** (#14): the post-install integrity check reads `dsh-web-frontend/dist/index.html`; it now resolves that directory through `realpath` (following junction / pnpm-hoisted install layouts) so a legitimately installed frontend is not mis-flagged, and if it still cannot be read it reports the exact path tried instead of a bare "unreadable" — previously the update rolled back with `integrity check failed: dsh-web-frontend dist/index.html unreadable`.

- **v1.4.19** — Follow pre-release builds when no stable release exists + clear npx-cache-layout warning (issue #14):
  - **No-stable fallback**: `pickMainLatest` now returns the highest published version (including pre-releases) when there are no stable `@deepseek-ai/dsh` releases, instead of returning `null` and failing the status check with "no stable version; enable allowPrerelease". The main framework currently ships only `rc`/`alpha` builds, so the stable-only default made the checker pointless.
  - **Stable-first kept when a stable exists**: if any stable release is present, the checker still prefers the highest stable and only follows pre-releases when `allowPrerelease` is on (preserving the v1.4.17 incident guard).
  - **npx-cache-layout warning** (#14): when the resolved deploy root is an npm `npx` cache path (`.../_npx/...`), the status check reports a clear note and the main-framework update route refuses with `E_NPX_CACHE`, pointing to the official local install or `npm i -g @deepseek-ai/dsh`, instead of silently installing to the wrong place and failing the post-install integrity check.

## Development

- `lib/index.js` — Host half: plain ESM, Node built-ins only, no build step; pure helpers exported as named ESM exports for unit testing.
- `lib/client.js` — Client half: plain JS (`window.__ModuleLoader__`), requires only `react`, no build step.
- Tests: `npm test` (Node ≥ 20 built-in test runner, no third-party deps).
- `scripts/restart-service.ps1` — manual restart helper (run with `-ExecutionPolicy Bypass`).

## License

MIT
