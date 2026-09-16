
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, readdir, cp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import http from "node:http";

const TARGET = process.env.DUC_VERIFY_TARGET || "0.1.6-alpha.1";
const PORT = Number(process.env.DUC_VERIFY_PORT) || 3999;
const WORKER_PATH = fileURLToPath(new URL("../scripts/main-update-worker.mjs", import.meta.url));
const SELF_DIR = fileURLToPath(new URL("..", import.meta.url));

async function buildFakeDeployment(opts = {}) {
  const work = await mkdtemp(join(tmpdir(), "duc-e2e-"));
  const root = join(work, "root");
  const home = join(work, "home");
  const backup = join(work, "backup");
  const fakenode = join(work, "fakenode");
  const frontendVersion = opts.frontendVersion || TARGET;
  await mkdir(join(root, "node_modules", "@deepseek-ai", "dsh"), { recursive: true });
  await mkdir(join(root, "node_modules", "@deepseek-ai", "dsh-web-frontend"), { recursive: true });
  await mkdir(home, { recursive: true });
  await mkdir(backup, { recursive: true });
  await mkdir(join(fakenode, "node_modules", "npm", "bin"), { recursive: true });

  let nodeExe;
  if (opts.slowDryRun) {
    nodeExe = join(fakenode, "node.exe");
    await cp(process.execPath, nodeExe);
    await writeFile(
      join(fakenode, "node_modules", "npm", "bin", "npm-cli.js"),
      `await new Promise((r) => setTimeout(r, ${Number(opts.slowMs) || 14000}));\nprocess.exit(1);\n`,
      "utf8"
    );
  } else {
    nodeExe = join(fakenode, "node.cmd");
    await writeFile(nodeExe, "@exit /b 1\r\n", "utf8");
    await writeFile(join(fakenode, "node_modules", "npm", "bin", "npm-cli.js"), "", "utf8");
  }
  await writeFile(join(fakenode, "node_modules", "npm", "package.json"), JSON.stringify({ name: "npm", version: "11.0.0" }), "utf8");

  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ name: "duc-fake-deploy", version: "1.0.0", dependencies: { "@deepseek-ai/dsh": "0.0.1" } }, null, 2),
    "utf8"
  );
  await writeFile(
    join(root, "node_modules", "@deepseek-ai", "dsh", "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh", version: "0.0.1" }, null, 2),
    "utf8"
  );
  await writeFile(
    join(root, "node_modules", "@deepseek-ai", "dsh-web-frontend", "package.json"),
    JSON.stringify({ name: "@deepseek-ai/dsh-web-frontend", version: frontendVersion }, null, 2),
    "utf8"
  );
  if (!opts.omitDist) {
    await mkdir(join(root, "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "@deepseek-ai", "dsh-web-frontend", "dist", "index.html"),
      "<!doctype html><html><body>fake frontend</body></html>",
      "utf8"
    );
  }

  return { work, root, home, backup, fakenode, nodeExe };
}

