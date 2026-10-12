# T58-N1 DESIGN：迁移后缺陷清算（移动端重构）设计基线

> 状态：**定稿**（N1 波次；每项裁决附证据，实施结果见 §5）
> 级别：大（移动端状态层/连接层/渲染层/验证层四处）
> 关联：T58 三件套（relay 迁移，P0-P5 已实施）。N1 是**迁移收口后的清算波次**，
> 不是重新迁移——按 repo-migration-e2e-v2 §0「中途接入」，旧行为仍是规格基准。

## 0. 背景与触发

T58 完成 relay 迁移后，App 在真机上出现「配对能成、消息发不出」的连续故障。
三轮排查（读码推理 → 外部证据复现 → 三路并行审计）确认：**问题不在迁移本身，
而在迁移产物与真实运行之间的 23 项结构性缺陷**——它们全部不在 T58 文档覆盖范围内。

T58 文档回答的是「怎么迁过去」；N1 回答「迁过去之后站得稳不稳」。

### 0.1 本波次的元问题（比单个 bug 更重要）

修复过程中出现 5 轮「改完门禁全绿、真机仍报同样症状」。事后归因：

| 轮次 | 结论 | 证据类型 | 是否命中 |
| --- | --- | --- | --- |
| 1 | 手输码发现死锁 | `curl` 真实 relay 返 404 | ✓ |
| 2 | `wss` → `httpss` 非法 scheme | `curl httpss://` 协议层拒收 | ✓ |
| 3 | QR 字段名不匹配 | 仓库自带 e2e `journey.ts` 写着正确映射 | ✓ |
| 4 | 本地提示被快照冲掉 | 字节级覆盖语义分析 | ✓ |
| 5 | 「渲染层没画出来」 | **只有推理** | ✗ 推理错误 |

前 4 轮对，因为都找到了**外部可验证的证据**；第 5 轮只有推理，于是翻车。
更严重的是：我为第 5 轮写的护栏测试用了 `UNSAFE_getAllByProps`
（RNTL v14 已移除），**断言从未执行却仍能编译**，我在报告里称它「失败但没深究」。

**元教训**：门禁给了虚假信心。故 N1 的第一件事不是修 bug，是**修尺子**。

## 1. 缺陷清单（审计证据）

### A 类·正确性（直接对应用户症状）

| # | 缺陷 | 位置 | 症状 | 裁决 |
| --- | --- | --- | --- | --- |
| A1 | `openSession` 未挂线程 | `app/search.tsx` `app/archived.tsx` | 消息发出去没回复（回复进了别的会话） | 收口为 `openSessionAndAttach` |
| A2 | 掉线即永久 | `runtime.ts` onStatusWrapper | 配对成功后再也连不上 | 探 `/healthz` 分类 + armed 成败都复位 |
| A3 | `connectInFlight` 假成功 | `runtime.ts` | 第二个调用方拿到假成功，A2 复位建立其上 | 随 A2 一并收敛 |
| A4 | 本地历史操作被回滚 | `history-store` ↔ `history-sync` | 置顶/归档/改名被下一条事件抹掉，删除的会话复活 | 本地变更登记回流 + 墓碑 |
| A5 | `preview` 恒空 | `history-sync` 两处 | 内容搜索永远零结果（文案却承诺可搜） | hub 下发 preview（改 x-harness） |
| A6 | 附件/草稿不按会话隔离 | `attachment-store` `composer-store` | A 的附件发到 B | 附件绑会话，换宿主即清 |
| A7 | `sending` 死字段 | `composer-store` | 连点两次向同一线程投两个 prompt | 守卫改认 `generating`，删死字段 |
| A8 | effect 依赖漏 | `usage-card.tsx` | 切会话后显示上个会话的 token 占用 | 订阅替代 `getState()` |
| A9 | 权限卡单槽 | `conversation-store` | 第二个请求覆盖第一个，用户永远无法应答 | 改队列 |

### B 类·静默失败（用户看到的是错误的真相）

