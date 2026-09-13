// 真实浏览器 E2E（Playwright + Chromium）：桌面 1280 与手机 375 两个视口。
// 验证：样式生效、看板多列/单列、新建表单在当前视口内且可提交、手机能完整完成排期与双人审核、审计子集。
// 运行：需先启动服务；BASE_URL 指向测试服务。
import { chromium } from "playwright";

const BASE = process.env.BASE_URL || "http://127.0.0.1:3037";
const browser = await chromium.launch();
let pass = 0, fail = 0;
const failures = [];
function ok(cond, name, extra = "") {
  if (cond) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; failures.push(name); console.log(`  \x1b[31m✗ ${name}\x1b[0m ${extra}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 在某状态列里按墨锭编号找到卡片
async function cardInColumn(page, colKeyword, itemCode) {
  return page.evaluateHandle(({ colKeyword, itemCode }) => {
    const col = [...document.querySelectorAll(".column")].find(c => c.querySelector("h3")?.textContent.includes(colKeyword));
    if (!col) return null;
    return [...col.querySelectorAll(".card")].find(c => c.textContent.includes(itemCode)) || null;
  }, { colKeyword, itemCode });
}

async function run(label, width, height, isMobile, plan) {
  console.log(`\n[B ${label} ${width}x${height}]`);
  const page = await browser.newPage({ viewport: { width, height }, isMobile, hasTouch: isMobile });
  const consoleErrors = [];
  page.on("console", m => { if (m.type() === "error") consoleErrors.push(m.text()); });

  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForSelector(".card");

  const initial = await page.evaluate(() => ({
    boardDisplay: getComputedStyle(document.querySelector(".board")).display,
    boardDir: getComputedStyle(document.querySelector(".board")).flexDirection,
    chipsDisplay: getComputedStyle(document.querySelector(".chips")).display,
    cardBg: getComputedStyle(document.querySelector(".card")).backgroundColor,
    headerPos: getComputedStyle(document.querySelector("header")).position,
  }));
  ok(initial.boardDisplay === "flex", "看板 .board display:flex（样式已生效）", initial.boardDisplay);
  ok(initial.chipsDisplay === "flex", "统计条 .chips display:flex", initial.chipsDisplay);
  ok(initial.cardBg === "rgb(255, 255, 255)", "卡片白底样式生效", initial.cardBg);
  ok(initial.headerPos === "sticky", "顶栏 sticky 生效", initial.headerPos);
  ok(initial.boardDir === (isMobile ? "column" : "row"),
    `${label}看板方向=${initial.boardDir}（期望 ${isMobile ? "column 单列" : "row 多列"}）`);

  // 操作人身份
  await page.selectOption("#actor", plan.operator);
  await sleep(200);

  // 打开新建排期
  await page.click("#newPlanBtn");
  await page.waitForSelector("#planOverlay.open");
  await sleep(150);
  const modalPos = await page.evaluate(() => {
    const r = document.querySelector("#planForm").getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, vh: window.innerHeight, vw: window.innerWidth, width: r.width };
  });
  ok(modalPos.top >= 0 && modalPos.top < modalPos.vh, `弹层顶部在视口内（top=${Math.round(modalPos.top)} vh=${modalPos.vh}）`);
  ok(modalPos.width <= modalPos.vw + 1, `弹层不超出视口宽度（width=${Math.round(modalPos.width)} vw=${modalPos.vw}）`);

  // 填写表单
  await page.selectOption("#fItem", plan.item);
  await page.selectOption("#fStation", plan.station);
  await page.selectOption("#fOperator", plan.operator);
  await page.selectOption("#fReviewer", plan.reviewer);
  await page.fill("#fStart", plan.start);
  await page.fill("#fEnd", plan.end);
  await page.fill("input[name=waterDrops]", "22");
  await page.fill("input[name=grindMinutes]", "35");
  await sleep(150);
  const preview = await page.textContent("#conflictPreview");
  ok(/时段空闲/.test(preview), "冲突预检显示“时段空闲，可提交”", preview);

  // 复核人=操作人即时拦截
  await page.selectOption("#fReviewer", plan.operator);
  await page.dispatchEvent("#fReviewer", "change");
  await sleep(100);
  ok(/复核人不能与操作人/.test(await page.textContent("#conflictPreview")), "前端即时拦截“复核人=操作人”");
  await page.selectOption("#fReviewer", plan.reviewer);
  await page.dispatchEvent("#fReviewer", "change");
  await sleep(100);

  // 提交按钮必须落在视口内（手机核心诉求）
  const submitBox = await page.evaluate(() => {
    const r = document.querySelector("#submitBtn").getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, vh: window.innerHeight };
  });
  ok(submitBox.bottom > 0 && submitBox.top < submitBox.vh,
    `提交按钮位于视口内（top=${Math.round(submitBox.top)} vh=${submitBox.vh}）`, JSON.stringify(submitBox));

  await page.click("#submitBtn");
  await page.waitForFunction(() => !document.querySelector("#planOverlay").classList.contains("open"), null, { timeout: 5000 });
  ok(true, "提交成功，弹层关闭");
  await sleep(400);

  const pendingCard = await cardInColumn(page, "待审核", plan.item);
  const pendingEl = pendingCard.asElement();
  ok(!!pendingEl, "提交后卡片出现在「待审核」列");

  // 切换复核人完成双人审核
  await page.selectOption("#actor", plan.reviewer);
  await sleep(300);
  const approveHandle = await page.evaluateHandle((itemCode) => {
    const col = [...document.querySelectorAll(".column")].find(c => c.querySelector("h3")?.textContent.includes("待审核"));
    const card = col && [...col.querySelectorAll(".card")].find(c => c.textContent.includes(itemCode));
    return card?.querySelector("[data-act=approve]") || null;
  }, plan.item);
  const approveEl = approveHandle.asElement();
  ok(!!approveEl, `复核人 ${plan.reviewer} 视角出现「通过」按钮`);
  if (approveEl) {
    await approveEl.click();
    await sleep(400);
    const approved = await cardInColumn(page, "已批准", plan.item);
    ok(!!approved.asElement(), "复核通过后卡片进入「已批准」列");
  }

  // 操作人视角打开该卡审计抽屉，验证子集不再误报损坏
  await page.selectOption("#actor", plan.operator);
  await sleep(300);
  const auditHandle = await page.evaluateHandle((itemCode) => {
    const col = [...document.querySelectorAll(".column")].find(c => c.querySelector("h3")?.textContent.includes("已批准"));
    const card = col && [...col.querySelectorAll(".card")].find(c => c.textContent.includes(itemCode));
    return card?.querySelector("[data-act=audit]") || null;
  }, plan.item);
  const auditEl = auditHandle.asElement();
  if (auditEl) {
    await auditEl.click();
    await page.waitForSelector("#drawer.open");
    await sleep(200);
    const chainText = await page.textContent("#chainBox");
    ok(/逐哈希核对一致/.test(chainText), "单计划审计显示“与全局链逐哈希核对一致”（非链损坏）", chainText);
    await page.click("#drawerClose");
  } else ok(false, "打开审计抽屉");

  ok(consoleErrors.filter(e => !/favicon|Failed to load resource/.test(e)).length === 0,
    "无页面 JS 控制台错误", consoleErrors.join(" | "));

  await page.close();
}

await run("桌面", 1280, 800, false, {
  item: "IS-002", station: "ST-02", operator: "u3", reviewer: "u1",
  start: "2030-06-01T09:00", end: "2030-06-01T10:00",
});
await run("手机", 375, 812, true, {
  item: "IS-001", station: "ST-01", operator: "u1", reviewer: "u2",
  start: "2030-07-01T09:00", end: "2030-07-01T10:00",
});

console.log(`\n${"=".repeat(50)}`);
console.log(`浏览器 E2E：\x1b[32m${pass} 通过\x1b[0m，\x1b[${fail ? "31" : "32"}m${fail} 失败\x1b[0m`);
if (fail) { failures.forEach(f => console.log("  FAIL: " + f)); await browser.close(); process.exit(1); }
await browser.close();
