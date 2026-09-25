# dsh-update-checker

English | [中文](README.zh.md)

A permanent Cordis plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI that **auto-checks for new DeepSeek Harness releases and installed third-party plugin updates** (the former standalone `dsh-plugin-checker` was merged in v1.1.0), asks the user, and one-click updates with success/failure feedback.

## Features

- **Full update lifecycle** — check, backup, update, **rollback**, and restart, all in one plugin.
- **Main program check** — compares the installed `@deepseek-ai/dsh` against the npm latest (full packument, **stable-first**, semver-aware). A pre-release target is installed only when it belongs to the channel the deployment already follows — a cross-channel promotion (`rc` → `alpha`) is refused with `E_PRERELEASE` unless you enable the `allowPrerelease` setting, so the checker never promotes the harness into an unintended pre-release channel.
- **Third-party plugin check** — scans installed non-official plugins (layout-agnostic, incl. pnpm-hoisted `node_modules`), cross-compares each against **npm + GitHub** (target = higher version); local tools with no publish source go to `ignored`. When a plugin name has multiple copies, the one in the **composition-owning profile's `node_modules`** wins (the rest are listed as `copies`), and each plugin can be excluded from prompts (`excludedPlugins`, re-enableable in the settings page).
- **Working GitHub channel** — dedicated HTTPS client for GitHub domains (tolerates self-signed local proxies; the npm registry still uses strict TLS), with redirects, size caps and timeouts; codeload tarballs are validated before install.
- **In-GUI banner** — locale-aware (zh/en follows the DSH UI language), states update / up-to-date / failure, with a suppression flag and a **change brief** (vX→vY + risk level + release notes when available).
- **One-click update with safety** — main program: dry-run guard (abort if the plan contains `remove`) → snapshot backup (version manifests + a `main-snapshot` copy of the `@deepseek-ai` tree for offline rollback) → layout-adaptive install (in-place or `-g`) → post-install check `installed==latest`; plugins: temp-dir install + copy, dependency version reconciliation, auto `--allow-scripts` for native deps on npm ≥ 12. **Updates (and rollbacks) persist to the profile `package.json` + lockfile** (`pnpm install --lockfile-only` / `npm install --package-lock-only`), so a later install never silently reverts the plugin — no more "same plugin keeps asking for the same update" loops.
- **Real rollback** — main program via `POST /rollback`, plugins via `POST /plugin-rollback`; `GET /backups.json` lists both.
- **Restart with watchdog** — launcher derived from the current process argv, kill by PID + port, recovery confirmed by port listening, an HTTP 200 probe (`GET /restart-status.json`) **and a new instance id** read back from this plugin's own routes, so "something answers on the port" is no longer mistaken for "the updated build came up".
- **Write-route security** — all write routes require `{ "confirm": true }` **and** a loopback source (127.0.0.1/::1), so LAN clients can't trigger update/restart/rollback.
- **Zero-config portability** — profile dir / composition file / deploy root are derived from the plugin's own install location, while state, backups and logs honour `DSH_HOME` (then `~/.dsh`); works on any machine without editing code.
- **Self-mounting on `dsh` `0.1.6-alpha.2`+** — that release switched the profile resolution default from `"link"` to `"runtime"`, which stops a third-party plugin in `$DSH_HOME/profiles/node_modules` from resolving and kills the launch with `ERR_MODULE_NOT_FOUND` before the server binds. The plugin now re-establishes its own mount at startup (`ensurePluginMount`): a junction from every profile's `node_modules` to the real package, plus the `dependencies` declaration each profile needs so ownership is recognised. Idempotent, never overwrites a spec you set deliberately, never deletes a directory it cannot prove is its own copy; `mount.json` / `status.json` report the state.

### Host & Client

- **Host** (`lib/index.js`) — HTTP routes: `status.json` (check), `mount.json` (self-mount state), `suppress`, `update` (with `dry` preview), `rollback`, `backups.json`, `restart`, `restart-status.json`, `plugins.json`, `plugin-update`, `plugin-rollback`, `plugin-exclude`.
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

### dsh `0.1.6-alpha.2` and later: the profile needs its own link

