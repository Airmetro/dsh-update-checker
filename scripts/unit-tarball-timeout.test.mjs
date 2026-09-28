import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import http from "node:http";
import https from "node:https";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const workerPath = process.env.DSH_UC_WORKER || join(here, "main-update-worker.mjs");

async function workerSource() {
  return readFile(workerPath, "utf8");
}

async function loadHttpGetBuffer() {
  const src = await workerSource();
  const start = src.indexOf("function httpGetBuffer");
  const end = src.indexOf("\nasync function downloadTarballToFile");
  assert.ok(start > 0, "httpGetBuffer not found in worker source");
  assert.ok(end > start, "downloadTarballToFile not found after httpGetBuffer");
  const snippet = src.slice(start, end);
  return new Function("http", "https", `${snippet}\nreturn httpGetBuffer;`)(http, https);
}

function listen(handler) {
  return new Promise((resolve) => {
    const server = createServer(handler);
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

function urlOf(server) {
  const addr = server.address();
  return `http://127.0.0.1:${addr.port}/pkg.tgz`;
}

function close(server) {
  server.closeAllConnections?.();
  server.close();
}

function item(name) {
  return { name, version: "9.9.9", file: `${name}-9.9.9.tgz` };
}

test("stalled body aborts after the idle timeout instead of hanging forever", async () => {
  const httpGetBuffer = await loadHttpGetBuffer();
  const server = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.write(Buffer.alloc(1024, 7));
  });
  try {
    const t0 = Date.now();
    await assert.rejects(
      () => httpGetBuffer(urlOf(server), 600, 20000, 200 * 1024 * 1024),
      (err) => /no data for/.test(String(err.message))
    );
    assert.ok(Date.now() - t0 < 5000, "expected the idle timeout to win");
  } finally {
    close(server);
  }
});

test("healthy body resolves with the full payload", async () => {
  const httpGetBuffer = await loadHttpGetBuffer();
  const payload = [Buffer.alloc(4096, 1), Buffer.alloc(4096, 2), Buffer.alloc(512, 3)];
  const total = payload.reduce((n, b) => n + b.length, 0);
  const server = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    for (const chunk of payload) res.write(chunk);
    res.end();
  });
  try {
    const out = await httpGetBuffer(urlOf(server), 600, 20000, 200 * 1024 * 1024);
    assert.equal(out.length, total);
    assert.equal(out[0], 1);
    assert.equal(out[total - 1], 3);
  } finally {
    close(server);
  }
});

test("metadata headers override the defaults without dropping them", async () => {
  const httpGetBuffer = await loadHttpGetBuffer();
  let seen = null;
  const server = await listen((req, res) => {
    seen = req.headers;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
  try {
    const out = await httpGetBuffer(urlOf(server), 5000, 20000, 1024 * 1024, {
      Accept: "application/vnd.npm.install-v1+json",
    });
    assert.equal(JSON.parse(out.toString("utf8")).ok, true);
    assert.equal(seen.accept, "application/vnd.npm.install-v1+json");
    assert.equal(seen.connection, "close");
    assert.equal(seen["user-agent"], "dsh-update-checker");
  } finally {
    close(server);
  }
});

test("slow trickle still hits the total attempt timeout", async () => {
  const httpGetBuffer = await loadHttpGetBuffer();
  const server = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    const timer = setInterval(() => res.write(Buffer.alloc(16, 9)), 150);
    res.on("close", () => clearInterval(timer));
  });
  try {
    await assert.rejects(
      () => httpGetBuffer(urlOf(server), 10000, 900, 200 * 1024 * 1024),
      (err) => /download exceeded/.test(String(err.message))
    );
  } finally {
    close(server);
  }
});

test("size cap rejects oversized bodies", async () => {
  const httpGetBuffer = await loadHttpGetBuffer();
  const server = await listen((req, res) => {
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(Buffer.alloc(4096, 4));
  });
  try {
    await assert.rejects(
      () => httpGetBuffer(urlOf(server), 5000, 20000, 1024),
      (err) => /exceeds/.test(String(err.message))
    );
  } finally {
    close(server);
  }
});

test("http error status rejects immediately", async () => {
  const httpGetBuffer = await loadHttpGetBuffer();
  const server = await listen((req, res) => {
    res.writeHead(404);
    res.end("nope");
  });
  try {
    await assert.rejects(
      () => httpGetBuffer(urlOf(server), 5000, 20000, 1024),
      (err) => /HTTP 404/.test(String(err.message))
    );
  } finally {
    close(server);
  }
});

test("every request opens its own connection (no keep-alive reuse)", async () => {
  const httpGetBuffer = await loadHttpGetBuffer();
  const remotePorts = [];
  const server = await listen((req, res) => {
    remotePorts.push(req.socket.remotePort);
    res.writeHead(200, { "content-type": "application/octet-stream" });
    res.end(Buffer.alloc(64, 5));
  });
  try {
    await httpGetBuffer(urlOf(server), 5000, 20000, 1024 * 1024);
    await httpGetBuffer(urlOf(server), 5000, 20000, 1024 * 1024);
    assert.equal(remotePorts.length, 2);
    assert.notEqual(remotePorts[0], remotePorts[1], "the second request must not reuse the first socket");
  } finally {
    close(server);
  }
});

