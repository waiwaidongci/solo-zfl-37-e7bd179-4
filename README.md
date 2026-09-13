# 墨锭试磨室 · 实验排程与双人复核

零依赖 Node.js 应用：墨锭试磨实验的排期看板、双人审核、并发占用互斥与完整审计链。

## 运行

```bash
npm start              # http://localhost:3037

npm test               # 1) 并发/权限/回滚/一致性（72 项，真实多进程压测）
npm run test:migration # 2) 旧版 v1 数据无损升级 + 单计划审计子集（25 项）
npm run test:browser   # 3) Playwright 桌面 1280 / 手机 375 浏览器 E2E（32 项）
npm run test:all       # 依次跑全部三套
```

浏览器测试需先安装：`npm i` 后 `npx playwright install chromium`（Linux 无 root 时可用 `LD_LIBRARY_PATH` 指向解包的系统库）。

- 页面与接口同一端口，桌面浏览器与手机浏览器均可操作（≤760px 自动切换单列看板与全屏弹层）。
- 数据保存在 `data/ink-stick-testing.json`（首启自动播种；可用 `INK_DB` 环境变量指定其他文件，测试即用独立库，互不影响）。
- 页面右上角切换当前身份（无登录系统，按 `X-User-Id` 头区分操作人）。

## 状态机

```
草稿 draft ──提交──▶ 待审核 pending ──通过──▶ 已批准 approved ──开始──▶ 执行中 running ──完成──▶ 已完成 completed
  ▲                     │                      │                        │
  └──── 驳回(须填原因) ──┘                      │                        ├─ 申请取消(须填原因)
  （驳回释放预占，可改后重提）                   └─ 未开始申请取消 ─▶ 已取消   ▼
                                                                    待取消复核 cancel_review
                                                                   第二人确认 ▶ 已取消 cancelled
                                                                   第二人驳回(须填原因) ▶ 回到执行中
```

## 关键规则

- **双人复核**：审核人不得是操作人本人；开始执行后的取消必须由「非申请人」的第二人（指派复核人或管理员）确认。
- **强制原因**：审核驳回、取消申请、取消复核驳回，不写原因一律 400。
- **占用互斥**：同一墨锭不能并行占用；同一台位时段重叠（半开区间 `[start,end)`，首尾相接不算冲突）只允许一个排期。提交即预占，驳回/取消/完成时释放。
- **原子提交**：所有写操作在单进程互斥队列内对深拷贝快照执行，经临时文件 `fsync` + `rename` 原子落盘。冲突失败时计划、占用、审计、计数要么全部落盘、要么全部不落（计数器除外，它是唯一与 409 同事务写入的数据）。
- **审计链**：所有变更（含草稿删除）只追加到 `events`，每条含 `prevHash` 与 sha256 链式哈希；看板与抽屉实时显示链校验结果，篡改任意一条即断链。
  - 全局视图 `/api/events` 从创世记录严格连续校验；
  - 单计划视图 `/api/events?planId=xx` 是全链的**非连续子集**，不套用全链序号规则，而是将每条记录按 `seq` 与全局链逐哈希比对——全链完好且切片一致才判为有效，因此「全局有效」时单计划不再误报损坏；全局链真损坏时则明确提示无法背书。

## 旧版数据升级（v1 → v2）

旧版数据文件（无 `version` 字段，墨锭记录里的 `logs` 试磨日志、`tests` 试磨结果）启动时**无损迁移**，不再被重置：

- 原有墨锭及其全部字段（含只有 `id` 无 `code` 的老记录）原样保留，`logs`/`tests` 不删不改；
- 每条历史日志/试磨结果固化为只追加审计事件（`legacy_log`/`legacy_test`），并写入 `item_imported` 与 `schema_migrated` 事件，迁移后整条哈希链可独立重算；
- 迁移只发生一次并原子落盘为 `version:2`，重复启动幂等。

## 看板

- 八列状态泳道、冲突数、累计并发拦截数、逾期（未开始 / 执行中两类）、审计链状态芯片。
- 卡片按当前身份只显示有权执行的动作；新建排期时实时预检墨锭/台位冲突并提示。
- 每 4 秒自动刷新；点击卡片查看该排期的完整审计时间线。

## API 摘要

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/bootstrap` | 看板全部数据 + 统计 + 链校验 |
| POST | `/api/plans` | 新建排期（`submit:true` 直接提交，冲突返回 409 + 冲突明细） |
| PATCH | `/api/plans/:id` | 编辑草稿/被驳回排期 |
| POST | `/api/plans/:id/submit` | 提交（占用预占，冲突 409 且整体回滚） |
| POST | `/api/plans/:id/review` | `{decision:"approved"|"rejected", reason?}` |
| POST | `/api/plans/:id/start` | 开始执行 |
| POST | `/api/plans/:id/complete` | 完成并释放占用 |
| POST | `/api/plans/:id/cancel-request` | `{reason}`；未开始即取消，执行中转双人复核 |
| POST | `/api/plans/:id/cancel-review` | 第二人 `{decision:"confirmed"|"rejected", reason?}` |
| DELETE | `/api/plans/:id` | 仅草稿可删（留审计） |
| GET | `/api/events?planId=` | 审计链（可按排期过滤） |

所有写请求需带 `X-User-Id` 头。
