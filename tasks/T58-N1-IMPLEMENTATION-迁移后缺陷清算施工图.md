# T58-N1 IMPLEMENTATION：迁移后缺陷清算施工图

> 状态：**定稿**
> 依据：T58-N1 DESIGN（缺陷清单与裁决）+ 三路并行审计证据

## 1. 逐模块裁决表

| 模块 | 裁决 | 依据 | 动作 |
| --- | --- | --- | --- |
| `mobile/relay/runtime.ts` | **重构** | 一文件十五类职责；两处 onStatus 逻辑重复但配置不对称 | 会话生命周期抽出为 `session-lifecycle.ts`；A2 故障分类重写 |
| `mobile/relay/session-lifecycle.ts` | **新建** | 共享 `activeThreadId` 与 `sessionSyncRef`，与 runtime 挤在一处 | 承载 openSessionAndAttach / attachThread / hydrateThread / reviveThread |
| `mobile/relay/relay-reachability.ts` | **新建** | A2 缺故障分类手段 | 探 `/healthz`，区分可达/不可达；永不抛 |
| `mobile/state/history-sync.ts` | **重构** | A4 真相与投影分叉；A5 preview 恒空 | 加 `applyLocalChange` + 墓碑 + `localTitles` + deferred；preview 取 hub 下发 |
| `mobile/state/local-history-changes.ts` | **新建** | A4 的循环依赖约束 | 本地意图登记；sink 就绪即下发 |
| `mobile/state/session-sync.ts` | **复制+微修** | 本地行与桥接行曾分两路写同一槽 | 归并器成为唯一写入口；`appendLocal`/`rebaseline`/`localRowId` |
| `mobile/state/session-align.ts` | **新建** | 起点对齐与本地行入流共用归并器一个真相源 | 持引用面，不复制状态 |
| `store/conversation-store.ts` | **重构** | A9 单槽；消息流有两个写入口 | 删 `appendMessage`（消息流唯一写入口）；`permissionRequest` → `permissionQueue` |
| `store/history-store.ts` | **复制+微修** | A4 本地写不回流 | 四个本地动作登记意图 |
| `store/composer-store.ts` | **重构** | A7 `sending` 死字段；A6 草稿跨会话 | 守卫改认 `generating`，删死字段；加 `clearDraft` |
| `store/attachment-store.ts` | **复制+微修** | A6 附件不按会话隔离 | 加 `sessionId` 与 `bindToSession` |
| `features/usage/usage-card.tsx` | **复制+微修** | A8 effect 依赖漏 `activeSessionId` | 订阅替代 `getState()` |
| `features/chat/permission-card.tsx` | **复制+微修** | A9 取队首 | `permissionQueue[0] ?? null` |
| `app/search.tsx` `app/archived.tsx` | **重构** | A1 漏挂线程 | 改用 `openSessionAndAttach` |
| `features/history/history-drawer.tsx` | **复制+微修** | A1 路径正确但未收口 | 三步内联改为调用同一入口 |
| `components/ui/keyboard-*.tsx` | **新建** | 输入框被键盘遮盖（无共用容器） | `KeyboardScrollScreen` / `KeyboardAvoidingPanel` / `keyboard-avoid-behavior` |
| `features/chat/use-keyboard-height.ts` | **新建** | 对话 dock 是绝对定位，padding 让位无效 | 键盘实测高度驱动 dock 的 `bottom` |
| `mobile/relay/discover.ts` | **重构** | 首次配对鸡生蛋死锁；`/^ws/` 截断产出 `httpss` | `manualRelayOrigin` + `relayHttpOrigin`（ws/wss 逐字对应） |
| `mobile/relay/entriesToMessages` | **不移植（删除）** | 生产零调用；与 `response-map` 两套 id 规则 | 删，MIGRATION 已记录裁决 |
| x-harness `saved-query` / `preview-fold` / `read-history` / `host-commands` | **重构** | A5 preview 无来源 | 新增 `preview` 字段；抽 `shared/preview-fold.ts` 两处复用 |
| `oxlint-plugins`（装死测试规则） | **不移植** | 实测此版本 js plugin 不派发 visitor，规则无法生效 | 撤除，改落 `AGENTS.md` 文档约定 |

## 2. 拆分决策

- 会话生命周期从 runtime 拆出：一文件十五类职责违反「一动词一文件」，且 lint 上限已到边
  （597 行，上限 500）
- 故障分类从 runtime 拆出：独立动词（探测 relay 可达性），可单独测试
- 历史本地变更独立模块：循环依赖约束下的解耦件
- preview 折叠在 x-harness 内抽 shared：live（thread/list）与 saved（list_saved）两条来源共用

## 3. 测试计划

| 类别 | 内容 |
| --- | --- |
| 真 bug 回归 | 每个 A/B 类缺陷一条，用例名注明症状编号 |
| 接缝验证 | 移动端 bw 四条 journey（配对发现 / 发送失败可见 / 搜索页开会话发消息 / 断线恢复） |
| 契约等价 | preview 折叠语义 7 例（x-harness）；故障分类 6 例 |
| 装配 | `app/index.tsx` 装配层 e2e（挂 N1 第二波，发版门） |

**已落地的回归用例**（全部带症状注明）：
- `discover.jest.ts` +7（手输 relay 候选、ws/wss 归一、畸形地址降级）
- `relay-reachability.jest.ts` +6（分类 + armed 失败复位）
- `local-history-changes.jest.ts` +7（置顶/归档/改名/删除不回滚、会话晚到、删除终态）
- `session-preview.jest.ts` +5（内容搜索可命中）
- `local-rows.jest.ts` +7（本地行不被事件冲掉、乐观回显摘除）
- `keyboard-avoid.jest.tsx` +6、`use-keyboard-height.jest.ts` +6
- `devices-pairing.jest.tsx` +4（扫码字段映射、空凭据拦截）
- `saved-preview.test.ts` +7（x-harness preview 折叠）

## 4. 实施顺序（阶段门）

| 阶段 | 内容 | 门禁 |
| --- | --- | --- |
| **P0** | 修尺子：移动端 bw 装置 + `AGENTS.md` 假绿条款 | 装置可跑 |
| **P1** | A1 会话挂载收口 | 四门 + 回归用例 |
| **P2** | A2/A3 连接故障分类 | 四门 + 回归用例 |
| **P3** | A4 历史回流 | 四门 + 回归用例 |
| **P4** | A5-A9 状态隔离 | 四门 + 回归用例 |
| **P5** | 结构拆分与死码清理 | 四门 + 全量回归 |
| — | 收口：对抗审查 + e2e 四旅程 + 双形态冒烟 | 见 N1 第二波 |

每阶段独立提交、引用本文档节号；四门 0-0 才算完成。

## 5. 已知未完成（挂账，见 DESIGN §2）

B1/B2/B4 失败态分离、C1 ErrorBoundary、C2 硬编码收口、C3 死码清理、
D2/D4 订阅与别名统一、E4 装配层 e2e。逐条显式，归属 N1 第二波。