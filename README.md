# dsh-update-checker

A permanent Cordis plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI that **auto-checks for new DeepSeek Harness releases AND installed third-party plugin updates** (the former standalone `dsh-plugin-checker` was merged in v1.1.0), asks the user, and one-click updates with success/failure feedback.

## Features

- **Full update lifecycle** — check, backup, update, and restart, all in one plugin.
- **Main program check** — compares the installed `@deepseek-ai/dsh` version against the npm latest (semver-aware, pre-release handled).
- **Third-party plugin check** — scans installed non-official plugins (composition rows + `dsh` manifest, layout-agnostic) and compares each against npm latest.
- **In-GUI banner** — locale-aware (zh/en follows the DSH UI language), states update / up-to-date / failure, with a "don't remind me" suppression flag.
- **One-click update with safety** — backs up the deployment lockfile + `@deepseek-ai` version manifests before installing, so a failed upgrade can be rolled back; plugin updates install in a temp dir and copy in (never touches unrelated packages in `profiles/node_modules`).
- **Restart with watchdog** — restarts the dsh web service via a detached watchdog script (kills the port listener, relaunches the launcher, retries until the port recovers).
- **Zero-config portability** — profile dir / `$DSH_HOME` / composition file are derived from the plugin's own install location; the deployment root is resolved via junction `realpath` with `DSH_DEPLOY_ROOT` / `process.cwd()` fallback. Works on any machine without editing code.

