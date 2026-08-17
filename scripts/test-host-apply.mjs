// 隔离测试：导入源码 Host 模块，用假 ctx 驱动 apply（含 inject 路径）
const plugin = (await import("../lib/index.js")).default;
console.log("plugin name:", plugin.name);

const registrations = [];
const fakeWebServer = {
  register(route) {
    registrations.push(route);
    return () => {};
  },
};
const ctx = {
  inject(names, cb) {
    if (names.includes("webServer")) cb({ webServer: fakeWebServer });
    return () => {};
  },
  get() {
    return undefined;
  },
};

try {
  const result = plugin.apply(ctx);
  if (result && typeof result.then === "function") await result;
  console.log("apply OK; routes registered:", registrations.map((r) => r.kind + " " + r.path).join(", "));
  const EXPECTED = [
    "/dsh-update-checker/status.json",
    "/dsh-update-checker/suppress",
    "/dsh-update-checker/update",
    "/dsh-update-checker/rollback",
    "/dsh-update-checker/backups.json",
    "/dsh-update-checker/restart",
    "/dsh-update-checker/restart-status.json",
    "/dsh-update-checker/plugins.json",
    "/dsh-update-checker/plugin-update",
    "/dsh-update-checker/plugin-rollback",
    "/dsh-update-checker/plugin-suppress",
    "/dsh-update-checker/settings.json",
    "/dsh-update-checker/settings",
  ];
  const got = registrations.map((r) => r.path);
  const missing = EXPECTED.filter((p) => !got.includes(p));
  if (missing.length) {
    console.error("MISSING ROUTES:", missing.join(", "));
    process.exitCode = 1;
  } else {
    console.log(`OK   all ${EXPECTED.length} routes registered`);
  }
} catch (err) {
  console.error("APPLY THREW:", err && err.stack ? err.stack : err);
  process.exitCode = 1;
}
