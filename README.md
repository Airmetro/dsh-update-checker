# dsh-update-checker

English | [中文](README.zh.md)

A permanent Cordis plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI that **auto-checks for new DeepSeek Harness releases and installed third-party plugin updates** (the former standalone `dsh-plugin-checker` was merged in v1.1.0), asks the user, and one-click updates with success/failure feedback.

## Features

- **Full update lifecycle** — check, backup, update, **rollback**, and restart, all in one plugin.
- **Main program check** — compares the installed `@deepseek-ai/dsh` against the npm latest (full packument, stable-first, semver-aware — a pre-release `latest` tag won't cause false positives).
- **Third-party plugin check** — scans installed non-official plugins (layout-agnostic, incl. pnpm-hoisted `node_modules`), cross-compares each against **npm + GitHub** (target = higher version); local tools with no publish source go to `ignored`.
- **Working GitHub channel** — dedicated HTTPS client for GitHub domains (tolerates self-signed local proxies; the npm registry still uses strict TLS), with redirects, size caps and timeouts; codeload tarballs are validated before install.
- **In-GUI banner** — locale-aware (zh/en follows the DSH UI language), states update / up-to-date / failure, with a suppression flag and a **change brief** (vX→vY + risk level + release notes when available).
- **One-click update with safety** — main program: dry-run guard (abort if the plan contains `remove`) → backup → layout-adaptive install (in-place or `-g`) → post-install check `installed==latest`; plugins: temp-dir install + copy, dependency version reconciliation, auto `--allow-scripts` for native deps on npm ≥ 12.
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
- **Deployment root** — junction `realpath` first, then `DSH_DEPLOY_ROOT`, then `process.cwd()`.
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
