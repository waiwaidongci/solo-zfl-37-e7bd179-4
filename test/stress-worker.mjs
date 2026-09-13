// 并发压测子进程：向同一个台位/墨锭时段发起「创建并提交」请求，输出 JSON 结果。
// 用法：node test/stress-worker.mjs <baseUrl> <workerId> <scenario> [startISO] [endISO]
const base = process.argv[2];
const workerId = Number(process.argv[3]);
const scenario = process.argv[4];
const start = process.argv[5] || "2026-10-01T01:00:00.000Z";
const end = process.argv[6] || "2026-10-01T02:00:00.000Z";

// 每个 worker 使用不同操作人（3 名试墨师循环），复核人永远是另一个人
const operatorId = `u${(workerId % 3) + 1}`;
const reviewerId = operatorId === "u1" ? "u2" : "u1";

// station 场景：墨锭互不相同、台位相同 → 只有台位竞争
// item    场景：墨锭相同、台位互不相同 → 只有墨锭并行互斥
// both    场景：墨锭与台位都相同
const scenarios = {
  station: { itemCode: `STRESS-${String(workerId).padStart(2, "0")}`, stationId: "ST-01" },
  item:    { itemCode: "STRESS-ITEM", stationId: `ST-0${(workerId % 3) + 1}` },
  both:    { itemCode: "STRESS-BOTH", stationId: "ST-02" },
};
const s = scenarios[scenario];

const body = {
  ...s,
  operatorId,
  reviewerId,
  start,
  end,
  params: { paper: "净皮宣纸", waterDrops: 20, grindMinutes: 30, pressure: "中力", targetScore: 85 },
  submit: true,
};

try {
  const res = await fetch(`${base}/api/plans`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-User-Id": operatorId },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  console.log(JSON.stringify({ workerId, status: res.status, planId: data.plan?.id || null, error: data.error || null, conflicts: data.conflicts || null }));
} catch (e) {
  console.log(JSON.stringify({ workerId, status: 0, error: String(e.message || e), planId: null }));
}
