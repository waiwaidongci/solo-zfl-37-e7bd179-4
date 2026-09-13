// 浏览器 E2E 自包含启动器：自动用独立测试库起服务 → 跑 Playwright E2E → 关闭。
// 用法：node test/browser-all.mjs
import { spawn } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = 4500 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_DB = join(ROOT, "data", `test-e2e-${process.pid}.json`);

if (existsSync(TEST_DB)) rmSync(TEST_DB);
const server = spawn(process.execPath, [join(ROOT, "server.js")], {
  cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), INK_DB: TEST_DB },
  stdio: ["ignore", "pipe", "inherit"],
});

await new Promise((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("server start timeout")), 8000);
  server.stdout.on("data", c => { if (String(c).includes("listening")) { clearTimeout(timer); resolve(); } });
  server.on("exit", code => reject(new Error("server exited " + code)));
});

const e2e = spawn(process.execPath, [join(__dirname, "browser-e2e.mjs")], {
  cwd: ROOT,
  env: { ...process.env, BASE_URL: BASE },
  stdio: "inherit",
});

const code = await new Promise(resolve => e2e.on("exit", resolve));
server.kill("SIGTERM");
await new Promise(resolve => server.on("exit", resolve));
rmSync(TEST_DB, { force: true });
process.exit(code);