Step 1 alone is **no longer enough**. `0.1.6-alpha.2` changed the profile module-resolution
default from `"link"` to `"runtime"`, which turns `$DSH_HOME/profiles/node_modules` into a
*shared managed* directory that dsh excludes from Node's native resolve. It now only serves the
deployment dependency closure and the selected bundle closure (see `PluginPackages` /
`routeScoped` in `@deepseek-ai/dsh-app-boot`), and a third-party plugin belongs to neither — so
the bare `dsh-update-checker` name stops resolving and the launch dies with
`ERR_MODULE_NOT_FOUND: Cannot find package 'dsh-update-checker' imported from …\profiles\web\`
before the web server binds. (That importer path is *rewritten* by dsh to point at the profile
directory; the real failing base is `$DSH_HOME/package.json`. Do not trust the path in the
message.) Two things fix it, and both are needed:

```powershell
# 2a) link the profile's node_modules at the real package (junction, never a copy)
New-Item -ItemType Junction `
  -Path   "$env:USERPROFILE\.dsh\profiles\web\node_modules\dsh-update-checker" `
  -Target "$env:USERPROFILE\.dsh\profiles\node_modules\dsh-update-checker"

# 2b) declare the dependency in the profile manifest
#     $DSH_HOME/profiles/web/package.json → "dependencies": { "dsh-update-checker": "^1.6.1" }
```

A **junction is required rather than a copy**: the link's real path must stay
`…/profiles/node_modules/…`, or `pickDshHome` can no longer recognise the Harness home and the
plugin's self-location drifts (which would send its `@deepseek-ai/*` sync to the wrong place).
The declaration is what dsh's `readProfilePlugins` and this plugin's own
`findDeclaringProfiles`/`persistPluginUpdate` read to decide which profile owns the plugin —
without it the plugin reports itself as permanently outdated.

**Step 2 is not optional on a fresh install.** A profile that cannot resolve the plugin dies in
`composeProfile` — *before* the plugin is loaded — so no code inside the plugin can repair that
first launch. Do 2a and 2b by hand when you install (or when you add a second profile), and the
profile comes up.

**After that first successful launch the plugin maintains the mount itself.** From v1.6.0 it
re-runs `ensurePluginMount` at startup, after each plugin update and after each plugin rollback:
it creates or repairs the link in every profile and writes the declaration into every harness
profile, is idempotent, never overwrites a `link:`/`file:` spec you set deliberately, and never
deletes a directory it cannot prove is its own copy. So a later `dsh` upgrade, a new profile
(same machine), a dropped link or a changed version are all repaired without hand-editing again.
Read the state any time at `GET /dsh-update-checker/mount.json` (read-only); it is also carried in
`status.json` as `mount`. `POST /dsh-update-checker/mount` forces a re-check (needs
`{ "confirm": true }` + loopback, like every other write route).

Then let patch HMR apply it (or restart `dsh web`) and reload the page.

> Step-by-step guide with troubleshooting (中文): [docs/INSTALL.md](docs/INSTALL.md).

## Configuration & portability

All paths are **auto-detected at runtime — nothing is hardcoded**:

- **Plugin / profile dir** — derived from the plugin's own install location (`import.meta.url`).
- **`$DSH_HOME`** — the parent of the `profiles` root (state, backups, restart log live there).
- **Composition file** — the profile that is actually running wins: `$DSH_PROFILE_DIR/cordis.patch.yml` → `profiles/$DSH_PROFILE/…` → the profile whose patch names this plugin → `$DSH_HOME/profiles/web/cordis.patch.yml`. (v1.6.3; before that the `web` default was used whenever nothing proved otherwise, so a host serving another profile read the wrong `node_modules` — issue #31.)
- **Deployment root** — junction `realpath` first, then `DSH_DEPLOY_ROOT`, then `process.cwd()`, then the **npm global prefix** (parent of `npm root -g`'s output; v1.4.9+ covers `npm -g` installs).
  - systemd / `npm -g` escape hatch: if auto-detection ever misses your setup, set `DSH_DEPLOY_ROOT` to the directory that contains `node_modules/@deepseek-ai/dsh` (e.g. `<npm prefix>/lib` on Linux).
- **Node / npm executables** — `resolveNodeExe()` finds the real Node: `DSH_UC_NODE_EXE` override → `npm_node_execpath` → `process.execPath` when it is Node → common install dirs → `PATH`. This is what makes DSH Desktop (Electron, where `process.execPath` is `electron.exe`) able to run npm for plugin updates. If your Desktop build bundles Node elsewhere, set `DSH_UC_NODE_EXE` to it. If your Node is managed by **mise / asdf / nvm** and your `PATH` only exposes the version-manager **shim** (e.g. `~/.local/share/mise/shims/node`), the shim directory has no `npm` beside it; v1.4.22+ resolves the real binary by running `node -p process.execPath` through the shim. If that still fails (or you want to skip the lookup), set `DSH_UC_NODE_EXE` to the real binary, e.g. `mise which node` / `asdf which node`. v1.6.3 searches npm more widely: beside Node, in `node_modules_<major>` (Fedora/RHEL `nodejs24-npm`), `/usr/lib`, `/usr/local/lib`, `/opt/homebrew/lib`, `/usr/local/opt/npm/lib`, `$npm_config_prefix`, and through every `npm` / `npm.cmd` on `PATH` — including the real target behind a shim. A packaged desktop app that ships no npm at all still needs one installed (issue #32).
- **Restart launcher** — self-adapting: `DSH_UC_LAUNCHER` / `DSH_RESTART_LAUNCHER`, then common launcher names under the deployment root (`DeepSeek Harness.cmd`, `start-dsh.cmd`, …); the chosen launcher is spawned **with a visible window**, so the restarted server has a console (v1.6.3 — a hidden spawn left an orphan holding the port and swallowed the access URL). The web port is read from the running `webServer.port`.
- **Tuning env vars** — `DSH_UC_UPDATE_PORT` sets the port the update worker stops/starts/probes (default `3080`), and `DSH_UC_RESTART_WINDOW_MS` sets how long the worker keeps observing a slow first start before giving up (default `150000`; the progress record streams the whole time).

## Platform & install-layout support

- **Detection (checks)** — layout-agnostic, works on any machine.
- **One-click update & restart** — no longer Windows-only:
  - **Service stop/start probes** use `Get-NetTCPConnection` + `taskkill` on Windows and `ss -H -tlnp "sport = :<port>"` (fallback `lsof -tiTCP:<port> -sTCP:LISTEN`) + `SIGKILL` on Linux/macOS. The port is always named explicitly, so an unrelated listener can never be matched; on POSIX a PID is only killed when `/proc/<pid>/cmdline` is unreadable or names node/dsh.
  - **The POSIX restart watchdog** is `scripts/restart-watchdog.sh`, the counterpart of `scripts/restart-watchdog.ps1`. It takes the same environment variables — `DSH_RESTART_PORT`, `DSH_RESTART_PID`, `DSH_RESTART_NODE_FILE`, `DSH_RESTART_NODE_ARGS` (JSON array), `DSH_RESTART_LAUNCHER`, `DSH_RESTART_WORKDIR`, `DSH_RESTART_LOG`, `DSH_RESTART_RESULT` — and writes the same result JSON (`startedAt`, `port`, `pid`, `recovered`, `recoveredAt`, `attempts`, `error`). It relaunches via the node argv first, then `systemctl --user restart dsh-web.service`, then the launcher path passed as a single argument (a path containing spaces survives); if none of those exist it reports `no launcher available` instead of pretending to recover. It is invoked as `sh <script>`, so no executable bit is required.
  - Main-program update adapts: in-place `npm install` when the deploy root has a `package.json`, `npm install -g` otherwise; both run the dry-run guard and re-read the installed version afterwards.
  - Plugin updates — temp-dir install + copy, npm 11/12+ compatible.
- **When POSIX cannot be done safely**, `/update` still answers `501 E_PLATFORM_UNSUPPORTED`: the service process can only be identified reliably when `ss` or `lsof` is present. Install one of them (`iproute2`, `lsof`), or stop DSH and update manually.

## Notes

- **Host code changes require a service restart** (the loader caches imported modules); client changes are picked up by HMR and apply on the next page refresh.
- Update/rollback/restart/suppress/settings routes are guarded by `{ "confirm": true }` **and** a loopback-source check (127.0.0.1/::1).
- Before `npm install`, a backup (deployment `package.json` + `package-lock.json` + both @deepseek-ai version manifests + `backup-meta.json` + a `main-snapshot` copy of the `@deepseek-ai` framework tree) is written to `$DSH_HOME/dsh-update-checker-backups/<timestamp>/`; both main-program and plugin rollback routes are provided, and main-program rollback restores from the `main-snapshot` when present instead of re-installing from the registry.

## Changelog

- **v1.6.3** — a post-update restart you can see, package-count progress, and npm discovered off the beaten path (issues #30 #31 #32):
  - **No more console-less orphan after a core update.** `startService()` relaunched the server with `detached: true` + `stdio: "ignore"` + `windowsHide: true` — an invisible instance with no console. It outlives the update worker, keeps holding the web port, and the access URL/token printed at startup is discarded with its output; the next launch then dies with `listen EADDRINUSE 127.0.0.1:3080` and a wall of "N required plugins did not activate" (`webserver` is required, so the whole plugin graph fails to compose). The restart now prefers the deployment's own launcher (`DSH_UC_LAUNCHER` / `DSH_RESTART_LAUNCHER` / `DeepSeek Harness.cmd` / `start-dsh.cmd` / …) and spawns it **with a visible window**; with no launcher it falls back to `node … bin.js web`, also visible, and the choice is recorded as `main-update-service-restart` in the ops log.
  - **Progress is now "packages downloaded / total packages".** The bar no longer rides the dependency-tree creep or counts npm HTTP lines (which include metadata, so it ran ahead of reality). While packages are downloaded/installed the percent is `round(done / total * 100)` — 100 of 200 packages is 50%, 198 of 200 is 99% — with `已下载 137/273 个包（50%）` as the detail. The total comes from the npm dry-run ("added N packages") or the lockfile, and the tarball fallback counts downloaded tarballs the same way. The bar never rewinds, and 100% stays reserved for the finished state.
  - **npm is found on distro layouts and shimmed installs (#30 #32).** `npmCliCandidates()` also looks in `node_modules_<major>` (Fedora/RHEL `nodejs24-npm`), `/usr/lib`, `/usr/local/lib`, `/opt/homebrew/lib`, `/usr/local/opt/npm/lib` and `$npm_config_prefix`; `locateNpmCli()` resolves every `npm`/`npm.cmd` on `PATH` (and the real target behind a shim) before failing, and its `ENPMCLI` message now names the layouts it searched and the `DSH_UC_NODE_EXE` escape hatch. A packaged desktop app that ships **no** npm at all still cannot run plugin updates — that case needs Node/npm installed or an in-app tarball installer (tracked in #32).
  - **The plugin list is read from the profile that is actually running (#31).** `findCompositionFile()` defaulted to `profiles/web/cordis.patch.yml` whenever it could not prove otherwise, so on a host serving another profile (the desktop app's `desktop`) the panel read the *other* profile's `node_modules` — reporting `dshmarket 1.60.0 → 1.65.0` forever while the running profile already had 1.65.0. The composition and its `node_modules` now resolve from `DSH_PROFILE_DIR` / `DSH_PROFILE` first, still validated against this installation's profiles root.
  - **Tests**: 230 passing (`node --test "scripts/*.test.mjs"`), with new coverage for the package-count mapping, npm fetch parsing, launcher choice and visibility, running-profile resolution and the Fedora `node_modules_<major>` layout; the progress E2E timeline asserts the new contract.

- **v1.6.2** — one-click core updates on Linux/macOS, and plugin updates that survive a pnpm reify (issues #27 #28 #29, PR #26):
  - **POSIX core updates (#29, supersedes PR #19)**: the update worker, the service stop/start probes and the restart route no longer assume Windows PowerShell. The worker is spawned directly (`node <script>`, detached) with an `error` handler that releases the update lock and writes a real `error` progress record — a failed spawn used to be silent and left the banner stuck at 8%. Port discovery on POSIX uses `ss -H -tlnp "sport = :<port>"`, falls back to `lsof -tiTCP:<port> -sTCP:LISTEN`, and never scans every listener; a PID is killed only when `/proc/<pid>/cmdline` is unreadable or names node/dsh, and `SIGKILL` replaces `taskkill`. `scripts/restart-watchdog.sh` mirrors `restart-watchdog.ps1` (same environment variables, same result JSON) and relaunches through the node argv first, then `systemctl --user restart dsh-web.service`, then the launcher path as **one** argument. Windows is untouched (`Get-NetTCPConnection`, `taskkill /T /F`, the PowerShell `Start-Process` wrapper). The `501 E_PLATFORM_UNSUPPORTED` fail-fast is kept for hosts that have neither `ss` nor `lsof`.
  - **Peer-only plugins install again (#28)**: `buildStageInstallArgs`/`buildPluginInstallArgs` now pass `--legacy-peer-deps`. The staging prefix is a throwaway tree and the plugin's peers are supplied by the DSH host at runtime, so npm must not resolve them against the registry — there a `*` peer lands on a package that does not exist (`@deepseek-ai/dsh-compact`, `E404`) and every peer-only plugin died with `ERESOLVE`.
  - **`PROFILES_ROOT` understands per-profile `node_modules` (#27, PR #26)**: `dirname(profileNodeModules)` names the profiles directory only in the shared layout. For `…/profiles/<name>/node_modules` it resolved to the profile itself, so `findDeclaringProfiles()` found no manifest, the version was never written back to `package.json`, and the lockfile was never advanced (`persistedManifest:0`, and `persistedLock:true` was `[].every(...)`). The next `pnpm add`/`pnpm install` then reified the tree from that stale lockfile and rolled every previously updated plugin back to the frozen version. `pickProfilesRoot()` handles both layouts, and `pickDshHome()` follows it so a custom `DSH_HOME` is derived instead of falling back to `~/.dsh`.

- **v1.6.1** — hardening and honesty fixes on top of v1.6.0:
  - **`GET /mount.json` no longer writes.** It called `ensurePluginMount()` on a plain GET — creating
    junctions, `mkdir`s and rewriting `profiles/*/package.json` — with no `writeGate` and no loopback
    check, unlike every other mutating route. It is now read-only (returns the last report, `202`
    while the startup check is still running), and the re-check moved to `POST /mount` behind the same
    `{ "confirm": true }` + loopback gate as every other write route.
  - **The mount is re-verified after a plugin update and after a plugin rollback.** Previously it was
    only checked at startup, so a swapped-in plugin version left the mount unverified until the next
    `dsh` start. `finalizePluginInstall` and `rollbackPlugin` now re-run it and return the result as
    `mount` in their response payloads.
  - **A declaration in `devDependencies` is respected.** The declaration step read and wrote
    `dependencies` only, while the package's own `declaredSection` prefers `devDependencies` — so a
    profile declaring the plugin as a dev dependency got a second, duplicate entry. The section is now
    the profile's actual one, and the report names it (`section`).
  - **Harness-profile detection widened** from `pkg.dsh.profile` to `pkg.dsh`, so a valid manifest
    without that sub-object still receives its declaration instead of only a link (which would have
    left it reporting itself as permanently outdated).
  - **Docs state the real limitation.** The self-mount runs inside the plugin, i.e. only after a
    profile composed successfully — so it cannot repair the very first launch that fails to resolve
    the plugin. The manual link + declaration is **required for a fresh install** (and for each new
    profile); self-maintenance covers everything after that. Earlier wording implied a restart could
    heal the broken case, which is exactly the case it cannot.

## Development

- `lib/index.js` — Host half: plain ESM, Node built-ins only, no build step; pure helpers exported as named ESM exports for unit testing.
- `lib/client.js` — Client half: plain JS (`window.__ModuleLoader__`), requires only `react`, no build step.
- Tests: `npm test` (Node ≥ 20 built-in test runner, no third-party deps).
- `scripts/restart-service.ps1` — manual restart helper (run with `-ExecutionPolicy Bypass`).

## License

MIT
