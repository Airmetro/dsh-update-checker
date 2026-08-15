# dsh-update-checker

A permanent Cordis plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI that **auto-checks for new DeepSeek Harness releases AND installed third-party plugin updates** (the former standalone `dsh-plugin-checker` was merged in v1.1.0), asks the user, and one-click updates with success/failure feedback.

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

- **Deployment root** is detected via `process.cwd()` (each machine's launcher `cd`s into its deployment directory before starting `dsh`). If you start `dsh` from somewhere else, edit `DEPLOY_ROOT_CANDIDATES` at the top of `lib/index.js` and add your deployment directory.
- **Restart** is self-adapting across machines: the web port is read from the running `webServer.port`, and the launcher path is derived from the detected deployment root (`<root>/start-dsh.cmd`). No machine-specific paths are hardcoded in the restart flow.
- Persisted state (suppression flag, backups) lives under `$DSH_HOME` (`~/.dsh`) — machine-independent.

## Notes

- **Host code changes require a service restart to take effect** (the loader caches imported modules); client code changes are picked up by the client-modules HMR watch and apply on the next page refresh.
- The update/restart/suppress POST routes are guarded by `{ "confirm": true }` so a stray request cannot trigger an install or a restart.
- Update safety: a backup (deployment `package-lock.json` + both @deepseek-ai version manifests) is written to `$DSH_HOME/dsh-update-checker-backups/<timestamp>/` before `npm install` runs, so a failed upgrade can be rolled back.

## Development

- `lib/index.js` — Host half: plain ESM, depends only on Node built-ins. No build step.
- `lib/client.js` — Client half: plain JS, `window.__ModuleLoader__` format, requires only `react`. No build step.
- `scripts/test-host-apply.mjs` — isolation test that drives `apply()` with a fake context.
- `scripts/restart-service.ps1` — manual service restart helper (run with `-ExecutionPolicy Bypass`).

## License

MIT
