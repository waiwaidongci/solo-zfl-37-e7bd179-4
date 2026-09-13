// 墨锭试磨室 —— 真实验证：并发竞争 / 权限矩阵 / 回滚原子性 / 刷新一致性 / 审计链
// 运行：node test/run-tests.mjs
import { spawn } from "node:child_process";
import { rmSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const PORT = 4309 + Math.floor(Math.random() * 400);
const BASE = `http://127.0.0.1:${PORT}`;
const TEST_DB = join(ROOT, "data", `test-${process.pid}.json`);

let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra = "") {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name + (extra ? ` — ${extra}` : "")); console.log(`  \x1b[31m✗ ${name}\x1b[0m ${extra}`); }
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
const iso = (h1, m1 = 0, h2 = h1 + 1, m2 = m1, day = 5) => ({
  start: `2026-10-${String(day).padStart(2, "0")}T${String(h1).padStart(2, "0")}:${String(m1).padStart(2, "0")}:00.000Z`,
  end:   `2026-10-${String(day).padStart(2, "0")}T${String(h2).padStart(2, "0")}:${String(m2).padStart(2, "0")}:00.000Z`,
});

const validPlan = (over = {}) => ({
  itemCode: "IS-001", operatorId: "u1", reviewerId: "u2", stationId: "ST-01",
  ...iso(1, 0, 2, 0),
  params: { paper: "净皮宣纸", waterDrops: 20, grindMinutes: 40, pressure: "中力", targetScore: 85, note: "" },
  ...over,
});

/* ---------------- 启动服务器（独立测试库） ---------------- */
async function startServer() {
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
  const proc = spawn(process.execPath, [join(ROOT, "server.js")], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(PORT), INK_DB: TEST_DB },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("server start timeout")), 8000);
    proc.stdout.on("data", (chunk) => {
      if (String(chunk).includes("listening")) { clearTimeout(timer); resolve(); }
    });
    proc.on("exit", (code) => reject(new Error("server exited " + code)));
  });
  return proc;
}

async function runStress(scenario, start, end, count = 8) {
  const workers = [];
  for (let i = 0; i < count; i++) {
    workers.push(new Promise((resolve) => {
      const args = [join(__dirname, "stress-worker.mjs"), BASE, String(i), scenario, start, end];
      const p = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "inherit"] });
      let out = "";
      p.stdout.on("data", (c) => (out += c));
      p.on("close", () => { try { resolve(JSON.parse(out.trim().split("\n").pop())); } catch (e) { resolve({ status: 0, error: String(e) }); } });
    }));
  }
  return Promise.all(workers);
}

