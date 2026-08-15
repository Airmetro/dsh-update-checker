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
  if (registrations.length !== 4) {
    console.error("EXPECTED 4 ROUTES, GOT", registrations.length);
    process.exitCode = 1;
  }
} catch (err) {
  console.error("APPLY THREW:", err && err.stack ? err.stack : err);
  process.exitCode = 1;
}