- **Host half** (`lib/index.js`) registers HTTP routes:
  - `GET /dsh-update-checker/status.json` — fetches the latest `@deepseek-ai/dsh` version from the npm registry, reads the locally installed version (from the deployment's `node_modules`), compares them with semver semantics, and returns a JSON status (including the persisted `suppressUpToDate` flag).
  - `POST /dsh-update-checker/suppress` — persists the "don't remind me again" flag for the up-to-date banner (requires `{ "confirm": true }`).
  - `POST /dsh-update-checker/update` — **complete update**: backs up the deployment lockfile + @deepseek-ai version manifests, runs `npm install @deepseek-ai/dsh@latest` in the deployment root, then defensively syncs changed @deepseek-ai packages into `$DSH_HOME/profiles/node_modules` (skipped for junction-linked packages, which the running Web app resolves through). Requires `{ "confirm": true }`; supports `{ "dry": true }` to preview without executing.
  - `POST /dsh-update-checker/restart` — restarts the dsh web service (spawns a PowerShell helper that kills the port listener and relaunches `<deploy-root>/start-dsh.cmd`; the port and launcher path are derived at runtime). Requires `{ "confirm": true }`.
  - `GET /dsh-update-checker/plugins.json` — scans installed third-party (non-builtin) plugins (composition rows + `dsh` field, layout-agnostic), compares each against npm latest (semver), returns update status.
  - `POST /dsh-update-checker/plugin-update` — updates one plugin via temp-dir `npm install` + copy (never touches other packages in `profiles/node_modules`, junction-aware, backs up the old version first). Requires `{ "confirm": true, "name" }`.
- **Client half** (`lib/client.js`) is a web module (ModuleLoader format) that registers two cells in the root-scoped `shell.overlay` slot:
  - the **core banner** (top): update / up-to-date / failure states for the main program (立即更新 / 重新检查 / 知道了; 不再提示 persists suppression),
  - the **plugin banner** (below, offset): lists updatable plugins (`installed → latest`) with single / update-all buttons and per-plugin success/failure feedback.
  On page load both check once, then re-check every 6 hours.

## Localization

The banner follows the DSH UI language through the client `locale` service (`@deepseek-ai/dsh-client-locale`): **zh → 中文, en → English**, and only those two are shipped — any other locale falls back to Chinese. Switching DSH's language (Settings → General → Language) updates the banner text instantly without a reload. If the locale service is absent from the composition, the client falls back to the Chinese dictionary.

## Install & mount

The package is a [profile bundle](https://github.com/deepseek-ai/deepseek-harness) (its manifest declares `dsh.bundle.patch`).

```bash
# 1) install the package where the profile can resolve it
#    (the flat $DSH_HOME/profiles/node_modules fallback)
npm i dsh-update-checker        # in the profile, or copy the package directory manually

# 2) add the row to $DSH_HOME/profiles/web/cordis.patch.yml
```

```yaml
# $DSH_HOME/profiles/web/cordis.patch.yml
- insert:
    - id: dsh-update-checker
      name: 'dsh-update-checker'
```

Then let patch HMR apply it (or restart `dsh web`) and reload the page.

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

## Notes

- **Host code changes require a service restart to take effect** (the loader caches imported modules); client code changes are picked up by the client-modules HMR watch and apply on the next page refresh.
- The update/restart/suppress POST routes are guarded by `{ "confirm": true }` so a stray request cannot trigger an install or a restart.
- Update safety: a backup (deployment `package-lock.json` + both @deepseek-ai version manifests) is written to `$DSH_HOME/dsh-update-checker-backups/<timestamp>/` before `npm install` runs, so a failed upgrade can be rolled back.

## Changelog

- **v1.3.1** — GitHub cross-check for plugin updates: read each plugin's `repository` field and query `api.github.com/releases/latest`, cross-verify against npm (target version = the higher of the two, GitHub preferred as download source on ties), support plugins that exist only on GitHub (download via `codeload` tarball, backup + replace), show the update source (`[GH]` / `[GH/npm]`) in settings. If GitHub is unreachable it silently falls back to npm; if both sources fail the plugin reports a combined error (timeout included). Adds fetch timeouts (20s queries / 120s download).
- **v1.3.0** — Add a "检查更新" (Update Check) settings page: main-program and per-plugin version comparison with yellow/green status lamps, in-page one-click update + per-plugin update (serial queue with live progress "1/N" and per-row realtime refresh), independent re-check buttons, floating-banner / notification toggle switches (styled sliders), a single "don't remind" that suppresses both banners and is re-enableable from settings, draggable banners, and a plugin-update lock with a 10-minute takeover timeout (no more permanent 409 when an npm install hangs).
- **v1.2.3** — Plugin banner UX overhaul: per-plugin update now shows "{name} updated to vX.Y.Z" (no longer misleading "all up to date"), the banner stays visible after acknowledging a partial update (still lists the remaining updatable plugins instead of vanishing), long plugin/result lists scroll inside a viewport-height-capped area with styled scrollbars, batch update shows live progress "Updating {name}… (6/15)", acknowledging a fully-completed batch dismisses the banner cleanly, and both banners are draggable by their title/blank area.
- **v1.2.2** — One-click update now runs `npm install -g @deepseek-ai/dsh@latest` with `--allow-scripts` for the five native-dependency packages (npm 11 requirement), invoked through `process.execPath` + the bundled `npm-cli.js` (no PATH dependence). Fixes the previous non-`-g` `npm install` which, on machines where dsh is installed globally (global prefix without a `package.json`), would treat the whole global `node_modules` as extraneous and prune it.
- **v1.2.1** — README: add a Features section (full update lifecycle overview).
- **v1.2.0** — Auto-detect all paths (profile dir, `$DSH_HOME`, composition file, deploy root, restart launcher) from the plugin's own install location; merge the former standalone `dsh-plugin-checker` plugin-update capability.

## Development

- `lib/index.js` — Host half: plain ESM, depends only on Node built-ins. No build step.
- `lib/client.js` — Client half: plain JS, `window.__ModuleLoader__` format, requires only `react`. No build step.
- `scripts/test-host-apply.mjs` — isolation test that drives `apply()` with a fake context.
- `scripts/restart-service.ps1` — manual service restart helper (run with `-ExecutionPolicy Bypass`).

## License

MIT
