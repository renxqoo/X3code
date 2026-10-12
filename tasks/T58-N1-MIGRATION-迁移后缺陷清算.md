# T58-N1 MIGRATION：迁移后缺陷清算

> 状态：**定稿**
> 依据：T58-N1 DESIGN / IMPLEMENTATION

## 1. 行为规格基线（旧行为 = 规格）

N1 不改变用户可见的产品行为，只修复「行为偏离规格」的缺陷。逐项基线：

| 编号 | 旧行为（缺陷） | 目标行为（规格） | 判据 |
| --- | --- | --- | --- |
| A1 | 搜索/归档页打开会话只切 store 不挂线程 | 三个打开入口行为一致：切 store + 挂线程 + 水化 | 事件过滤锚点 = 当前打开的会话 |
| A2 | 一次连接失败后自动重连永久关闭 | 成败都复位 armed；网络恢复后自动回连 | 断网→恢复，无需手动重连 |
| A4 | 下一条事件把本地操作回滚 | 本地意图与远端事实并存，本地意图不被回滚 | 置顶/归档/改名/删除在事件流后仍成立 |
| A5 | 内容搜索恒零结果 | 搜索命中内容关键词 | preview 参与匹配 |
| A6 | 附件/草稿跨会话残留 | 换宿主即清暂存域 | A 的附件不发到 B |
| A7 | 连点产生同线程并发 turn | 一轮未结算不接受新发送 | 第二次提交被拒 |
| A8 | 切会话后显示上个会话用量 | 用量随会话切换 | 显示的 threadId = 当前会话 |
| A9 | 第二个权限请求覆盖第一个 | 多请求排队逐张应答 | 被顶掉的请求仍可应答 |

## 2. 测试迁移矩阵

| 旧测试 | 新去处 | 动作 |
| --- | --- | --- |
| `runtime.jest.tsx` 的 `entriesToMessages` 6 例 | — | **删除 + 理由**：生产零调用（水合走 `response-map.mapEntriesResponse`），且自带 `u${n}`/`a${n}` 与 response-map `u-${seq}`/`a-${seq}` 两套 id 规则。测试保护的是死的那条；继续保留会掩盖真实映射层的缺陷 |
| `runtime.jest.tsx` 权限卡 1 例 | 原位 | 改写（断言 `permissionQueue` 队首） |
| `stores.jest.ts` 权限 1 例 | 原位 | 改写（同上） |
| `history-sync.jest.ts` 偏好 1 例 | 原位 | 改写（`setLocalPreference` → `applyLocalChange`） |
| `send-failure-reason.jest.tsx` | 原位 | 加 `resyncSessionStore`（归并器是模块单例，跨用例残留） |
| `submit-failure.jest.tsx` | 原位 | 同上 |
| `composer-components.jest.tsx` | 原位 | 同上；`readyBridge` 补 `session/liveThreads` 活线程应答（原先恒空表，使发送必落「无归档路径」拒绝分支，旧实现靠整体替换掩盖） |
| `use-keyboard-height.jest.ts` | 原位 | 改写（`emit` 走 `act`——不经 act React 不提交，全量跑时序下更不稳） |

## 3. 装置适配记录（断言语义逐条等价）

| 项 | 调整 | 理由 |
| --- | --- | --- |
| `composer-components` 的 `readyBridge` | `session/liveThreads` 从恒空表改为答活线程 | 原先恒空使发送必落 `no_session_path` 拒绝分支；该文件测的是发送交互，不该顺带落进无路径分支 |
| `use-keyboard-height` 的事件派发 | `setTimeout` 冲刷 → `act` 包裹 | 外部推送的状态更新不经 act 不被 React 提交，`renderHook` 的 result 读到旧值 |
| `local-history-changes` 装置 | 每用例重绑 sink | 模块级 sink 跨用例共享，不重绑会串到上一条用例的真相层 |
| `history-sync` 墓碑语义 | 删除是终态，后续置顶/改名不复活 | 删除是显式用户动作，误触的后续操作不该复活会话 |

## 4. 跨仓改动记录（x-harness）

用户授权直接修改 x-harness 的代码错误。本波次改动限于**字段补齐**，不改协议语义：

| 文件 | 改动 | 理由 |
| --- | --- | --- |
| `host/host/__test__/saved-preview.test.ts` | 新增（7 例） | preview 折叠语义 |
| `host/saved-query.ts` | `SavedSession` 加 `preview`；`foldSummary` 导出 | 归档列表的内容搜索锚点 |
| `shared/preview-fold.ts` | 新增 | live 与 saved 两条来源共用同一折叠，语义单一 |
| `host/read-history.ts` | `readState` 返回 `preview` | live 会话的锚点 |
| `host/host-commands.ts` | `thread/list` 补 `preview`；改 `includePreview` 显式开关 | 见 §4.1 性能裁决 |
| `host/preview-cache.ts` | 新增（6 例） | 摘要缓存，键为 (threadId, mtime, size) |

### 4.1 性能裁决（对抗审查 P1）

初版 `thread/list` 无条件逐会话读档折叠摘要。桌面端 `create-runtime-monitor` 每2s
轮询一次该命令，线程表上限 1024 —— 相当于每 2 秒把 1024 份归档各全读一遍
（读+ 校验 + 逐行 parse + stringify 累加），是**本波次引入的回归**。

裁决两处：

1. **显式开关**：`thread/list` 的 `preview` 改为 `input.includePreview === true` 才计算。
   无参调用（桌面端轮询）走原路径，零额外成本；需要摘要的调用方（移动端 bootstrap）
   在 `command-map.ts` 的 `args` 里声明该键透传——未声明的键会被丢弃。
2. **摘要缓存**：`preview-cache.ts` 按 (threadId, mtime, size) 缓存，档内容变了这两个
   值必变，故命中即等价、无需失效广播；容量上限 512，触顶丢弃最早插入项。

单条会话读取失败只丢该行摘要（空串），不让整张列表失败。

**未改**：relay 的 upgrade 面。实测 `hub-relay/main.ts` 已正确返回 401 +
`X-Relay-Reason: auth` 与 503（overloaded），语义完备——初判「服务端需区分鉴权与
网络失败」**证伪**，缺的是客户端分类手段，故用既有的免鉴权 `/healthz` 探测解决，
不动服务端协议。

## 5. 回滚方案

各阶段独立提交可独立回滚。本波次的关键改动（会话挂载收口、故障分类、历史回流、
状态隔离）均为纯增量或语义等价替换，无数据迁移，回滚不产生残留状态。

## 6. 验收清单

- [x] 四门 0-0（typecheck / lint / test；build 见收口波次）
- [x] 每个修复的 bug 带症状注名的回归用例
- [x] MIGRATION 文档先行更新，代码后动（同提交内）
- [x] 删测试的理由已显式记录（`entriesToMessages`），非静默删除
- [x] 跨仓改动已单独记录（x-harness 五处）
- [x] 未完成项逐条显式（DESIGN §2 挂账表）
- [ ] 对抗审查（独立会话对照旧实现找行为偏差）— 收口波次
- [ ] e2e 四旅程（移动端 bw）— 收口波次
- [ ] 双形态进程冒烟 — 收口波次