test("pool downloads in parallel, capped, and counts every completion once", async () => {
  const todo = Array.from({ length: 20 }, (_, i) => item(`pkg-${i}`));
  let inFlight = 0;
  let maxInFlight = 0;
  const started = [];
  const progress = [];
  const written = [];
  const fakeDownload = async (pkgName) => {
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    started.push(pkgName);
    await new Promise((r) => setTimeout(r, 40));
    inFlight -= 1;
  };
  const src = await workerSource();
  const start = src.indexOf("async function downloadTarballsToCache");
  const end = src.indexOf("\nasync function extractTreeFromCache");
  const concurrency = Number((src.match(/const TARBALL_CONCURRENCY = (\d+);/) || [])[1]);
  const poolFn = new Function(
    "join",
    "writeFile",
    "opsLog",
    "DSH_HOME",
    "TARGET",
    "TARBALL_PLAN_FILE",
    "downloadTarballToFile",
    "TARBALL_CONCURRENCY",
    `${src.slice(start, end)}\nreturn downloadTarballsToCache;`
  )(
    join,
    async (p) => written.push(p),
    async () => {},
    "D:\\dsh-home",
    "9.9.9",
    "tarball-plan.json",
    fakeDownload,
    concurrency
  );
  const res = await poolFn(todo, "D:\\cache", (p) => progress.push(p.current));
  assert.equal(res.ok.length, 20);
  assert.equal(res.failed.length, 0);
  assert.equal(res.total, 20);
  assert.ok(maxInFlight > 1, `expected parallel downloads, max in flight was ${maxInFlight}`);
  assert.ok(maxInFlight <= concurrency, `max in flight ${maxInFlight} exceeded cap ${concurrency}`);
  assert.deepEqual(progress, Array.from({ length: 20 }, (_, i) => i + 1));
  assert.equal(new Set(started).size, 20);
  assert.ok(written.some((p) => p.includes("tarball-plan.json")));
  assert.ok(written.some((p) => p.includes("dsh-update-checker-skipped-pkgs.json")));
});

test("pool records failures without aborting the remaining packages", async () => {
  const src = await workerSource();
  const start = src.indexOf("async function downloadTarballsToCache");
  const end = src.indexOf("\nasync function extractTreeFromCache");
  const logged = [];
  const progress = [];
  const fakeDownload = async (pkgName) => {
    await new Promise((r) => setTimeout(r, 5));
    if (pkgName === "pkg-3") throw new Error("HTTP 404");
    if (pkgName === "pkg-7") throw new Error("tarball download failed: socket hang up");
  };
  const poolFn = new Function(
    "join",
    "writeFile",
    "opsLog",
    "DSH_HOME",
    "TARGET",
    "TARBALL_PLAN_FILE",
    "downloadTarballToFile",
    "TARBALL_CONCURRENCY",
    `${src.slice(start, end)}\nreturn downloadTarballsToCache;`
  )(
    join,
    async () => {},
    async (entry) => logged.push(entry),
    "D:\\dsh-home",
    "9.9.9",
    "tarball-plan.json",
    fakeDownload,
    6
  );
  const todo = Array.from({ length: 10 }, (_, i) => item(`pkg-${i}`));
  const res = await poolFn(todo, "D:\\cache", (p) => progress.push(p.current));
  assert.equal(res.ok.length, 8);
  assert.deepEqual(res.skipped, ["pkg-3"]);
  assert.equal(res.failed.length, 1);
  assert.equal(res.failed[0].name, "pkg-7");
  assert.equal(progress.length, 10);
  assert.ok(logged.some((e) => e.op === "main-tarball-pkg-skipped"));
  assert.ok(logged.some((e) => e.op === "main-tarball-pkg-failed"));
});

test("timeouts escalate, concurrency is bounded, and sockets are not pooled", async () => {
  const src = await workerSource();
  const caps = src.match(/const TARBALL_ATTEMPT_TIMEOUTS_MS = \[([^\]]+)\];/);
  assert.ok(caps, "TARBALL_ATTEMPT_TIMEOUTS_MS not found");
  const values = caps[1].split(",").map((s) => Number(s.trim()));
  assert.equal(values.length, 3);
  assert.ok(values[0] <= 120000, `first attempt cap too generous: ${values[0]}`);
  assert.ok(values[1] >= values[0] && values[2] >= values[1], "attempt caps must not shrink");
  const idle = src.match(/const TARBALL_IDLE_TIMEOUT_MS = (\d+);/);
  assert.ok(idle && Number(idle[1]) <= 60000, "idle timeout missing or too generous");
  assert.ok(/const TARBALL_CONCURRENCY = [4-9]\d*;/.test(src), "concurrency should be at least 4");
  assert.ok(/TARBALL_ATTEMPT_TIMEOUTS_MS\[Math\.min\(attempt - 1/.test(src), "per-attempt cap not used");
  assert.ok(/agent: false/.test(src), "requests must not use a pooled agent");
  assert.ok(/Connection: "close"/.test(src), "requests must ask the server to close the socket");
  assert.ok(!/await fetch\(/.test(src), "tarball downloads must not use global fetch");
});
