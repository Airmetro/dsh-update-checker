# dsh-update-checker

English | [中文](README.zh.md)

A permanent Cordis plugin for the [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) Web GUI that **auto-checks for new DeepSeek Harness releases and installed third-party plugin updates** (the former standalone `dsh-plugin-checker` was merged in v1.1.0), asks the user, and one-click updates with success/failure feedback.

## Features

- **Full update lifecycle** — check, backup, update, **rollback**, and restart, all in one plugin.
- **Main program check** — compares the installed `@deepseek-ai/dsh` against the npm latest (full packument, **stable-first**, semver-aware). A pre-release target is installed only when it belongs to the channel the deployment already follows — a cross-channel promotion (`rc` → `alpha`) is refused with `E_PRERELEASE` unless you enable the `allowPrerelease` setting, so the checker never promotes the harness into an unintended pre-release channel.
- **Third-party plugin check** — scans installed non-official plugins (layout-agnostic, incl. pnpm-hoisted `node_modules`), cross-compares each against **npm + GitHub** (target = higher version); local tools with no publish source go to `ignored`. When a plugin name has multiple copies, the one in the **composition-owning profile's `node_modules`** wins (the rest are listed as `copies`), and each plugin can be excluded from prompts (`excludedPlugins`, re-enableable in the settings page).
- **Working GitHub channel** — dedicated HTTPS client for GitHub domains (tolerates self-signed local proxies; the npm registry still uses strict TLS), with redirects, size caps and timeouts; codeload tarballs are validated before install.
- **In-GUI banner** — locale-aware (zh/en follows the DSH UI language), states update / up-to-date / failure, with a suppression flag and a **change brief** (vX→vY + risk level + release notes when available).
- **One-click update with safety** — main program: dry-run guard (aborts when the plan would remove a package the deployment itself declares; npm reclaiming the update target's own transitive dependencies is recognised and allowed, and `allowRemove` overrides it explicitly) → snapshot backup (version manifests + a `main-snapshot` copy of the `@deepseek-ai` tree for offline rollback) → layout-adaptive install (in-place or `-g`) → post-install check `installed==latest`; plugins: temp-dir install + copy, dependency version reconciliation, auto `--allow-scripts` for native deps on npm ≥ 12, a **downgrade guard** (a rate-limited GitHub probe can no longer make the installer fall back to an older npm release) and a rename-free **in-place sync** for plugins whose directory the running host keeps pinned. **Updates (and rollbacks) persist to the profile `package.json` + lockfile** (`pnpm install --lockfile-only` / `npm install --package-lock-only`), so a later install never silently reverts the plugin — no more "same plugin keeps asking for the same update" loops.
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

## Desktop (Electron) support

The plugin decides at runtime whether it is hosted by `dsh web` (plain Node) or by the Desktop application (Electron, `ELECTRON_RUN_AS_NODE=1`), and reports the result as `platform` plus a `runtime` block in `/dsh-update-checker/status.json` and `/dsh-update-checker/plugins.json`:

- **Detection** — Electron runtime (`process.versions.electron`), the Desktop host entry (`…/dsh-desktop-host/lib/index.js` in `process.argv`), `process.resourcesPath` and a packaged `app-update.yml`. `DSH_UC_FORCE_PLATFORM=desktop|web` overrides it; `DSH_UC_RESOURCES_DIR`, `DSH_UC_RUNTIME_DIR`, `DSH_UC_APP_VERSION` and `DSH_UC_FEED_URL` exist for tests and unusual layouts.
- **Version check** — Desktop carries its runtime inside the signed bundle (`resources/app.asar`), so *installed* comes from `app.asar/package.json` (fallback `app.asar/dsh/package.json`) and *latest* comes from the very feed Electron uses: `app-update.yml` (`provider` / `url` / `channel`, `nightly` here) → `<url>/<channel>.yml` (`version`, `releaseDate`, installer URL and sha512). The npm registry is not consulted for the core on Desktop.
- **One-click update** — Desktop installs its own release (download → task check → install → restart), so the banner offers **Open update window**, which calls `window.dshDesktop.updates.open()` (the preload bridge exposed to `dsh-app://app` documents) and mirrors Electron's own update state (`downloading` / `verifying` / `ready` / `installing`) through `updates.subscribe()`. `POST /dsh-update-checker/update` answers `409 E_DESKTOP_OWNED` with `action: "open-native-update"` and writes **no** progress or lock record: the plugin never npm-installs into `app.asar`. The web path (npm / tarball, backup, rollback, restart watchdog) is unchanged.
- **Rollback** — `409 E_DESKTOP_OWNED`: the bundled runtime has no plugin-owned backup to restore; reinstall the matching Desktop release from the official feed instead.
- **Restart** — `409 E_DESKTOP_RESTART_MANUAL` plus a localized guide. Electron owns the profile and the Host process, so the plugin does not kill it; after a plugin update, quit from the tray menu (“Quit DeepSeek Harness”) and reopen the application.
- **Plugin updates** — behavior is unchanged and they target the running profile (`profiles/desktop`). On Desktop the bundled pnpm is preferred for lockfile sync (`resources/runtime/pnpm/bin/pnpm.mjs`, launched as `Electron --expose-internals …` with `ELECTRON_RUN_AS_NODE=1` and the bundled `runtime/bin` on `PATH`), and when the machine ships no npm at all the staging install falls back to that bundled pnpm (`pnpm add <spec> --dir <tmp>` / `pnpm install --dir <root> --prod`, build scripts via `pnpm rebuild`) instead of failing. `DSH_UC_NODE_EXE` still overrides the Node used for npm.
- **Settings panel** — on Desktop it shows the runtime source, channel and feed, hides the npm-only controls (pre-release switch, download source) and explains that the core updates itself.

## Notes

- **Host code changes require a service restart** (the loader caches imported modules); client changes are picked up by HMR and apply on the next page refresh.
- Update/rollback/restart/suppress/settings routes are guarded by `{ "confirm": true }` **and** a loopback-source check (127.0.0.1/::1).
- Before `npm install`, a backup (deployment `package.json` + `package-lock.json` + both @deepseek-ai version manifests + `backup-meta.json` + a `main-snapshot` copy of the `@deepseek-ai` framework tree) is written to `$DSH_HOME/dsh-update-checker-backups/<timestamp>/`; both main-program and plugin rollback routes are provided, and main-program rollback restores from the `main-snapshot` when present instead of re-installing from the registry.

## Changelog

- **v1.7.1** — the checker now knows which host it runs on, and adapts to the Desktop (Electron) application while keeping the web behavior:
  - **Runtime platform detection.** `detectDesktopRuntime()` classifies the host from the Electron runtime, the `dsh-desktop-host` entry in `process.argv`, `process.resourcesPath` and a packaged `app-update.yml`, and every status response now carries `platform` plus a `runtime` block (`managedBy`, Electron version, app root, resources/runtime dirs, update source availability, channel, feed); `DSH_UC_FORCE_PLATFORM` overrides it for tests.
  - **The core version on Desktop comes from the application's own update feed.** Installed = the packaged app version (`app.asar/package.json`, fallback `app.asar/dsh/package.json`); latest = `<url>/<channel>.yml` resolved from `app-update.yml` (generic provider, `nightly`), parsed with a dependency-free reader that handles the folded-scalar `url: >-` blocks the feed uses. On web nothing changed: npm/GitHub remain the source, and the previously broken `installed: null` on Desktop is gone.
  - **Desktop updates are delegated, never performed.** `POST /update` on Desktop answers `409 E_DESKTOP_OWNED` with `action: "open-native-update"`, the target version and channel, and writes neither the update lock nor a progress record — the plugin cannot and must not npm-install into the signed `app.asar`. `/rollback` answers `409` for the same reason (no plugin-owned backup of a bundled runtime).
  - **Desktop restart is manual, by design.** `/restart` answers `409 E_DESKTOP_RESTART_MANUAL` with a guide instead of killing the Host that Electron supervises (tray menu → “Quit DeepSeek Harness” → reopen); the settings panel shows the same guide where the web build shows “Restart service”.
  - **Desktop package manager.** Lockfile sync prefers the bundled pnpm (`argv[5]` of the Desktop host, run through `Electron --expose-internals` with `ELECTRON_RUN_AS_NODE=1`, `DSH_DESKTOP_NODE_EXECUTABLE` and the bundled `runtime/bin` on `PATH`), falling back to a discovered pnpm if that invocation fails; npm keeps its existing resolution, and on Desktop the Electron executable is used as the Node for it when no real Node exists. Plugin staging installs still use npm when it is available and fall back to the bundled pnpm (`pnpm add --dir` / `pnpm install --dir --prod`, `pnpm rebuild` for build scripts) when it is not.
  - **Client awareness.** The overlay detects the `dsh-app://` origin and `window.dshDesktop.updates`, renders **Open update window** as the primary action on Desktop (never the npm install button), subscribes to Electron's update state to show download/verify/install progress in the banner, and keeps the npm confirm/update flow untouched on web. The settings section reports the Desktop runtime, channel and feed, hides the pre-release switch and download-source selector, and plugin-update results say “takes effect after restarting the desktop app”.
  - **A mount can no longer downgrade a real installation.** `ensurePluginMount()` converts the plugin copy found in each profile into a link to the install it is running from. It did that for real directories unconditionally, so a profile holding a newer real copy (1.7.0) was silently replaced by a link to an older shared copy (1.4.23). `linkPackageIntoProfile()` now compares versions before replacing a real directory and refuses when the destination is newer (`conflict: "downgrade"`, reported in the mount errors, nothing written to disk); equal or newer sources are deduplicated exactly as before.
  - **Tests**: 293 passing (`node --test "scripts/*.test.mjs"`), with `scripts/unit-desktop-runtime.test.mjs` (detection across web/Electron/argv/override cases, `app-update.yml` and feed parsing of the real payload shapes, feed-URL joining, pnpm staging args), `scripts/integration-desktop-host.test.mjs` (real route handlers against a local HTTP feed: Desktop status/versions, `E_DESKTOP_OWNED` with no lock/progress file, the restart guide, rollback refusal, `plugins.json` platform), `scripts/integration-client-desktop.test.mjs` (the actual overlay component rendered through the module loader with a fake React: Desktop renders the native action, a `downloading` state renders 42 % progress, web still posts to `/update`) and `scripts/integration-mount-guard.test.mjs` (older source vs newer real copy is refused, newer source still deduplicates, a pre-release destination counts as newer). `scripts/test-client-apply.mjs` carried a stale worker-milestone assertion that already failed on untouched 1.7.0; it now checks that the worker's milestone percentages are non-decreasing.

  - **Verified on a real installation** — the build was driven inside the genuine Electron-as-node process (`DeepSeek Harness.exe` 44.0.0, the installed app's `resources`) against a mirror profile: 24/24 checks passed, including `installed = 0.2.0-rc.2` read from the signed `app.asar`, `latest = 0.2.0-rc.2` fetched live from `https://download.deepseek.com/dsh-desk/feeds/win-x64/nightly.yml`, `channel = nightly`, `/update` → `409 E_DESKTOP_OWNED` with no update lock, progress record or backup directory written, `/restart` → `409 E_DESKTOP_RESTART_MANUAL` with the guide, and `/rollback` → `409`. The same build in a plain Node process reported `platform: web`, `source: npm` and still took its normal npm/deploy-tree path (9/9 checks).

- **v1.7.0** — four Windows update failures reported against 1.6.4, fixed where they start (issues #34 #35 #36 #37):
  - **A plugin that ships `skills/` can be updated while DSH is running (#37).** `swapDirectoryInPlace()` replaced a plugin with `rename(dst → trash)`, and Windows refuses to rename a directory while **any** handle exists anywhere in its subtree — which is exactly what the running host creates for `<plugin>/skills`, so every such update died with a bare `EPERM` and no retry could ever succeed. The swap now recognises that refusal (`EPERM`/`EACCES`, as opposed to the transient `EBUSY` a lock retry can outlast) and falls back to an **in-place file-level sync**: staged files are copied over the destination, entries the new version dropped are removed, the watched directory itself is never renamed or deleted, and anything that could not be cleaned up is reported as a leftover instead of failing the update. The rename path is untouched whenever no handle blocks it, and a failure of the fallback restores the plugin from the backup taken before the swap and says why (host-held skills directory → close DSH and update from the CLI). The result and the ops log now carry `installMode` (`swap` / `in-place`) and the leftover count.
  - **A rate-limited GitHub probe can no longer downgrade a plugin (#35).** With the profile declaring `github:…` and the GitHub probe answering `403`, `pickTargetSource()` fell back to npm — even when npm's latest was **older** than what was installed (`@sunjuntao/dsh-prompt-library` 0.16.1 → 0.15.0) — and because the manifest could not be rewritten for a GitHub spec, the installed tree and the declaration drifted apart. `updatePlugin()` now compares the version it is about to install against the installed one and refuses a downgrade with `ENODOWNGRADE`, naming both versions and carrying the probe failure (`ghError`) into the ops log, the response `detail` and the panel error; the GitHub→npm fallback applies the same test, so a failed GitHub download cannot land an older npm build either. Equal versions still reinstall (the repair path), and npm-sourced installs of a GitHub-declared plugin are flagged with a `persistWarning` instead of silently rewriting the declaration.
  - **The post-update restart keeps its diagnostics and no longer kills a slow start (#36).** The watchdog relaunched through `Start-Process` with **no redirection** while itself being spawned with `stdio: "ignore"`, so three failed attempts left nothing to look at; and each 30 s round killed whatever port owner it found — a first start that needs longer (profile projection, plugin mounts, MCP children) was killed mid-boot and restarted, a self-locking loop. Relaunches now redirect stdout/stderr to `dsh-update-checker-relaunch.out.log` / `.err.log`, log the exact command line, working directory and the DSH/NPM environment, and record the child PID; the wait loop never kills a process — it relaunches only when the instance it started has **exited** (with the exit count and the captured output tail in the result) — and the verdict is reported in stages: `recoveredBy: "plugin"` for a 2xx from `/dsh-update-checker/status.json`, `recoveredBy: "port"` (plus a note) when the port listens and the HTTP layer answers but the plugin route is not up yet. Windows default 420 s with a 45 s mount grace, tunable via `DSH_RESTART_WAIT_SEC` / `DSH_RESTART_MAX_WAIT_SEC` / `DSH_RESTART_MOUNT_GRACE_SEC`; `restart-watchdog.sh` follows the same policy.
  - **The main-program dry-run gate no longer mistakes npm's own cleanup for a dangerous plan (#34).** The guard aborted on any `removed N packages`, so a `npm i -g` upgrade that reclaims the old version's transitive dependencies (`@smithy/*`, `@aws-crypto/*`, …) was blocked before it ran, and the error quoted the truncated dry-run text — registry chatter instead of the packages it was protecting. The dry-run output is now parsed for the removed **names** (`remove <name> <version>`), a removal is allowed when none of them is declared by the deployment's own `package.json` (`dependencies` / `devDependencies` / `optionalDependencies` / `peerDependencies`), and it is refused — with every removed package listed, the declared offenders called out, and the `allowRemove` override spelled out — only when the plan would take something the deployment actually asked for. `POST /update {"dry":true}` returns the classification as `removals`, `POST /update {"allowRemove":true}` (and `{"dry":true,"allowRemove":true}`) overrides it, the worker logs the same list, and rollback passes `allowRemove` because returning to an older version necessarily removes the newer one's packages.
  - **Result files are BOM-free.** The watchdog wrote `restart-result.json` with `Out-File -Encoding utf8`, which PowerShell 5.1 encodes as UTF-8 **with** a BOM — `JSON.parse` then threw and `GET /dsh-update-checker/restart-status.json` answered `404 no restart recorded yet` no matter how the restart went. Both the result and the log are now written through `[System.IO.File]::WriteAllText/AppendAllText` with a BOM-less encoder, and the route strips a leading BOM anyway, so an old result file stays readable.
  - **Tests**: 271 passing (`node --test "scripts/*.test.mjs"`), with new suites `scripts/unit-inplace-sync.test.mjs` (in-place sync semantics plus two real Windows reproductions: an open file handle and an `opendir` watcher handle on a subdirectory both make `rename` fail with `EPERM`, after which the swap falls back and the pinned directory survives), `scripts/unit-dryrun-remove.test.mjs` (parse/count/classify, the reporter's 11-package global install, the declared-package refusal, the override and the "npm gave a count but no names" conservative case), `scripts/unit-plugin-downgrade.test.mjs` (the reporter's exact 0.16.1 → 0.15.0 probe, equal/newer versions, pre-release comparison) and `scripts/unit-restart-watchdog.test.mjs` (redirection, no kill inside the wait loop, staged verdict, configurable windows, BOM-free writes for both scripts). Verified end to end on this machine: the real watchdog was driven against a fake service in four scenarios (ready → `plugin`; 8 s slow start → recovered without being killed; 401-only route → `port` with a note; immediate crash ×3 → failure with the crash message in `outputTail`), and the dry-run gate was run against the real npm/registry (`node-fetch@2.7.0 → 3.3.2`: 1.6.4 aborts with `EDRYREMOVE` and quotes unrelated output, 1.7.0 passes and names `whatwg-url@5.0.0, webidl-conversions@3.0.1, tr46@0.0.3`; the abort path and `allowRemove` were exercised on that same real output).

- **v1.6.4** — the tarball fallback installs what a release adds, and the integrity check proves it (issue #33):
  - **A weak network no longer silently drops the new dependencies (#33).** When the npm dry-run gate times out, a core update falls back to `installVia=tarball`, whose work list came from `collectUpdateTodo()` — a `readdir()` of the local `@deepseek-ai` tree. A package the new release *adds* has no local directory, so it could never be listed, and third-party scopes were never enumerated at all: the 0.1.7-rc.1 → 0.1.7-rc.2 update applied 267 of the 585 packages in the lockfile, left `dsh-client-shortcuts`, `dsh-client-ui-shortcuts`, `dsh-experimental-auto-review`, `dsh-llm-deepseek-account`, `dsh-llm-deepseek-api-key`, `dsh-util-code-language`, `@js-temporal/polyfill` and `jsbi` uninstalled, and still reported `main-update-ok` — port 3080 answered while the plugin/frontend imports failed. The worker now walks the **target version's dependency closure** from the registry (`resolveTargetClosure()`, reusing the existing `satisfies()` / `compareVersions()` helpers) and plans only what the deployment cannot already resolve: missing packages, plus `@deepseek-ai/*` packages whose resolved version differs. Anything already satisfying its range is left exactly as it is, so npm's nested duplicates (`debug@2` under a `^4` dependent, …) are never flattened; platform-incompatible optional dependencies (73 on the reporting machine) and third-party packages that would need an install script are skipped and reported. Extracted packages land in `node_modules/<name>` (a new `@scope/` directory is created when needed), and the plan, skips and failures are written to the ops log (`main-tarball-plan-ok` / `-incomplete`, `main-tarball-metadata-failed`, `main-tarball-plan-conflict`).
  - **Completeness is now part of the integrity check (#33).** `verifyTree()` only walked the directories that existed, so an uninstalled package could not fail it — that is why the partial install above rolled forward as a success. It now checks the resolved closure as well: a missing or wrong-version package is an integrity problem and the update rolls back, turning a silent half-broken deployment into an honest failure. When the registry cannot be reached the closure is reported `incomplete` and the previous local-only behavior is kept, so the fallback is never worse than before.
  - **Downloads keep their timeouts.** `httpGetBuffer()` aborts on a 20 s idle gap or the per-attempt cap, retries three times with escalating 60/90/180 s caps, and never reuses a socket — the long keep-alive connection to the registry was observed degrading until a single package needed 10–20 minutes.
  - **Tests**: 244 passing (`node --test "scripts/*.test.mjs"`), including `scripts/integration-tarball-closure.test.mjs` (a mock registry covering added, transitive and `@scope` packages, strict-context upgrades, platform and build-script skips, registry-unreachable fallback, and an integrity case that must fail when a package is removed) and `scripts/unit-tarball-timeout.test.mjs` (idle/attempt timeouts, size cap, HTTP status, no keep-alive reuse, bounded download pool). Verified against the real registry on a tree with exactly those 8 packages removed: the plan selected exactly those 8, all 12 downloads extracted with the expected versions, and `verifyTree()` reported 0 problems.


## Development

- `lib/index.js` — Host half: plain ESM, Node built-ins only, no build step; pure helpers exported as named ESM exports for unit testing.
- `lib/client.js` — Client half: plain JS (`window.__ModuleLoader__`), requires only `react`, no build step.
- Tests: `npm test` (Node ≥ 20 built-in test runner, no third-party deps).
- `scripts/restart-service.ps1` — manual restart helper (run with `-ExecutionPolicy Bypass`).

## License

MIT