| # | 缺陷 | 位置 | 用户看到 |
| --- | --- | --- | --- |
| B1 | 水合失败与「空会话」同形 | `runtime.ts` hydrateThread | 打开历史一片空白，以为会话没了 |
| B2 | bootstrap 失败降级空列表 | `runtime.ts` loadBootstrap | 「历史丢了」 |
| B3 | 连接装配失败 `void error` | `runtime.ts` connectWithCredentials | 徽标翻回未连接，零原因 |
| B4 | 五屏失败伪装空态 | models/usage/task-config/历史/归档 | 被指引做无效操作 |
| B5 | 恒等死分支 | `runtime.ts` dispatchL2Frame | 无（死码） |

### C/D 类·渲染与结构

C1 无全局 ErrorBoundary；C2 90 处硬编码中文（27 文件）；C3 `status-line`/`stream-items` 为死代码；
D1 `runtime.ts` 一文件十五类职责；D2 `useRelayStatus` 非 zustand 订阅面；
D3 `session-align` 与 runtime 双持有归并器；D4 `Bridge*`/`Relay*` 双命名别名。

### E 类·验证缺口（本波次的元问题）

E1 `AGENTS.md` 的 bw 走查章节只覆盖 Electron，移动端零通道；
E2 `bridge-gate` 0% / `ws-dial` 0% / `token-refresh` 0%；
E3 393 个测试无一断言「用户看得见失败文案」；
E4 `app/index.tsx` 装配层零渲染测试。

## 2. 内部问题域

### 处理（本期）
- 连接生命周期与故障分类（A2/A3/B3）
- 会话归属与挂载次序（A1）
- 历史真相与本地意图的分叉（A4/A5）
- 状态隔离与依赖正确性（A6-A9）
- 验证尺子（E1-E3）

### 不处理（归属明确，不留白）
| 挂账 | 归属 | 后果 |
| --- | --- | --- |
| B1/B2/B4 五屏失败态分离 | N1 第二波（需先定失败态 UI 形态） | 失败仍与空态同形 |
| C1 全局 ErrorBoundary | N1 第二波 | 任一组件抛错 = 白屏 |
| C2 90 处硬编码中文 | N1 第二波（机械收口，可脚本化） | 文案目录非唯一真相 |
| C3 死代码清理（status-line 等） | N1 第二波 | 死码误导阅读 |
| D2/D4 订阅统一与别名清理 | N1 第二波 | 订阅面不一致 |
| E4 装配层 e2e | 发版门 | 组合行为无自动化保护 |
| relay 服务端「401 与网络不可达」的显式区分 | 不做 | 见 §3 裁决 |

## 3. 方向性裁决（用户裁决，落档于此）

### 3.1 不改 x-harness 的服务端口径，只改它缺的字段（裁决：允许改 x-harness，但限于字段补齐）

初判「RN 拿不到握手响应头，需 relay 区分鉴权/网络失败」属服务端口径缺失。
**实测证伪**：`hub-relay/main.ts` 的 upgrade 面已正确返回 401 + `X-Relay-Reason: auth`
与 503（overloaded），语义完备。缺的是客户端侧的分类手段。
故不要求 relay 改协议，改为用既有的免鉴权 `/healthz` 探测做分类（A2）。

**例外**：A5 的 `preview` 字段确需 x-harness 补（`thread/list` 与 `thread/list_saved`
均从归档折叠出摘要，设备侧无从取得）。用户已授权直接修改 x-harness 的代码错误。

### 3.2 会话挂载收口在 runtime 侧而非 store 侧

让 store 的 `openSession` 内部自动挂线程最防漏，但 store → runtime 会成环
（runtime 已引 store）。故编排方是 runtime：新增 `openSessionAndAttach` 作为唯一入口，
三个打开入口（drawer/search/archived）全部改用它。挂载次序是协议事实，不该由人工纪律兜。

### 3.3 A4 的本地意图走「登记 + 真相层持有」而非 store 直写 sync

同一循环依赖约束。`local-history-changes.ts` 登记意图，runtime 装配后消费；
真相层（`history-sync`）以 `localTitles` + 墓碑长期持有，避免「删除意图」被后续置顶覆盖。

### 3.4 装死的 lint 规则不做，只落文档约定