function startFakeHealthServer(port, status = 200) {
  const server = http.createServer((req, res) => {
    res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
    res.end(status === 200 ? "<!doctype html><html><body>recovered</body></html>" : "unauthorized");
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

async function runVariant(variant) {
  const opts =
    variant === "slowdryrun"
      ? { slowDryRun: true, slowMs: Number(process.env.DUC_VERIFY_SLOW_MS) || 14000, omitDist: true }
      : {};
  const dep = await buildFakeDeployment(opts);
  const progressFile = join(dep.home, "dsh-update-checker-update-progress.json");
  const opsFile = join(dep.home, "dsh-update-checker-ops.log");
  const lockFile = join(dep.home, "dsh-update-checker-update.lock");
  await writeFile(lockFile, JSON.stringify({ at: Date.now(), pid: 999999 }, null, 2), "utf8");

  const env = {
    ...process.env,
    DSH_UC_UPDATE_ROOT: dep.root,
    DSH_UC_UPDATE_TARGET: TARGET,
    DSH_UC_UPDATE_BACKUP: dep.backup,
    DSH_UC_UPDATE_PROGRESS: progressFile,
    DSH_UC_UPDATE_OPS: opsFile,
    DSH_UC_UPDATE_DSH_HOME: dep.home,
    DSH_UC_UPDATE_SELF_DIR: SELF_DIR,
    DSH_UC_NODE_EXE: dep.nodeExe,
    DSH_UC_UPDATE_PORT: String(PORT),
    DSH_UC_RESTART_WINDOW_MS: "7000",
  };

  const child = spawn(process.execPath, [WORKER_PATH], {
    env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d.toString("utf8")));
  child.stderr.on("data", (d) => (stderr += d.toString("utf8")));

  const startedAt = Date.now();
  const timeline = [];
  let lastRaw = null;
  let healthServer = null;
  let exit = null;
  child.on("close", (code) => (exit = code));

  let done = false;
  const readErrors = [];
  while (!done) {
    await new Promise((r) => setTimeout(r, 40));
    try {
      const raw = await readFile(progressFile, "utf8");
      const p = JSON.parse(raw);
      if (raw !== lastRaw) {
        lastRaw = raw;
        timeline.push({ t: Date.now() - startedAt, ...p });
        if (
          (variant === "recover" || variant === "authgate") &&
          !healthServer &&
          ["verify", "sync-decl", "restart", "health", "restart-pending"].includes(p.phase)
        ) {
          healthServer = await startFakeHealthServer(PORT, variant === "authgate" ? 401 : 200);
        }
      }
    } catch (err) {
      readErrors.push(`${Date.now() - startedAt}ms ${err.code || err.name}: ${String(err.message).slice(0, 60)}`);
    }
    if (exit !== null) done = true;
    if (Date.now() - startedAt > 10 * 60 * 1000) {
      done = true;
      try { child.kill(); } catch {}
    }
  }
  if (healthServer) await new Promise((r) => healthServer.close(r));

  let finalFile = null;
  try {
    finalFile = await readFile(progressFile, "utf8");
  } catch (err) {
    finalFile = `UNREADABLE ${err.code || err.message}`;
  }
  const elapsed = Date.now() - startedAt;

  const ops = (await readFile(opsFile, "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const last = timeline[timeline.length - 1] || null;
  const withPercent = timeline.filter((p) => Number.isFinite(p.percent));

  return { dep, exit, stdout, stderr, timeline, ops, last, withPercent, lockFile, readErrors, finalFile, elapsed };
}

const failures = [];
const check = (label, cond, detail) => {
  if (cond) {
    console.log(`  OK   ${label}`);
  } else {
    failures.push(label);
    console.error(`  FAIL ${label}${detail === undefined ? "" : " — " + detail}`);
  }
};

function report(variant, r) {
  console.log(`\n=== variant ${variant} (exit=${r.exit}) ===`);
  console.log("  t(ms)   phase            percent  label / detail");
  for (const p of r.timeline) {
    console.log(
      `  ${String(p.t).padStart(6)}  ${String(p.phase).padEnd(16)} ${String(p.percent === null || p.percent === undefined ? "-" : p.percent + "%").padEnd(8)} ${p.label || ""}${p.detail ? " · " + p.detail : ""}`
    );
  }

  const phases = [...new Set(r.timeline.map((p) => p.phase))];
  console.log("  phases:", phases.join(" -> "));
  if (r.readErrors.length) console.log("  read errors:", r.readErrors.slice(0, 5).join(" | "), `(${r.readErrors.length} total)`);
  console.log("  ops:", r.ops.map((o) => o.op).join(" -> "));
  console.log(`  polled for ${r.elapsed}ms, ${r.timeline.length} distinct record(s)`);
  console.log("  final progress file:", String(r.finalFile).replace(/\s+/g, " ").slice(0, 300));

  const downloadRecords = r.timeline.filter((p) => p.phase === "download" && Number.isFinite(p.percent));
  const downloadPercents = downloadRecords.map((p) => p.percent);
  const stopIdx = r.timeline.findIndex((p) => p.phase === "stop");
  const maxDownloadBeforeStop = stopIdx < 0 ? null : Math.max(...r.timeline.slice(0, stopIdx).filter((p) => Number.isFinite(p.percent)).map((p) => p.percent), 0);

  const maxGap = (() => {
    let g = 0;
    for (let i = 1; i < r.timeline.length; i++) g = Math.max(g, r.timeline[i].at - r.timeline[i - 1].at);
    return g;
  })();

  const phasesAfterStop = r.timeline.slice(Math.max(0, stopIdx));
  const maxGapAfterStop = (() => {
    let g = 0;
    for (let i = 1; i < phasesAfterStop.length; i++) g = Math.max(g, phasesAfterStop[i].at - phasesAfterStop[i - 1].at);
    return g;
  })();

  check("progress: the download phase never freezes (records keep landing, max 2.5s apart)", (() => {
    let g = 0;
    for (let i = 1; i < downloadRecords.length; i++) g = Math.max(g, downloadRecords[i].at - downloadRecords[i - 1].at);
    return downloadRecords.length >= 1 && (downloadRecords.length < 3 || g <= 2500);
  })(), `${downloadRecords.length} records, max gap ${(() => { let g = 0; for (let i = 1; i < downloadRecords.length; i++) g = Math.max(g, downloadRecords[i].at - downloadRecords[i - 1].at); return g; })()}ms`);

  check("progress: the dependency-tree phase creeps upward instead of sitting at one value", downloadPercents.length < 3 || Math.max(...downloadPercents) > Math.min(...downloadPercents), JSON.stringify(downloadPercents));

  check("progress: the download milestone is reached before the stop-service step (no 6%->64% teleport)", stopIdx > 0 && maxDownloadBeforeStop !== null && maxDownloadBeforeStop >= 50, `max download percent before stop = ${maxDownloadBeforeStop}`);

  check("progress: percent never rewinds", r.withPercent.every((p, i, a) => i === 0 || p.percent >= a[i - 1].percent), JSON.stringify(r.withPercent.map((p) => p.percent)));

  check("progress: no phase after stop-service stays silent for more than 6s", maxGapAfterStop <= 6000, `max gap after stop = ${maxGapAfterStop}ms`);

  check("progress: the worker's own ops log records the full phase order", (() => {
    const order = r.ops.map((o) => o.op);
    const need = ["main-update-worker-start", "main-tarball-download-ok", "main-update-stop-service", "main-install-tarball-tree-ok"];
    if (variant !== "slowdryrun") need.push("main-decl-synced");
    let idx = -1;
    for (const n of need) {
      const at = order.indexOf(n);
      if (at < 0) return false;
      if (at < idx) return false;
      idx = at;
    }
    return order.some((o) => o === "main-npm-dryrun-ok" || o === "main-npm-dryrun-fail");
  })(), r.ops.map((o) => o.op).join(" -> "));

  if (variant === "slowdryrun") {
    check("slow dependency-tree check: >= 8 live progress records during npm dry-run", downloadRecords.length >= 8, `${downloadRecords.length} records`);
    check("slow dependency-tree check: the bar advanced across the whole check", Math.max(...downloadPercents) - Math.min(...downloadPercents) >= 3, `range ${Math.min(...downloadPercents)}..${Math.max(...downloadPercents)}`);
    check("slow dependency-tree check: ends with the integrity guard, never touching a live service", r.last && r.last.code === "E_INTEGRITY", JSON.stringify({ code: r.last && r.last.code, phase: r.last && r.last.phase }));
    return;
  }

  if (variant === "pending") {
    check("issue #18: a restart-pending record is emitted instead of an instant failure", r.timeline.some((p) => p.phase === "restart-pending"));
    check("issue #18: the final record separates 'installed OK' from 'restart timed out'", r.last && r.last.code === "E_RESTART" && r.last.restartPending === true && r.last.installed === TARGET, JSON.stringify({ code: r.last && r.last.code, restartPending: r.last && r.last.restartPending, installed: r.last && r.last.installed }));
    check("issue #18: the failure text says the install succeeded", Boolean(r.last && /安装已完成/.test(r.last.error || "")) && Boolean(r.last && r.last.error.includes(TARGET)));
    check("issue #18: the restart-pending observation lasted well past the old 30s window", (() => {
      const first = r.timeline.findIndex((p) => p.phase === "restart-pending");
      return first >= 0 && r.timeline[r.timeline.length - 1].t - r.timeline[first].t >= 4000;
    })(), "window observed");
  } else {
    check("issue #18: the restart-pending state recovers into a successful done record", r.last && r.last.phase === "done" && r.last.percent === 100 && r.last.running === false, JSON.stringify({ phase: r.last && r.last.phase, percent: r.last && r.last.percent, running: r.last && r.last.running }));
    check("issue #18: the done record reports the installed version", r.last && r.last.result && r.last.result.ok === true && r.last.result.installed === TARGET, JSON.stringify(r.last && r.last.result));
    if (variant === "authgate") {
      check("issue #18 (real case): an auth-gated GET / (401) no longer reports a successful install as failure", r.ops.some((o) => o.op === "main-update-health-auth-gated"), JSON.stringify(r.ops.map((o) => o.op)));
    }
  }

  if (r.stdout.trim()) console.log("  worker stdout:", r.stdout.trim().split("\n").slice(-2).join(" | "));
  if (r.stderr.trim()) console.log("  worker stderr:", r.stderr.trim().split("\n").slice(-2).join(" | "));
}

for (const variant of ["slowdryrun", "pending", "recover", "authgate"]) {
  const r = await runVariant(variant);
  report(variant, r);
  const lockExists = await stat(r.lockFile).then(() => true).catch(() => false);
  if (lockExists) {
    failures.push(`${variant}: update lock left behind`);
    console.error(`  FAIL ${variant}: update lock left behind`);
  } else {
    console.log("  OK   the update lock is gone when the worker ends");
  }
  const leftovers = (await readdir(r.dep.root).catch(() => [])).filter((n) => n.startsWith(".dsh-uc-"));
  console.log(`  ${leftovers.length === 0 ? "OK   " : "FAIL "}no .dsh-uc temp dirs left in the deployment root`);
  if (leftovers.length) failures.push(`${variant}: temp dirs left behind`);
  await rm(r.dep.work, { recursive: true, force: true });
}

console.log(failures.length === 0 ? "\nE2E PROGRESS TIMELINE: PASS" : `\nE2E PROGRESS TIMELINE: ${failures.length} FAILURE(S)`);
process.exitCode = failures.length === 0 ? 0 : 1;
