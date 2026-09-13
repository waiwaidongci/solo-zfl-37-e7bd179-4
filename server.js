import http from "node:http";
import { open, readFile, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
const dbPath = process.env.INK_DB || join(__dirname, "data", "ink-stick-testing.json");
const port = Number(process.env.PORT || 3037);

/* ------------------------------------------------------------------ */
/* 领域常量                                                            */
/* ------------------------------------------------------------------ */

export const STATUSES = ["draft", "pending", "approved", "rejected", "running", "cancel_review", "completed", "cancelled"];
export const STATUS_LABEL = {
  draft: "草稿",
  pending: "待审核",
  approved: "已批准",
  rejected: "已驳回",
  running: "执行中",
  cancel_review: "待取消复核",
  completed: "已完成",
  cancelled: "已取消",
};
const ACTIVE_STATUSES = ["pending", "approved", "running", "cancel_review"];

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

class HttpError extends Error {
  constructor(status, code, details = undefined) {
    super(code);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/* ------------------------------------------------------------------ */
/* 种子数据                                                            */
/* ------------------------------------------------------------------ */

function buildSeed() {
  const db = {
    version: 2,
    seq: 2,
    metrics: { conflictRejects: 0 },
    users: [
      { id: "u1", name: "墨雁", role: "试墨师" },
      { id: "u2", name: "青岫", role: "复核师" },
      { id: "u3", name: "松韵", role: "试墨师" },
      { id: "admin", name: "玄伯（室长）", role: "管理员" },
    ],
    stations: [
      { id: "ST-01", name: "青玉案研台" },
      { id: "ST-02", name: "紫檀研台" },
      { id: "ST-03", name: "精研防尘台" },
    ],
    items: [
      { code: "IS-001", smokeSource: "黄山松烟", glueRatio: "7.5%", ageYears: 8, storage: "恒湿柜B" },
      { code: "IS-002", smokeSource: "桐油烟", glueRatio: "8%", ageYears: 3, storage: "试样盒C" },
      { code: "IS-003", smokeSource: "漆烟", glueRatio: "7%", ageYears: 12, storage: "恒湿柜A" },
    ],
    plans: [],
    occupancy: [],
    events: [],
  };

  const append = (e) => {
    const prevHash = db.events.length ? db.events[db.events.length - 1].hash : "0".repeat(64);
    const payload = [e.seq, e.ts, e.planId, e.action, e.actorId, JSON.stringify(e.detail), prevHash].join("|");
    e.prevHash = prevHash;
    e.hash = sha256(payload);
    db.events.push(e);
  };

  const p1 = {
    id: "PL-0001",
    itemCode: "IS-001",
    operatorId: "u1",
    reviewerId: "u2",
    stationId: "ST-01",
    start: "2026-09-20T01:00:00.000Z",
    end: "2026-09-20T02:30:00.000Z",
    params: { paper: "净皮宣纸", waterDrops: 20, grindMinutes: 40, pressure: "中力", targetScore: 85, note: "隔年陈墨先醒 5 分钟" },
    status: "approved",
    reason: "",
    result: "",
    cancelReason: "",
    createdAt: "2026-09-10T08:00:00.000Z",
    createdBy: "u1",
    updatedAt: "2026-09-11T03:10:00.000Z",
    submittedAt: "2026-09-10T08:05:00.000Z",
    decidedAt: "2026-09-11T03:10:00.000Z",
    decidedBy: "u2",
    startedAt: null,
    completedAt: null,
    cancelRequestedAt: null,
    cancelRequestedBy: null,
    cancelDecidedAt: null,
    cancelDecidedBy: null,
  };
  const p2 = {
    id: "PL-0002",
    itemCode: "IS-002",
    operatorId: "u3",
    reviewerId: "u1",
    stationId: "ST-02",
    start: "2026-09-21T06:00:00.000Z",
    end: "2026-09-21T07:00:00.000Z",
    params: { paper: "云母宣", waterDrops: 16, grindMinutes: 30, pressure: "轻力", targetScore: 80, note: "" },
    status: "pending",
    reason: "",
    result: "",
    cancelReason: "",
    createdAt: "2026-09-12T09:00:00.000Z",
    createdBy: "u3",
    updatedAt: "2026-09-12T09:00:00.000Z",
    submittedAt: "2026-09-12T09:00:00.000Z",
    decidedAt: null,
    decidedBy: null,
    startedAt: null,
    completedAt: null,
    cancelRequestedAt: null,
    cancelRequestedBy: null,
    cancelDecidedAt: null,
    cancelDecidedBy: null,
  };
  db.plans.push(p1, p2);
  db.occupancy.push(
    { planId: p1.id, itemCode: p1.itemCode, stationId: p1.stationId, start: p1.start, end: p1.end },
    { planId: p2.id, itemCode: p2.itemCode, stationId: p2.stationId, start: p2.start, end: p2.end },
  );

  let seq = 0;
  for (const [plan, actions] of [
    [p1, [
      { ts: p1.createdAt, action: "plan_created", actorId: "u1", detail: { snapshot: "seed" } },
      { ts: p1.submittedAt, action: "plan_submitted", actorId: "u1", detail: {} },
      { ts: p1.decidedAt, action: "review_approved", actorId: "u2", detail: {} },
    ]],
    [p2, [
      { ts: p2.createdAt, action: "plan_created", actorId: "u3", detail: { snapshot: "seed" } },
      { ts: p2.submittedAt, action: "plan_submitted", actorId: "u3", detail: { resubmit: false } },
    ]],
  ]) {
    for (const a of actions) append({ seq: ++seq, ts: a.ts, planId: plan.id, action: a.action, actorId: a.actorId, detail: a.detail });
  }
  return db;
}

/* ------------------------------------------------------------------ */
/* 原子存储：单进程写互斥 + 临时文件 fsync + rename 提交                */
/* ------------------------------------------------------------------ */

let cache = null;
let queueTail = Promise.resolve();
let tmpCounter = 0;

function withLock() {
  const prev = queueTail;
  let release;
  queueTail = new Promise((resolve) => { release = resolve; });
  return prev.then(() => release);
}

async function initDb() {
  if (!existsSync(dbPath)) {
    await mkdir(dirname(dbPath), { recursive: true });
    await persist(buildSeed());
  }
  cache = JSON.parse(await readFile(dbPath, "utf8"));
  if (!cache.version || cache.version < 2) {
    cache = buildSeed();
    await persist(cache);
  }
  cache.metrics ||= { conflictRejects: 0 };
}

async function persist(db) {
  const tmp = `${dbPath}.tmp.${process.pid}.${tmpCounter++}`;
  const fh = await open(tmp, "wx");
  try {
    await fh.writeFile(JSON.stringify(db, null, 2), "utf8");
    await fh.sync(); // 落盘后再 rename，保证崩溃也不会出现半文件
  } finally {
    await fh.close();
  }
  await rename(tmp, dbPath); // 同目录原子替换
}

/**
 * 在写锁内执行：深拷贝快照 → 业务变更（抛错即整体丢弃）→ 原子落盘 → 提交内存态。
 * 任何失败路径都不会写入状态、审计或占用。
 */
async function mutate(fn) {
  const release = await withLock();
  try {
    const db = structuredClone(cache);
    const out = fn(db);
    await persist(db);
    cache = db;
    return out;
  } finally {
    release();
  }
}

const readDb = () => cache;

/* ------------------------------------------------------------------ */
/* 审计链（仅追加，sha256 哈希链）                                     */
/* ------------------------------------------------------------------ */

function appendEvent(db, { planId = null, action, actorId, detail = {} }) {
  const seq = db.events.length + 1;
  const ts = new Date().toISOString();
  const prevHash = db.events.length ? db.events[db.events.length - 1].hash : "0".repeat(64);
  const e = { seq, ts, planId, action, actorId, detail, prevHash };
  e.hash = sha256([seq, ts, planId, action, actorId, JSON.stringify(detail), prevHash].join("|"));
  db.events.push(e);
  return e;
}

export function verifyChain(events) {
  let prevHash = "0".repeat(64);
  for (let idx = 0; idx < events.length; idx++) {
    const e = events[idx];
    const expect = sha256([e.seq, e.ts, e.planId, e.action, e.actorId, JSON.stringify(e.detail), prevHash].join("|"));
    if (e.seq !== idx + 1 || e.prevHash !== prevHash || e.hash !== expect) return false;
    prevHash = e.hash;
  }
  return true;
}

/* ------------------------------------------------------------------ */
/* 领域规则                                                            */
/* ------------------------------------------------------------------ */

const overlap = (aStart, aEnd, bStart, bEnd) => aStart < bEnd && aEnd > bStart;

/** 返回与给定占用需求冲突的占用行（墨锭并行占用 或 同台位时段重叠）。 */
function findConflicts(db, { itemCode, stationId, start, end }, excludePlanId = null) {
  const s = Date.parse(start);
  const e = Date.parse(end);
  const conflicts = [];
  for (const occ of db.occupancy) {
    if (occ.planId === excludePlanId) continue;
    if (!overlap(s, e, Date.parse(occ.start), Date.parse(occ.end))) continue;
    const plan = db.plans.find((p) => p.id === occ.planId);
    if (occ.itemCode === itemCode || occ.stationId === stationId) {
      conflicts.push({
        planId: occ.planId,
        reason: occ.itemCode === itemCode ? "item_busy" : "station_busy",
        itemCode: occ.itemCode,
        stationId: occ.stationId,
        start: occ.start,
        end: occ.end,
        status: plan ? plan.status : null,
      });
    }
  }
  return conflicts;
}

function requireUser(db, actorId) {
  const user = db.users.find((u) => u.id === actorId);
  if (!user) throw new HttpError(401, "unauthorized");
  return user;
}
const isAdmin = (db, userId) => db.users.find((u) => u.id === userId)?.role === "管理员";

function parsePlanInput(db, input) {
  const str = (v) => (v == null ? "" : String(v).trim());
  const itemCode = str(input.itemCode);
  const operatorId = str(input.operatorId);
  const reviewerId = str(input.reviewerId);
  const stationId = str(input.stationId);
  const start = str(input.start);
  const end = str(input.end);
  if (!itemCode || !db.items.some((i) => i.code === itemCode)) throw new HttpError(400, "bad_item");
  if (!operatorId || !db.users.some((u) => u.id === operatorId)) throw new HttpError(400, "bad_operator");
  if (!stationId || !db.stations.some((s) => s.id === stationId)) throw new HttpError(400, "bad_station");
  const s = Date.parse(start);
  const t = Date.parse(end);
  if (Number.isNaN(s) || Number.isNaN(t)) throw new HttpError(400, "bad_time");
  if (t <= s) throw new HttpError(400, "end_before_start");
  const params = {
    paper: str(input.params?.paper),
    waterDrops: Number(input.params?.waterDrops) || 0,
    grindMinutes: Number(input.params?.grindMinutes) || 0,
    pressure: str(input.params?.pressure),
    targetScore: Number(input.params?.targetScore) || 0,
    note: str(input.params?.note),
  };
  return { itemCode, operatorId, reviewerId, stationId, start: new Date(s).toISOString(), end: new Date(t).toISOString(), params };
}

function planView(db, p) {
  const user = (id) => db.users.find((u) => u.id === id) || null;
  return {
    ...p,
    operator: user(p.operatorId),
    reviewer: user(p.reviewerId),
    station: db.stations.find((s) => s.id === p.stationId) || null,
    item: db.items.find((i) => i.code === p.itemCode) || null,
  };
}

/* ------------------------------------------------------------------ */
/* 命令处理（全部在 mutate 内，失败整体回滚）                          */
/* ------------------------------------------------------------------ */

function cmdCreatePlan(db, input, actorId) {
  requireUser(db, actorId);
  const fields = parsePlanInput(db, input);
  const wantSubmit = Boolean(input.submit);

  if (wantSubmit) {
    if (!fields.reviewerId || !db.users.some((u) => u.id === fields.reviewerId)) throw new HttpError(400, "bad_reviewer");
    if (fields.reviewerId === fields.operatorId) throw new HttpError(400, "reviewer_is_operator");
  }

  const id = `PL-${String(++db.seq).padStart(4, "0")}`;
  const now = new Date().toISOString();
  const plan = {
    id,
    ...fields,
    reviewerId: fields.reviewerId || "",
    status: wantSubmit ? "pending" : "draft",
    reason: "",
    result: "",
    cancelReason: "",
    createdAt: now,
    createdBy: actorId,
    updatedAt: now,
    submittedAt: null,
    decidedAt: null,
    decidedBy: null,
    startedAt: null,
    completedAt: null,
    cancelRequestedAt: null,
    cancelRequestedBy: null,
    cancelDecidedAt: null,
    cancelDecidedBy: null,
  };

  if (wantSubmit) {
    // 冲突检测与占用写入在同一事务内：并发下只有一个事务能走到这里
    const conflicts = findConflicts(db, fields);
    if (conflicts.length) {
      db.metrics.conflictRejects += 1; // 与“拒绝”一起原子落盘的只有计数器，不含任何计划/审计/占用
      return { rejected: true, conflicts };
    }
    db.occupancy.push({ planId: id, itemCode: fields.itemCode, stationId: fields.stationId, start: fields.start, end: fields.end });
    plan.submittedAt = now;
  }

  db.plans.push(plan);
  appendEvent(db, { planId: id, action: "plan_created", actorId, detail: { by: actorId, submit: wantSubmit } });
  if (wantSubmit) appendEvent(db, { planId: id, action: "plan_submitted", actorId, detail: { resubmit: false } });
  return { rejected: false, plan };
}

function cmdUpdateDraft(db, id, input, actorId) {
  requireUser(db, actorId);
  const plan = db.plans.find((p) => p.id === id);
  if (!plan) throw new HttpError(404, "plan_not_found");
  if (!["draft", "rejected"].includes(plan.status)) throw new HttpError(409, "not_editable");
  if (plan.operatorId !== actorId && !isAdmin(db, actorId)) throw new HttpError(403, "forbidden");
  const fields = parsePlanInput(db, { ...plan, ...input, params: { ...plan.params, ...(input.params || {}) } });
  if (fields.reviewerId && !db.users.some((u) => u.id === fields.reviewerId)) throw new HttpError(400, "bad_reviewer");
  if (fields.reviewerId && fields.reviewerId === fields.operatorId) throw new HttpError(400, "reviewer_is_operator");
  Object.assign(plan, fields);
  if (input.reviewerId !== undefined) plan.reviewerId = fields.reviewerId;
  plan.updatedAt = new Date().toISOString();
  appendEvent(db, { planId: id, action: "plan_edited", actorId, detail: { fields } });
  return { plan };
}

function cmdSubmit(db, id, actorId) {
  requireUser(db, actorId);
  const plan = db.plans.find((p) => p.id === id);
  if (!plan) throw new HttpError(404, "plan_not_found");
  if (!["draft", "rejected"].includes(plan.status)) throw new HttpError(409, "not_submittable");
  if (plan.operatorId !== actorId && !isAdmin(db, actorId)) throw new HttpError(403, "forbidden");
  if (!plan.reviewerId) throw new HttpError(400, "reviewer_required");
  if (plan.reviewerId === plan.operatorId) throw new HttpError(400, "reviewer_is_operator");

  const wasRejected = plan.status === "rejected";
  const conflicts = findConflicts(db, plan);
  if (conflicts.length) {
    db.metrics.conflictRejects += 1;
    return { rejected: true, conflicts };
  }
  const now = new Date().toISOString();
  plan.status = "pending";
  plan.reason = "";
  plan.submittedAt = now;
  plan.decidedAt = null;
  plan.decidedBy = null;
  plan.updatedAt = now;
  db.occupancy.push({ planId: plan.id, itemCode: plan.itemCode, stationId: plan.stationId, start: plan.start, end: plan.end });
  appendEvent(db, { planId: id, action: "plan_submitted", actorId, detail: { resubmit: wasRejected } });
  return { rejected: false, plan };
}

function cmdReview(db, id, body, actorId) {
  requireUser(db, actorId);
  const plan = db.plans.find((p) => p.id === id);
  if (!plan) throw new HttpError(404, "plan_not_found");
  if (plan.status !== "pending") throw new HttpError(409, "not_pending");
  // 任何人都不能审核自己操作的计划（优先于指派校验，返回明确错误码）
  if (plan.operatorId === actorId) throw new HttpError(403, "reviewer_is_operator");
  // 审核人必须是指派复核人或管理员
  if (plan.reviewerId !== actorId && !isAdmin(db, actorId)) throw new HttpError(403, "forbidden");

  const decision = String(body.decision || "");
  const reason = String(body.reason || "").trim();
  if (!["approved", "rejected"].includes(decision)) throw new HttpError(400, "bad_decision");
  if (decision === "rejected" && !reason) throw new HttpError(400, "reason_required");

  const now = new Date().toISOString();
  plan.decidedAt = now;
  plan.decidedBy = actorId;
  plan.updatedAt = now;
  if (decision === "approved") {
    plan.status = "approved";
    appendEvent(db, { planId: id, action: "review_approved", actorId, detail: {} });
  } else {
    plan.status = "rejected";
    plan.reason = reason;
    // 驳回释放预占，供其他计划使用
    db.occupancy = db.occupancy.filter((o) => o.planId !== id);
    appendEvent(db, { planId: id, action: "review_rejected", actorId, detail: { reason } });
  }
  return { plan };
}

function cmdStart(db, id, actorId) {
  requireUser(db, actorId);
  const plan = db.plans.find((p) => p.id === id);
  if (!plan) throw new HttpError(404, "plan_not_found");
  if (plan.status !== "approved") throw new HttpError(409, "not_approved");
  if (plan.operatorId !== actorId && !isAdmin(db, actorId)) throw new HttpError(403, "forbidden");
  const now = new Date().toISOString();
  plan.status = "running";
  plan.startedAt = now;
  plan.updatedAt = now;
  appendEvent(db, { planId: id, action: "plan_started", actorId, detail: {} });
  return { plan };
}

function cmdComplete(db, id, body, actorId) {
  requireUser(db, actorId);
  const plan = db.plans.find((p) => p.id === id);
  if (!plan) throw new HttpError(404, "plan_not_found");
  if (plan.status !== "running") throw new HttpError(409, "not_running");
  if (plan.operatorId !== actorId && !isAdmin(db, actorId)) throw new HttpError(403, "forbidden");
  const now = new Date().toISOString();
  plan.status = "completed";
  plan.result = String(body.result || "").trim();
  plan.completedAt = now;
  plan.updatedAt = now;
  db.occupancy = db.occupancy.filter((o) => o.planId !== id);
  appendEvent(db, { planId: id, action: "plan_completed", actorId, detail: { result: plan.result } });
  return { plan };
}

function cmdCancelRequest(db, id, body, actorId) {
  requireUser(db, actorId);
  const plan = db.plans.find((p) => p.id === id);
  if (!plan) throw new HttpError(404, "plan_not_found");
  if (!["approved", "running"].includes(plan.status)) throw new HttpError(409, "not_cancellable");
  if (plan.operatorId !== actorId && !isAdmin(db, actorId)) throw new HttpError(403, "forbidden");
  const reason = String(body.reason || "").trim();
  if (!reason) throw new HttpError(400, "reason_required");

  const now = new Date().toISOString();
  plan.cancelReason = reason;
  plan.cancelRequestedAt = now;
  plan.cancelRequestedBy = actorId;
  plan.updatedAt = now;
  appendEvent(db, { planId: id, action: "cancel_requested", actorId, detail: { reason, phase: plan.status } });

  if (plan.status === "approved") {
    // 未开始：登记即取消，释放占用
    plan.status = "cancelled";
    plan.cancelDecidedAt = now;
    plan.cancelDecidedBy = actorId;
    db.occupancy = db.occupancy.filter((o) => o.planId !== id);
    appendEvent(db, { planId: id, action: "cancel_confirmed", actorId, detail: { beforeStart: true } });
  } else {
    // 已开始：进入第二人复核
    plan.status = "cancel_review";
  }
  return { plan };
}

function cmdCancelReview(db, id, body, actorId) {
  requireUser(db, actorId);
  const plan = db.plans.find((p) => p.id === id);
  if (!plan) throw new HttpError(404, "plan_not_found");
  if (plan.status !== "cancel_review") throw new HttpError(409, "not_in_cancel_review");
  // 双人复核：复核人不能是取消申请人本人
  if (plan.cancelRequestedBy === actorId) throw new HttpError(403, "reviewer_is_requester");
  if (plan.reviewerId !== actorId && !isAdmin(db, actorId)) throw new HttpError(403, "forbidden");

  const decision = String(body.decision || "");
  const reason = String(body.reason || "").trim();
  if (!["confirmed", "rejected"].includes(decision)) throw new HttpError(400, "bad_decision");
  if (decision === "rejected" && !reason) throw new HttpError(400, "reason_required");

  const now = new Date().toISOString();
  plan.cancelDecidedAt = now;
  plan.cancelDecidedBy = actorId;
  plan.updatedAt = now;
  if (decision === "confirmed") {
    plan.status = "cancelled";
    db.occupancy = db.occupancy.filter((o) => o.planId !== id);
    appendEvent(db, { planId: id, action: "cancel_confirmed", actorId, detail: {} });
  } else {
    plan.status = "running";
    appendEvent(db, { planId: id, action: "cancel_rejected", actorId, detail: { reason } });
  }
  return { plan };
}

function cmdDeleteDraft(db, id, actorId) {
  requireUser(db, actorId);
  const plan = db.plans.find((p) => p.id === id);
  if (!plan) throw new HttpError(404, "plan_not_found");
  if (plan.status !== "draft") throw new HttpError(409, "only_draft_deletable");
  if (plan.operatorId !== actorId && !isAdmin(db, actorId)) throw new HttpError(403, "forbidden");
  db.plans = db.plans.filter((p) => p.id !== id);
  db.occupancy = db.occupancy.filter((o) => o.planId !== id);
  appendEvent(db, { planId: id, action: "plan_deleted", actorId, detail: {} });
  return { ok: true };
}

function cmdCreateItem(db, input, actorId) {
  requireUser(db, actorId);
  const code = String(input.code || "").trim();
  if (!code) throw new HttpError(400, "code_required");
  if (db.items.some((i) => i.code === code)) throw new HttpError(409, "item_exists");
  const item = {
    code,
    smokeSource: String(input.smokeSource || "").trim(),
    glueRatio: String(input.glueRatio || "").trim(),
    ageYears: Number(input.ageYears) || 0,
    storage: String(input.storage || "").trim(),
  };
  db.items.push(item);
  appendEvent(db, { action: "item_created", actorId, detail: { code } });
  return { item };
}

/* ------------------------------------------------------------------ */
/* 看板汇总                                                            */
/* ------------------------------------------------------------------ */

function buildBootstrap(db) {
  const now = Date.now();
  const occIndex = new Map(db.occupancy.map((o) => [o.planId, o]));

  // 活跃计划之间的成对冲突（正常情况下应恒为 0，用于看板醒目提示）
  const conflictPairs = [];
  const active = db.plans.filter((p) => ACTIVE_STATUSES.includes(p.status));
  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const a = occIndex.get(active[i].id);
      const b = occIndex.get(active[j].id);
      if (!a || !b) continue;
      if (overlap(Date.parse(a.start), Date.parse(a.end), Date.parse(b.start), Date.parse(b.end)) &&
          (a.itemCode === b.itemCode || a.stationId === b.stationId)) {
        conflictPairs.push([a.planId, b.planId]);
      }
    }
  }
  const conflictPlanIds = new Set(conflictPairs.flat());
  const overdue = active
    .filter((p) => Date.parse(p.end) < now)
    .map((p) => ({ id: p.id, kind: p.status === "running" ? "overdue_running" : "overdue_not_started", end: p.end }));

  const statusCounts = Object.fromEntries(STATUSES.map((s) => [s, 0]));
  for (const p of db.plans) statusCounts[p.status] += 1;

  return {
    serverTime: new Date(now).toISOString(),
    users: db.users,
    stations: db.stations,
    items: db.items,
    plans: db.plans.map((p) => planView(db, p)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    occupancy: db.occupancy,
    stats: {
      statusCounts,
      activeConflicts: conflictPairs.length,
      conflictPlanCount: conflictPlanIds.size,
      conflictRejects: db.metrics.conflictRejects,
      overdueCount: overdue.length,
      overdue,
    },
    chainValid: verifyChain(db.events),
  };
}

/* ------------------------------------------------------------------ */
/* HTTP                                                                */
/* ------------------------------------------------------------------ */

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "bad_json");
  }
}
function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const actorId = String(req.headers["x-user-id"] || "").trim();

    if (req.method === "GET" && url.pathname === "/") {
      const page = await readFile(join(__dirname, "public", "index.html"), "utf8");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(page);
    }

    if (req.method === "GET" && url.pathname === "/api/bootstrap") {
      return sendJson(res, 200, buildBootstrap(readDb()));
    }

    if (req.method === "GET" && url.pathname === "/api/events") {
      const planId = url.searchParams.get("planId");
      const events = planId ? readDb().events.filter((e) => e.planId === planId) : readDb().events;
      return sendJson(res, 200, { events, chainValid: verifyChain(events) });
    }

    if (req.method === "POST" && url.pathname === "/api/items") {
      const body = await readBody(req);
      const out = await mutate((db) => cmdCreateItem(db, body, actorId));
      return sendJson(res, 201, out);
    }

    if (req.method === "POST" && url.pathname === "/api/plans") {
      const body = await readBody(req);
      const out = await mutate((db) => cmdCreatePlan(db, body, actorId));
      if (out.rejected) return sendJson(res, 409, { error: "conflict", conflicts: out.conflicts });
      return sendJson(res, 201, { plan: planView(readDb(), out.plan) });
    }

    const planRoute = url.pathname.match(/^\/api\/plans\/([^/]+)(\/([a-z-]+))?$/);
    if (planRoute) {
      const id = decodeURIComponent(planRoute[1]);
      const action = planRoute[3] || "";
      const body = ["POST", "PATCH", "DELETE"].includes(req.method) ? await readBody(req) : {};

      if (req.method === "PATCH" && action === "") {
        const out = await mutate((db) => cmdUpdateDraft(db, id, body, actorId));
        return sendJson(res, 200, { plan: planView(readDb(), out.plan) });
      }
      if (req.method === "DELETE" && action === "") {
        await mutate((db) => cmdDeleteDraft(db, id, actorId));
        return sendJson(res, 200, { ok: true });
      }
      if (req.method !== "POST") throw new HttpError(404, "not_found");

      const out = await mutate((db) => {
        switch (action) {
          case "submit": return cmdSubmit(db, id, actorId);
          case "review": return cmdReview(db, id, body, actorId);
          case "start": return cmdStart(db, id, actorId);
          case "complete": return cmdComplete(db, id, body, actorId);
          case "cancel-request": return cmdCancelRequest(db, id, body, actorId);
          case "cancel-review": return cmdCancelReview(db, id, body, actorId);
          default: throw new HttpError(404, "not_found");
        }
      });
      if (out && out.rejected) return sendJson(res, 409, { error: "conflict", conflicts: out.conflicts });
      return sendJson(res, 200, { plan: planView(readDb(), out.plan) });
    }

    sendJson(res, 404, { error: "not_found" });
  } catch (error) {
    if (error instanceof HttpError) {
      return sendJson(res, error.status, { error: error.code, details: error.details });
    }
    console.error(error);
    sendJson(res, 500, { error: "internal", message: error.message });
  }
});

initDb().then(() => {
  server.listen(port, () => console.log(`墨锭试磨室 listening on http://localhost:${port} db=${dbPath}`));
});