原计划加 oxlint 规则禁 `UNSAFE_*`（RNTL v14 已移除的查询）。
**实测此版本 js plugin 不派发节点 visitor**（`CallExpression`/`UnaryExpression`/`Program`
全部零触发，加 `console.error` 确认）。规则无法生效——而**装死的规则比没有规则更危险**
（它给出虚假安全感，正是本波次踩的坑）。故撤掉规则，改在 `AGENTS.md`「禁止假绿」条款落约定。

## 4. 并发与性能预算

- 本地变更登记：O(1) 摊还（按 id 去重），不做全表扫描
- 事件路由：维持模块级 Set，禁止每帧重建
- 历史 emit：维持既有行为（未在本波次优化范围）

## 5. 实施结果

| 阶段 | 内容 | 结果 |
| --- | --- | --- |
| P0 修尺子 | 移动端 bw 装置 + `AGENTS.md` 假绿条款 | ✅ |
| P1 修正确性 | A1-A9 | ✅ 全部带症状的回归用例 |
| — 结构拆分 | `runtime.ts` 597→435 行，抽出 `session-lifecycle.ts` | ✅ 降回 lint 上限内 |
| — 删死代码 | `entriesToMessages`（70 行，生产零调用） | ✅ MIGRATION 已记录裁决 |

未完成项见 §2「不处理」，逐条显式，不推迟≠缺失。
## 6. 对抗审查结论（两轮，交叉验证）

两轮独立会话审查，第二轮审的是**第一轮修完之后**的代码。共报 P0×3 / P1×6 / P2×3，
全部修复并补回归用例。几条值得长期记住：

### 6.1 测试绕开真实链路 = 假绿的第三次形态

`preview` 的跨仓链路断在 `mapThreadRows`：它用字面量对象重建每行只搬 5 个键，
host 下发的 `preview` 被丢弃。而当时的 12 条测试**全部直接喂** `toConversationSession`
/ `updateSession`，绕开了映射层——于是 x-harness 的改动 + 全部测试都绿，特性零效果。

这是本波次「测试绕开真实链路」的第三次（前两次：渲染层断言只看 store、e2e 缺 preview 覆盖）。
**教训固化**：断言必须从上游原始行起，穿过每一个映射层（`preview-cross-repo.jest.ts` 的写法）。
护栏的价值取决于它是否对缺陷敏感——直接喂中间形态的断言恒绿。

### 6.2 守卫读「别人刚写过的值」必然恒不成立

A6 的暂存域守卫读 `store.activeSessionId`，而调用方 `openSessionAndAttach` 会先
`openSession` 改写它 → 两边恒等 → `clearDraft`/`bindToSession` 永不执行。

修法不是调换调用顺序（那只是把巧合换成另一个巧合），而是**读自己域内的记忆**
（`activeThreadId`），使正确性不依赖任何调用方的调用顺序。采纳该修法后，一条依赖旧
守卫巧合的测试立刻变红——这是好护栏的表现。

### 6.3 自愈路径会被自己的互斥量挡住

装配失败时在 catch 内触发 `onStatusWrapper` → 自愈重试 → 但此时 `connectInFlight`
仍是本次的 run，重试撞上自己的互斥量，`await` 立即返回、不重连也不报错。
**注释宣称覆盖的场景，恰恰被自己引入的机制挡住。** 修法：互斥量先释放再触发自愈。

### 6.4 死代码/幽灵字段让门禁失明

`permissionRequest` 已删，但测试 `setState` 仍写它——zustand 接受任意键，该字段被凭空
写进 store 且恒为 null，断言它为 null 的三条用例恒绿。同型：`sending` 死字段被测试夹具
重新塞回 store，而 `tsconfig` 排除 `__tests__` 故 typecheck 看不见。

**教训**：删除字段后必须清查测试夹具；`tsc` 不覆盖测试目录，类型检查通过≠没留残留。

### 6.5 本波次引入的性能回归

`thread/list` 无条件逐会话读档折叠摘要，桌面端 2s 轮询 × 1024 线程表 = 每 2 秒全读一遍
归档。由对抗审查抓出（我自己只看了移动端侧，未查该命令的其他消费方）。裁决见
MIGRATION §4.1：显式 `includePreview` 开关 + (threadId, mtime, size) 缓存。