/* ================================================================ */
async function main() {
  const server = await startServer();

  try {
    /* ---------- 1. 基础与权限 ---------- */
    console.log("\n[1] 身份与权限");
    let r = await call("POST", "/api/plans", null, validPlan({ submit: true }));
    ok(r.status === 401, "无身份操作被拒绝 (401)");

    r = await call("POST", "/api/plans", "u1", validPlan({ reviewerId: "u1", submit: true }));
    ok(r.status === 400 && r.data.error === "reviewer_is_operator", "审核人=操作人 → 400 reviewer_is_operator");

    r = await call("POST", "/api/plans", "u1", validPlan({ reviewerId: "nope", submit: true }));
    ok(r.status === 400 && r.data.error === "bad_reviewer", "不存在的复核人 → 400");

    r = await call("POST", "/api/plans", "u1", validPlan({ start: "2026-10-05T03:00:00.000Z", end: "2026-10-05T02:00:00.000Z", submit: true }));
    ok(r.status === 400 && r.data.error === "end_before_start", "结束早于开始 → 400");

    /* ---------- 2. 草稿 / 提交 / 审核 / 执行 / 完成 全链路 ---------- */
    console.log("\n[2] 完整状态机：草稿→提交→审核→执行→完成");
    r = await call("POST", "/api/plans", "u1", validPlan({ submit: false, reviewerId: "" }));
    ok(r.status === 201 && r.data.plan.status === "draft" && !r.data.plan.reviewerId, "存草稿成功（未指定复核人）");
    const draftId = r.data.plan.id;

    let boot = (await call("GET", "/api/bootstrap")).data;
    ok(boot.occupancy.every(o => o.planId !== draftId), "草稿不占用台位/墨锭");

    // 草稿未指定复核人时提交 → 400
    r = await call("POST", `/api/plans/${draftId}/submit`, "u1", {});
    ok(r.status === 400 && r.data.error === "reviewer_required", "草稿缺复核人 → 提交被拒");

    // 非操作人不能提交他人草稿
    r = await call("POST", `/api/plans/${draftId}/submit`, "u3", {});
    ok(r.status === 403, "非操作人不能提交他人排期 (403)");

    r = await call("PATCH", `/api/plans/${draftId}`, "u1", validPlan({ submit: undefined }));
    ok(r.status === 200, "草稿可编辑");
    r = await call("POST", `/api/plans/${draftId}/submit`, "u1", {});
    ok(r.status === 200 && r.data.plan.status === "pending", "提交成功 → pending");

    boot = (await call("GET", "/api/bootstrap")).data;
    ok(boot.occupancy.some(o => o.planId === draftId), "提交后立即写入占用");

    // 操作人自审
    r = await call("POST", `/api/plans/${draftId}/review`, "u1", { decision: "approved" });
    ok(r.status === 403 && r.data.error === "reviewer_is_operator", "操作人自审 → 403 reviewer_is_operator");

    // 无关第三人审核
    r = await call("POST", `/api/plans/${draftId}/review`, "u3", { decision: "approved" });
    ok(r.status === 403, "非指派复核人不能审核 (403)");

    // 驳回不填原因
    r = await call("POST", `/api/plans/${draftId}/review`, "u2", { decision: "rejected", reason: "  " });
    ok(r.status === 400 && r.data.error === "reason_required", "驳回不写原因 → 400 reason_required");

    boot = (await call("GET", "/api/bootstrap")).data;
    const pendingBeforeReject = boot.occupancy.some(o => o.planId === draftId);

    // 正常驳回
    r = await call("POST", `/api/plans/${draftId}/review`, "u2", { decision: "rejected", reason: "纸张与配方目标不符" });
    ok(r.status === 200 && r.data.plan.status === "rejected" && r.data.plan.reason === "纸张与配方目标不符", "驳回成功且原因落库");
    boot = (await call("GET", "/api/bootstrap")).data;
    ok(!boot.occupancy.some(o => o.planId === draftId), "驳回释放占用（之前占用存在：" + pendingBeforeReject + "）");

    // 改后重提
    r = await call("PATCH", `/api/plans/${draftId}`, "u1", validPlan({ stationId: "ST-02", start: "2026-10-05T04:00:00.000Z", end: "2026-10-05T05:00:00.000Z" }));
    ok(r.status === 200, "被驳回排期可编辑");
    r = await call("POST", `/api/plans/${draftId}/submit`, "u1", {});
    ok(r.status === 200 && r.data.plan.status === "pending", "改后重新提交 → pending");

    // 复核通过
    r = await call("POST", `/api/plans/${draftId}/review`, "u2", { decision: "approved" });
    ok(r.status === 200 && r.data.plan.status === "approved", "复核通过 → approved");

    // 非操作人不能开始
    r = await call("POST", `/api/plans/${draftId}/start`, "u3", {});
    ok(r.status === 403, "他人不能开始执行 (403)");
    r = await call("POST", `/api/plans/${draftId}/start`, "u1", {});
    ok(r.status === 200 && r.data.plan.status === "running", "操作人开始执行 → running");

    // 执行中再批准/开始 → 状态冲突
    r = await call("POST", `/api/plans/${draftId}/start`, "u1", {});
    ok(r.status === 409 && r.data.error === "not_approved", "running 重复开始 → 409");

    // 执行中取消：必须双人复核
    r = await call("POST", `/api/plans/${draftId}/cancel-request`, "u1", { reason: "" });
    ok(r.status === 400 && r.data.error === "reason_required", "取消不写原因 → 400");
    r = await call("POST", `/api/plans/${draftId}/cancel-request`, "u3", { reason: "设备异响" });
    ok(r.status === 403, "非操作人不能申请取消 (403)");
    r = await call("POST", `/api/plans/${draftId}/cancel-request`, "u1", { reason: "设备异响需停机" });
    ok(r.status === 200 && r.data.plan.status === "cancel_review", "执行中取消 → cancel_review");

    // 申请人本人不能复核自己的取消
    r = await call("POST", `/api/plans/${draftId}/cancel-review`, "u1", { decision: "confirmed" });
    ok(r.status === 403 && r.data.error === "reviewer_is_requester", "取消申请人自我确认 → 403 reviewer_is_requester");
    // 驳回去消不填原因
    r = await call("POST", `/api/plans/${draftId}/cancel-review`, "u2", { decision: "rejected", reason: "" });
    ok(r.status === 400, "取消复核驳回缺原因 → 400");
    // 第二人驳回去消 → 继续执行
    r = await call("POST", `/api/plans/${draftId}/cancel-review`, "u2", { decision: "rejected", reason: "异响已排除，继续研磨" });
    ok(r.status === 200 && r.data.plan.status === "running", "取消被第二人驳回 → 回到 running");
    boot = (await call("GET", "/api/bootstrap")).data;
    ok(boot.occupancy.some(o => o.planId === draftId), "继续执行时占用仍然保留");

    // 再次申请取消并确认
    r = await call("POST", `/api/plans/${draftId}/cancel-request`, "u1", { reason: "胶性异常，无法继续" });
    ok(r.status === 200 && r.data.plan.status === "cancel_review", "再次申请取消 → cancel_review");
    r = await call("POST", `/api/plans/${draftId}/cancel-review`, "u2", { decision: "confirmed" });
    ok(r.status === 200 && r.data.plan.status === "cancelled", "第二人确认取消 → cancelled");
    boot = (await call("GET", "/api/bootstrap")).data;
    ok(!boot.occupancy.some(o => o.planId === draftId), "取消确认后释放占用");

    /* ---------- 3. 未开始排期：申请即取消（无需复核） ---------- */
    console.log("\n[3] 未开始取消立即生效");
    r = await call("POST", "/api/plans", "u3", validPlan({
      operatorId: "u3", reviewerId: "u1", stationId: "ST-03",
      start: "2026-10-06T01:00:00.000Z", end: "2026-10-06T02:00:00.000Z", submit: true,
    }));
    const beforeId = r.data.plan.id;
    ok(r.status === 201, "直接提交第二个排期 → 201 pending");
    r = await call("POST", `/api/plans/${beforeId}/review`, "u1", { decision: "approved" });
    ok(r.status === 200, "第二个排期已批准");
    r = await call("POST", `/api/plans/${beforeId}/cancel-request`, "u3", { reason: "临时停电" });
    ok(r.status === 200 && r.data.plan.status === "cancelled", "未开始取消登记即生效 → cancelled");
    boot = (await call("GET", "/api/bootstrap")).data;
    ok(!boot.occupancy.some(o => o.planId === beforeId), "立即取消已释放占用");

    /* ---------- 4. 完成链路 ---------- */
    console.log("\n[4] 完成试磨并释放占用");
    r = await call("POST", "/api/plans", "u3", validPlan({
      operatorId: "u3", reviewerId: "u2", stationId: "ST-03",
      start: "2026-10-07T01:00:00.000Z", end: "2026-10-07T02:00:00.000Z", submit: true,
    }));
    const finishId = r.data.plan.id;
    await call("POST", `/api/plans/${finishId}/review`, "u2", { decision: "approved" });
    await call("POST", `/api/plans/${finishId}/start`, "u3", {});
    r = await call("POST", `/api/plans/${finishId}/complete`, "u3", { result: "出墨细润，评分 88" });
    ok(r.status === 200 && r.data.plan.status === "completed", "执行完成 → completed");
    boot = (await call("GET", "/api/bootstrap")).data;
    ok(!boot.occupancy.some(o => o.planId === finishId), "完成后释放占用");

    /* ---------- 5. 真实多进程并发 ---------- */
    console.log("\n[5] 真实多进程并发竞争（每场景 8 个独立进程同时请求）");
    // 压测用墨锭建档
    for (let i = 0; i < 8; i++) {
      await call("POST", "/api/items", "admin", { code: `STRESS-${String(i).padStart(2, "0")}`, smokeSource: "并发测试锭" });
    }
    await call("POST", "/api/items", "admin", { code: "STRESS-ITEM", smokeSource: "墨锭竞争锭" });
    await call("POST", "/api/items", "admin", { code: "STRESS-BOTH", smokeSource: "双重竞争锭" });

    const rejectsBefore = boot.stats.conflictRejects;
    for (const scenario of ["station", "item", "both"]) {
      const [s, e] = scenario === "station"
        ? ["2026-11-01T01:00:00.000Z", "2026-11-01T02:00:00.000Z"]
        : scenario === "item"
          ? ["2026-11-02T01:00:00.000Z", "2026-11-02T02:00:00.000Z"]
          : ["2026-11-03T01:00:00.000Z", "2026-11-03T02:00:00.000Z"];
      const results = await runStress(scenario, s, e, 8);
      const winners = results.filter(x => x.status === 201);
      const losers = results.filter(x => x.status === 409 && x.error === "conflict");
      console.log(`    ${scenario}: 成功 ${winners.length}，409 冲突 ${losers.length}，其他 ${results.length - winners.length - losers.length}`);
      ok(winners.length === 1, `[${scenario}] 并发 8 请求恰有 1 个成功`, `实际 ${winners.length}`);
      ok(losers.length === 7, `[${scenario}] 其余 7 个返回 409 conflict`, `实际 ${losers.length}`);
      ok(winners.every(w => w.conflicts === null), "成功响应不带冲突明细");
      ok(losers.every(l => Array.isArray(l.conflicts) && l.conflicts.length >= 1), "失败响应带冲突明细（供前端提示）");
    }

    boot = (await call("GET", "/api/bootstrap")).data;
    ok(boot.stats.conflictRejects - rejectsBefore >= 21, "冲突拦截计数器累加（21+）", `增量 ${boot.stats.conflictRejects - rejectsBefore}`);
    ok(boot.stats.activeConflicts === 0, "看板当前冲突数为 0（占用表始终自洽）");

    // 回滚原子性：失败者不得留下计划 / 审计 / 占用（三个场景各恰有 1 个胜者）
    const stressPlans = boot.plans.filter(p => ["ST-01", "ST-02", "ST-03"].includes(p.stationId) && p.start?.startsWith("2026-11-"));
    const planCount = stressPlans.length;
    const occNov = boot.occupancy.filter(o => o.start?.startsWith("2026-11-"));
    ok(planCount === 3, `失败者无计划残留（11月压测计划=3：每场景唯一胜者）`, `实际 ${planCount}`);
    ok(occNov.length === 3, `失败者无占用残留（11月占用=3）`, `实际 ${occNov.length}`);

    const ev = await call("GET", "/api/events");
    const stressCreateEvents = ev.data.events.filter(e => e.action === "plan_created" && e.planId && boot.plans.some(p => p.id === e.planId && p.start?.startsWith("2026-11-")));
    ok(stressCreateEvents.length === 3, `失败者无审计残留（11月 plan_created 审计=3）`, `实际 ${stressCreateEvents.length}`);

    /* ---------- 6. 边界时段：相邻不重叠 / 首尾相接 双成功 ---------- */
    console.log("\n[6] 时段边界语义（半开区间 [start,end)）");
    // station 胜者占了 11-01 01:00–02:00 的 ST-01
    // 边界用例各自使用独立墨锭，只检验台位 ST-01 的时段语义
    const edgeCodes = ["EDGE-A", "EDGE-B", "EDGE-C"];
    for (const c of edgeCodes) await call("POST", "/api/items", "admin", { code: c, smokeSource: "边界测试锭" });
    const edgeCases = [
      { name: "恰在 02:00 开始（首尾相接）", code: "EDGE-A", start: "2026-11-01T02:00:00.000Z", end: "2026-11-01T03:00:00.000Z", expect: 201 },
      { name: "00:00–01:00 紧邻前段", code: "EDGE-B", start: "2026-11-01T00:00:00.000Z", end: "2026-11-01T01:00:00.000Z", expect: 201 },
      { name: "01:59 压入一分钟重叠", code: "EDGE-C", start: "2026-11-01T01:59:00.000Z", end: "2026-11-01T02:30:00.000Z", expect: 409 },
    ];
    for (const tc of edgeCases) {
      r = await call("POST", "/api/plans", "u3", validPlan({
        operatorId: "u3", reviewerId: "u2", stationId: "ST-01",
        itemCode: tc.code, start: tc.start, end: tc.end, submit: true,
      }));
      ok(r.status === tc.expect, `${tc.name} → ${tc.expect}`, `实际 ${r.status}`);
    }

    /* ---------- 7. 并发读写刷新一致性 ---------- */
    console.log("\n[7] 并发写期间持续读取（刷新一致性）");
    const readerSeen = [];
    const readers = [];
    for (let i = 0; i < 6; i++) {
      readers.push((async () => {
        for (let k = 0; k < 5; k++) {
          const g = await call("GET", "/api/bootstrap");
          // 不变量：占用与活跃计划一一对应、无重复键、哈希链有效
          const active = g.data.plans.filter(p => ["pending", "approved", "running", "cancel_review"].includes(p.status));
          const ids = g.data.occupancy.map(o => o.planId);
          const sameSet = ids.length === active.length && ids.every(id => active.some(p => p.id === id));
          const noDup = new Set(ids).size === ids.length;
          const parsed = g.data.plans.every(p => p.id && p.status);
          readerSeen.push(sameSet && noDup && parsed && g.data.chainValid);
        }
      })());
    }
    const writers = [];
    for (let i = 0; i < 6; i++) {
      writers.push((async () => {
        const [s, e] = ["2026-12-01T0" + (i + 1) + ":00:00.000Z", "2026-12-01T0" + (i + 2) + ":00:00.000Z"];
        await call("POST", "/api/plans", "u1", validPlan({
          stationId: "ST-03", itemCode: "IS-001", start: s, end: e, submit: false,
          note: `consistency-${i}`,
        }));
      })());
    }
    await Promise.all([...readers, ...writers]);
    ok(readerSeen.length === 30 && readerSeen.every(Boolean), "30 次并发读取全部观察到自洽状态（占用↔计划一致、chainValid=true）", `异常次数 ${readerSeen.filter(x => !x).length}`);

    /* ---------- 8. 审计链完整性与篡改检测 ---------- */
    console.log("\n[8] 审计哈希链");
    const { events, chainValid } = (await call("GET", "/api/events")).data;
    ok(chainValid, `服务端校验全链通过（${events.length} 条）`);
    // 本地独立重算
    const sha = (t) => createHash("sha256").update(t, "utf8").digest("hex");
    let prev = "0".repeat(64);
    let localOk = true;
    for (let i = 0; i < events.length; i++) {
      const e = events[i];
      const h = sha([e.seq, e.ts, e.planId, e.action, e.actorId, JSON.stringify(e.detail), prev].join("|"));
      if (e.seq !== i + 1 || e.prevHash !== prev || e.hash !== h) { localOk = false; break; }
      prev = h;
    }
    ok(localOk, "客户端独立重算哈希链一致");

    // 篡改一条记录 → 链失效
    const tampered = JSON.parse(JSON.stringify(events));
    tampered[Math.floor(tampered.length / 2)].detail = { hacked: true };
    let tPrev = "0".repeat(64); let tamperedOk = true;
    for (let i = 0; i < tampered.length; i++) {
      const e = tampered[i];
      const h = sha([e.seq, e.ts, e.planId, e.action, e.actorId, JSON.stringify(e.detail), tPrev].join("|"));
      if (e.hash !== h) { tamperedOk = false; break; }
      tPrev = e.hash;
    }
    ok(!tamperedOk, "篡改任意一条 detail 即被哈希链检出");

    // 计划级审计按序包含完整动作
    const planEvents = events.filter(e => e.planId === draftId).map(e => e.action);
    const expectedTail = ["plan_created", "plan_edited", "plan_submitted", "review_rejected", "plan_edited", "plan_submitted", "review_approved", "plan_started",
      "cancel_requested", "cancel_rejected", "cancel_requested", "cancel_confirmed"];
    ok(expectedTail.every((a, i) => planEvents[i] === a) && planEvents.length === expectedTail.length,
      "取消计划的完整动作链齐全且有序", planEvents.join(" → "));

    /* ---------- 9. 逾期提醒 ---------- */
    console.log("\n[9] 逾期统计");
    r = await call("POST", "/api/plans", "u3", validPlan({
      operatorId: "u3", reviewerId: "u2", stationId: "ST-01",
      itemCode: "IS-002",
      start: "2026-09-10T01:00:00.000Z", end: "2026-09-10T02:00:00.000Z", submit: true,
    }));
    ok(r.status === 201, "创建一条已过期的待审核排期");
    const overduePlan = r.data.plan.id;
    boot = (await call("GET", "/api/bootstrap")).data;
    const overdueEntry = boot.stats.overdue.find(o => o.id === overduePlan);
    ok(boot.stats.overdueCount >= 1 && overdueEntry && overdueEntry.kind === "overdue_not_started", "逾期未开始进入逾期清单");

    await call("POST", `/api/plans/${overduePlan}/review`, "u2", { decision: "approved" });
    await call("POST", `/api/plans/${overduePlan}/start`, "u3", {});
    boot = (await call("GET", "/api/bootstrap")).data;
    const runningEntry = boot.stats.overdue.find(o => o.id === overduePlan);
    ok(runningEntry && runningEntry.kind === "overdue_running", "开始后变为「执行逾期」类型");

    /* ---------- 10. 草稿冲突预览数据 & 草稿删除 ---------- */
    console.log("\n[10] 其它不变量");
    r = await call("POST", "/api/plans", "u1", validPlan({ submit: false }));
    const dId2 = r.data.plan.id;
    boot = (await call("GET", "/api/bootstrap")).data;
    ok(boot.occupancy.every(o => o.planId !== dId2), "新草稿不进入占用");
    // 占用窗口存在时，另一草稿可保存，但提交会 409 且草稿保持草稿态
    r = await call("POST", "/api/plans", "u1", validPlan({
      stationId: "ST-01", itemCode: "IS-001",
      start: "2026-11-01T01:30:00.000Z", end: "2026-11-01T01:45:00.000Z", submit: true,
    }));
    ok(r.status === 409 && r.data.error === "conflict", "提交撞占用 → 409");
    boot = (await call("GET", "/api/bootstrap")).data;
    const ghost = boot.plans.find(p => p.start === "2026-11-01T01:30:00.000Z");
    ok(!ghost, "冲突提交整体回滚：连计划行都不存在（无半落盘）");

    r = await call("DELETE", `/api/plans/${dId2}`, "u2");
    ok(r.status === 403, "他人不能删除草稿 (403)");
    r = await call("DELETE", `/api/plans/${dId2}`, "u1");
    ok(r.status === 200, "操作人删除草稿成功");
    const ev2 = (await call("GET", `/api/events?planId=${dId2}`)).data;
    ok(ev2.events.some(e => e.action === "plan_deleted"), "删除草稿也留审计");

  } finally {
    server.kill("SIGTERM");
    // 保留数据库可现场查看；如需清理可手动删 data/test-*.json
  }

  console.log(`\n${"=".repeat(56)}`);
  console.log(`结果：\x1b[32m${pass} 通过\x1b[0m，\x1b[${fail ? "31" : "32"}m${fail} 失败\x1b[0m`);
  if (fail) { failures.forEach(f => console.log("  FAIL: " + f)); process.exit(1); }
  console.log(`测试数据库：${TEST_DB}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
