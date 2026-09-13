// 旧版 v1 数据无损升级验证 + 单计划审计子集语义验证。
// 运行：node test/migration-tests.mjs
import { spawn } from "node:child_process";
import { rmSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = 4400 + Math.floor(Math.random() * 300);
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_DB = join(ROOT, "data", `test-migrate-${process.pid}.json`);

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra = "") {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✗ ${name}\x1b[0m ${extra}`); }
}
async function call(method, path, actor, body) {
  const res = await fetch(BASE + path, {
    method,
    headers: { "Content-Type": "application/json", ...(actor ? { "X-User-Id": actor } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, data };
}

// 与最初仓库 server.js 里完全一致的 v1 结构（含 logs 试磨日志）
const v1 = {
  items: [
    {
      code: "IS-001", smokeSource: "黄山松烟", glueRatio: "7.5%", ageYears: 8, storage: "恒湿柜B", status: "已试磨",
      logs: [{ at: "2026-06-11", step: "试磨", note: "宣纸20滴水，出墨快，评分86", score: 86 }],
    },
    {
      id: "IS-LEGACY-ID", smokeSource: "老藏松烟", glueRatio: "9%", ageYears: 20, storage: "樟木箱", status: "待试磨",
      logs: [
        { at: "2025-03-02", step: "建档", note: "旧库导入", score: null },
        { at: "2025-05-10", step: "试磨", note: "胶重，研感滞涩", score: 72 },
      ],
      tests: [{ at: "2025-05-10T03:00:00.000Z", paper: "元书纸", water: "18滴", speed: "慢", colorLayer: "四层", sediment: "少量", score: 72 }],
    },
    { code: "IS-002", smokeSource: "桐油烟", glueRatio: "8%", ageYears: 3, storage: "试样盒C", status: "待试磨", logs: [] },
  ],
};

async function startServer() {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  writeFileSync(TEST_DB, JSON.stringify(v1, null, 2)); // 直接放一个旧版（无 version）库
  const proc = spawn(process.execPath, [join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), INK_DB: TEST_DB },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server start timeout")), 8000);
    proc.stdout.on("data", c => { if (String(c).includes("listening")) { clearTimeout(timer); resolve(); } });
    proc.on("exit", code => reject(new Error("server exited " + code)));
  });
  return proc;
}

const sha = (t) => createHash("sha256").update(t, "utf8").digest("hex");

async function main() {
  const server = await startServer();
  let serverExited = false;
  try {
    console.log("\n[M1] 旧版墨锭与字段完整保留");
    const boot = (await call("GET", "/api/bootstrap")).data;
    ok(boot.items.length >= 3, `原有 3 个墨锭都在（共 ${boot.items.length}，含补充演示墨锭）`);
    const a = boot.items.find(i => i.code === "IS-001");
    ok(a, "IS-001 存在");
    ok(a.smokeSource === "黄山松烟" && a.glueRatio === "7.5%" && a.ageYears === 8 && a.storage === "恒湿柜B" && a.status === "已试磨",
      "IS-001 全部原始字段保留（烟料/胶比/年限/位置/旧状态）", JSON.stringify(a));
    ok(Array.isArray(a.logs) && a.logs.length === 1 && a.logs[0].note === "宣纸20滴水，出墨快，评分86" && a.logs[0].score === 86,
      "IS-001 试磨日志（logs）完整保留");

    const b = boot.items.find(i => i.code === "IS-LEGACY-ID");
    ok(b, "只有 id 无 code 的旧记录也被保留（id 归一为 code）");
    ok(b.logs.length === 2, "IS-LEGACY-ID 两条历史日志保留");
    ok(b.tests.length === 1 && b.tests[0].paper === "元书纸" && b.tests[0].score === 72 && b.tests[0].colorLayer === "四层",
      "试磨结果（tests：纸张/出墨速度/墨色层次/沉淀/评分）完整保留", JSON.stringify(b.tests));

    const c = boot.items.find(i => i.code === "IS-002");
    ok(c && c.smokeSource === "桐油烟", "IS-002 保留");

    console.log("\n[M2] 历史数据进入审计链，且全链可校验");
    const global = (await call("GET", "/api/events")).data;
    ok(global.scope === "global", "全链 scope=global");
    ok(global.chainValid && global.verified && global.contiguous === true, "迁移后全局哈希链有效");
    const legacyLogs = global.events.filter(e => e.action === "legacy_log");
    const legacyTests = global.events.filter(e => e.action === "legacy_test");
    const imported = global.events.filter(e => e.action === "item_imported");
    const mig = global.events.find(e => e.action === "schema_migrated");
    ok(imported.length === 3, `3 条墨锭导入事件（实际 ${imported.length}）`);
    ok(legacyLogs.length === 3, `3 条历史试磨日志入链（实际 ${legacyLogs.length}）`);
    ok(legacyTests.length === 1, `1 条历史试磨结果入链（实际 ${legacyTests.length}）`);
    ok(mig && mig.detail.fromVersion === 1 && mig.detail.toVersion === 2, "记录 schema_migrated 迁移事件 1→2");

    // 独立重算整条链
    let prev = "0".repeat(64); let localOk = true;
    for (let i = 0; i < global.events.length; i++) {
      const e = global.events[i];
      const h = sha([e.seq, e.ts, e.planId, e.action, e.actorId, JSON.stringify(e.detail), prev].join("|"));
      if (e.seq !== i + 1 || e.hash !== h) { localOk = false; break; }
      prev = h;
    }
    ok(localOk, "迁移后的链可被客户端独立重算验证");

    console.log("\n[M3] 单计划审计：子集语义与全链损坏严格区分");
    // 取一个真实计划
    const plan = boot.plans[0];
    const sub = (await call("GET", `/api/events?planId=${plan.id}`)).data;
    ok(sub.scope === "plan", "子集 scope=plan");
    ok(sub.contiguous === false && sub.subsetOfGlobal === true, "子集明确标注为非连续、属于全链切片");
    ok(sub.chainValid === true && sub.scopeValid === true && sub.verified === true,
      "全链完好时，子集校验通过（不再误报链损坏）：" + sub.message);
    ok(sub.events.every(e => e.planId === plan.id), "子集只含该计划事件");
    // 子集序号天然不连续（中间穿插其他计划事件）
    const seqs = sub.events.map(e => e.seq);
    ok(seqs.some((x, i) => i > 0 && x !== seqs[i - 1] + 1) || global.events.length > sub.events.length,
      "子集序号不连续但仍判为有效（证明不再用全链规则误判）");

    console.log("\n[M4] 迁移后的旧墨锭可直接参与新排期");
    const r = await call("POST", "/api/plans", "u1", {
      itemCode: "IS-001", operatorId: "u1", reviewerId: "u2", stationId: "ST-01",
      start: "2030-01-01T01:00:00.000Z", end: "2030-01-01T02:00:00.000Z",
      params: { paper: "净皮宣", waterDrops: 20, grindMinutes: 30, pressure: "中力", targetScore: 85 }, submit: true,
    });
    ok(r.status === 201 && r.data.plan.status === "pending", "用迁移保留的 IS-001 成功提交新排期");

    console.log("\n[M5] 重启幂等（迁移只发生一次、数据持久不丢）");
    await new Promise(resolve => { server.on("exit", resolve); server.kill("SIGTERM"); });
    serverExited = true;
    const server2 = await startServer();
    try {
      const boot2 = (await call("GET", "/api/bootstrap")).data;
      const migCount2 = (await call("GET", "/api/events")).data.events.filter(e => e.action === "schema_migrated").length;
      ok(boot2.items.find(i => i.code === "IS-001")?.logs?.length === 1, "重启后历史日志仍在");
      const t = boot2.items.find(i => i.code === "IS-LEGACY-ID");
      ok(t?.tests?.length === 1 && t.tests[0].colorLayer === "四层", "重启后试磨结果仍在");
      ok(migCount2 === 1, `schema_migrated 仅 1 条（实际 ${migCount2}），迁移只发生一次且已落盘为 v2`);
      ok(boot2.chainValid === true, "重启后全局链仍有效");
    } finally {
      await new Promise(resolve => { server2.on("exit", resolve); server2.kill("SIGTERM"); });
    }

  } finally {
    if (!serverExited) server.kill("SIGTERM");
  }
  console.log(`\n${"=".repeat(50)}`);
  console.log(`迁移/子集验证：\x1b[32m${pass} 通过\x1b[0m，\x1b[${fail ? "31" : "32"}m${fail} 失败\x1b[0m`);
  if (fail) { failures.forEach(f => console.log("  FAIL: " + f)); process.exit(1); }
  rmSync(TEST_DB, { force: true });
}
main().catch(e => { console.error(e); process.exit(1); });
