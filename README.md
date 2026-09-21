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

- **v1.6.0** — the plugin mounts itself, so `dsh` `0.1.6-alpha.2` stops failing to load it:
  - **Root cause**: `0.1.6-alpha.2` changed the profile resolution default from
    `options.resolutionMode ?? "link"` to `?? "runtime"`. `PluginPackages` then receives
    `{ generation, behavior: "enforce" }` instead of `{}`, and `routeScoped` registers
    `$DSH_HOME/profiles/node_modules` as a *shared managed* directory that it `break`s out of
    rather than searching. That directory can now only serve the entries in the resolution
    generation — the deployment dependency closure and the selected bundle closure — and a
    third-party plugin is in neither, so the lookup falls through to `after-fallback` with
    `$DSH_HOME/package.json` as the base and dies at `ERR_MODULE_NOT_FOUND`, **before the web
    server binds**. dsh rewrites the importer path in that error to point at the profile
    directory, so it reads as "the package next door cannot be found".
  - **Fix — the plugin now ensures its own mount** (`ensurePluginMount`, run at startup and
    exposed at `GET /dsh-update-checker/mount.json`, with the result also carried in
    `status.json` as `mount`): for every profile it creates/repairs
    `profiles/<profile>/node_modules/dsh-update-checker` as a **junction** to the real package in
    `profiles/node_modules`, and writes the `dependencies` declaration into every harness
    profile. Both halves are needed: the link is what makes `routeScoped` find a candidate
    *before* the shared directory (the documented "pnpm-managed entries in the profile's
    `node_modules` resolve first"), and the declaration is what `readProfilePlugins` and this
    plugin's own `findDeclaringProfiles`/`persistPluginUpdate` use to decide ownership —
    without it the plugin reports itself as permanently outdated. A junction, never a copy: a
    copy would put `import.meta.url` under `profiles/<profile>/node_modules`, where
    `pickDshHome` no longer recognises the Harness home, drifting the plugin's self-location
    and its `@deepseek-ai/*` sync target. Correct under `"link"` mode too — no route hook is
    installed there and native resolution reaches the same link — so this is not a
    version-conditional hack.
  - **Safe by construction**: idempotent; an existing declaration is never overwritten (a
    `file:`/`link:` spec you set deliberately is preserved and reported as `foreignDecl`); a
    real directory is reclaimed only when its `package.json` `name` proves it is this plugin's
    own copy; anything else is reported as `refusing to replace` and left untouched; writes go
    to harness profiles only, and a plugin installed outside `profiles/node_modules` (npm `-g`,
    deployment root) skips cleanly.
  - **`runSync` no longer leaves real directories in the profile**: the main-program sync in
    `lib/index.js` still called `cp(src, dst, { recursive: true, force: true })` for the
    `@deepseek-ai/*` framework tree, the same write path v1.5.0 fixed in the update worker —
    and the same one that makes `healProfilesModuleFallback`/`ensureSymlink` throw
    `exists and is not a symlink or dsh-managed module proxy` at the next launch. It now
    creates a junction (Windows) / directory symlink (POSIX) through the same
    verified-reclaim logic, so the two sync paths can no longer disagree.
  - **Regression tests**: `scripts/integration-plugin-mount.test.mjs` drives the real exported
    functions against a temporary Harness home and covers ten scenarios — a missing link is
    created (and its real path stays under `profiles/node_modules`), a leftover real copy is
    reclaimed, a correct link is left byte-identical, a same-named foreign directory is never
    deleted, a dangling link is rebuilt, an existing/foreign declaration is preserved, a
    non-harness profile gets a link but no declaration, an out-of-tree install is a no-op, and
    `runSync` writes links while still refusing to replace foreign packages.

- **v1.5.0** — `syncProfilesToDeploy` links instead of copying (fixes the crash that followed a main-program update):
  - **Root cause**: the function's name and its `junctionSkipped` log field promised linking, but the write path never created a link — it called `cp(src, dst, { recursive: true, force: true })`. Entries already present and resolving to the same real path were skipped (228 of 236 on a real host), while packages **not yet present in the profile** — the 8 new ones a `0.1.6-alpha.1` update brings — were copied as **real directories** into `$DSH_HOME/profiles/node_modules/@deepseek-ai/`.
  - **Why that is fatal**: dsh's `healProfilesModuleFallback`/`ensureSymlink` only takes over symbolic links or dsh-managed module proxies. A real directory makes it throw `dsh: <path> exists and is not a symlink or dsh-managed module proxy; remove it so dsh can manage the installation fallback` during `composeProfile` — **before the web server binds** — so the next launch dies outright, while the update itself reported success (`main-profile-sync total:236 junctionSkipped:228 failed:[]`).
  - **Fix**: the write path is now `mkdir` + `symlink(src, dst, process.platform === "win32" ? "junction" : "dir")`, so the profile keeps pointing at the single deployed copy — exactly what `healProfilesModuleFallback` expects.
  - **Self-healing**: a destination that exists but is not the deploy copy is reclaimed safely — a symbolic link (including a dangling one) is rebuilt, and a real directory is replaced only after its `package.json` `name` matches the deploy package. Anything else is left untouched and reported as a failure (`refusing to replace`) instead of being overwritten, which also closes a second, previously unreported hazard: `fs.cp(..., { force: true })` does not reject a same-named directory from another source — it overwrites that package's files and leaves the rest behind, silently gutting it.
  - **Regression test**: `scripts/integration-sync-profiles.test.mjs` extracts `syncProfilesToDeploy` from the real worker source (so the test cannot drift from the implementation) and covers six scenarios — a new package becomes a link, a leftover real copy is reclaimed, a same-named foreign directory is never deleted, a dangling link is rebuilt, non-`dsh` packages are ignored, and an unreadable deploy tree exits safely. The suite fails 4/6 against the 1.4.23 worker and passes 6/6 against this one.
  - **The post-install health check now proves a new dsh process is serving**: it used to accept any answer on the port — `GET /` → 200 swept assets, while 401/403/407 were declared success outright — so a build that died in `composeProfile` (no server at all) was still reported as a successful update. The host now hands its own `instanceId` to the worker, which reads the id back from this plugin's own routes (`update-progress.json`, then `status.json`; both answer without a browser session): a *different* id means the updated build really came up, the *same* id means the instance from before the restart is still the one answering and the update is reported as **failed**. When the probe cannot decide — this plugin not composed, a route not answering yet, or an older host that passed no id — the previous behaviour is kept rather than failing a healthy update.
  - **The prerelease gate is channel-aware, instead of asking whether a stable version exists**: the old test was `isPrerelease(target) && !allowPrerelease && hasStable`, and `hasStable` meant "npm holds some non-prerelease version". Every published `@deepseek-ai/dsh` is an rc/alpha, so `hasStable` was always false and the gate never fired: an `allowPrerelease: false` deployment was promoted `rc` → `alpha` anyway. The gate now compares release channels (`alpha`/`beta`/`rc`/stable) — a same-channel upgrade stays allowed, a cross-channel promotion is refused with `E_PRERELEASE` and a message naming the `allowPrerelease` setting, and missing data fails open.
  - **State, backups and logs follow `DSH_HOME`**: the home was derived only from where this package happens to sit, so an install outside a `…/profiles/node_modules` tree wrote its state next to the program files. A layout that really is a Harness home still wins (which keeps `DSH_UC_PROFILE_NODE_MODULES` overrides and the test suite's isolation working); anything else falls back to `DSH_HOME`, then `~/.dsh`.
  - **Recovery for machines already hit by this bug**: move (do not delete) the real directories under `$DSH_HOME/profiles/node_modules/@deepseek-ai/`; the next `dsh` launch rebuilds them as junctions automatically.

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

## Development

- `lib/index.js` — Host half: plain ESM, Node built-ins only, no build step; pure helpers exported as named ESM exports for unit testing.
- `lib/client.js` — Client half: plain JS (`window.__ModuleLoader__`), requires only `react`, no build step.
- Tests: `npm test` (Node ≥ 20 built-in test runner, no third-party deps).
- `scripts/restart-service.ps1` — manual restart helper (run with `-ExecutionPolicy Bypass`).

## License

MIT
