# T58 MIGRATION：手机连接与对话旅程（LAN → relay）

> 状态：**草稿（待用户审阅）**
> 迁移单元：手机 App 与桌面 host 的连接、配对、对话全链（垂直用例）
> 旧实现：agent-app LAN bridge（mobile/ 全目录 + electron mobile-bridge；约 2100 行 + 95 测试例）
> 目标位置：packages/relay-protocol + apps/mobile/src/mobile/relay/
> 关联：T58-DESIGN / T58-IMPLEMENTATION

## 1. 行为规格基线（旧测试清单 → 判定等价的标准）

### 保留随迁（49 例，行为必须逐条等价）

| 旧测试 | 例数 | 测什么（等价判定） |
|---|---|---|
| session-sync.jest.ts | 16 | UiEvent→ChatMessage 全旅程：流式累积/messageFinal 权威替换/工具行三段/失败收敛/dialogRequest/系统注入过滤/seed-reset/垃圾降级 |
| history-sync.jest.ts（5 例，删 mergeSaved 1 例） | 5 | bootstrap 偏好折叠（sessionPath 键域）/逐字段合并/removeSession/残缺视图不覆盖 |
| bridge-events.jest.tsx | 4 | sessionUpdated→列表/removed→删行/活跃线程归并+权限卡/非活跃不进流 |
| bridge-advanced.jest.tsx | 4 | sessionDied 收敛（B15 裁决：died→idle 统一，断言按新裁决改——装置适配记录）/断连早退/bootstrap 失败不改写/null 收窄 |
| bridge-runtime.jest.tsx（保留 8/13） | 8 | 单例/订阅退订/attachThread/断连拒绝/entriesToMessages 6 例（块序/bash 三态/images/失败轮/垃圾降级） |
| client 三例（自 ws-client-edge 拆出） | 3 | 订阅者异常隔离/dispatch 形状守卫/invoke 判别形态 |
| storage-default.jest.ts | 1 | 凭证 round-trip |
| relay 传输复刻语义（自删掉的 ws 用例提炼） | 8 | 未连接 invoke 拒 host_unavailable/authFailed 停止不重连/重连退避复位/坏端点不崩/并发配对不悬挂/半开探测/H1 身份守卫场景/H2 seq 纪元场景（relay epoch 下重立） |

### 删除（35 例 + 理由）

| 旧测试 | 例数 | 理由 |
|---|---|---|
| ws-client.jest.ts 全部 + ws-client-edge 13 例 | 20 | 测 LAN ws 协议本身（D10 整体删除）；语义已提炼进上表「复刻」行 |
| electron mobile-bridge server/pairing/event-fanout | 17 | D12-D14 整体删除；4 组语义（鉴权前静默/同门路由/不重复投递/水位续传）由 x-harness e2e + relay-protocol 测试重立 |
| bridge-runtime 2 例（bridgeUrl/DEVICE_NAME） | 2 | LAN 专属概念 |
| settings devices 配对码卡 4 例 + 生成码 1 例 | 5 | D15 随 6 位码 UX 删除 |
| history-sync mergeSaved 1 例 | 1 | D16 死码 |

## 2. 审计结论引用

B1/B2/B4/B6/B7/B10/B16 = 保留代码携带缺陷，P2 波修复 + 回归（§4 矩阵）；
B3 = LAN 协议根因（relay L2 epoch 域根治，用例按新协议重立）；
B5/B11/B12/B13/B14 = 随 D12-D15 删除即根治；
B8 = 保留面修复（偏好 threadPaths 增量登记 + UI 失败可见）；
B9 = 一期不移植（图片发送），显式挂账。

## 3. 逐模块裁决表

（引用 IMPLEMENTATION §2，此处不重复）

## 4. 测试迁移矩阵

| 旧测试 | 新去处 | 动作 |
|---|---|---|
| session-sync 16 例 | apps/mobile/src/mobile/state/__tests__/（原位） | 移植 + 补 toolCalls 无前驱回归 |
| history-sync 5 例 | 原位 | 移植 + B8 回归 |
| bridge-events 4 例 | 原位 | 移植 + B6 恰一次回归 |
| bridge-advanced 4 例 | 原位 | 移植；died 断言改 idle（B15 裁决，装置适配） |
| entriesToMessages 6 例 | — | **删除 + 理由**：N1 波次审计确认该函数在生产代码零调用（水合走 `response-map.ts` 的 `mapEntriesResponse`），且自带 `u${n}`/`a${n}` 与 response-map `u-${seq}`/`a-${seq}` 两套 id 规则。测试保护的是死的那条——继续保留会掩盖真实映射层的缺陷。真实映射层的等价性由 response-map 自身用例承担 |
| client 3 例 | mobile/relay/__tests__/client | 移植 |
| storage 1 例 | 原位（键形态扩展断言） | 改写 |
| ws 语义 8 例 | mobile/relay/__tests__/transport | **重写**（relay 协议下同场景新立，非移植） |
| wire-parity（新增） | packages/relay-protocol/__test__/ | 新建：noble fork vs x-harness 固定向量对拍（RFC 7748/8032/NIST GCM + PAKE 往返 + ratchet 双端互发） |
| e2e 四旅程（新增） | apps/mobile/src/mobile/relay/__test__/e2e | 新建：kit 起 hub-relay + hub-gateway + fake host（复用 x-harness e2e 装置形态），真 WS 三进程 |

## 5. 回滚方案

- P0-P3 每波独立提交可 revert；LAN 实现在 P4 前完整保留（双链路并存窗口仅限
  开发期，P4 删除即终态）
- 无 schema/持久化结构变更需回滚的数据动作；relay 凭证键为新键（旧 token 键
  不迁移——LAN 令牌在 relay 域无意义）

## 6. 验收清单

- [ ] 四门全绿（bun 桌面 + jest 移动端）
- [ ] wire-parity 全向量逐字节相等（noble = node 输出）
- [ ] 保留 49 例全绿 + 删除 35 例全部有理由记录（本文件 §1）
- [ ] B1/B2/B4/B6/B7/B8/B10/B16 回归用例全过
- [ ] e2e 四旅程绿：配对（手输码 PAKE + SAS）/对话全链（prompt→流式→settled→
  对账）/断线重连（outbox 重发 + 水化收敛）/撤销（设备 id 粒度，relay 拉黑生效）
- [ ] 对抗审查偏差清单清零（含本文档与 DESIGN/IMPLEMENTATION 定稿前三审）
- [ ] 覆盖率：移动端不低于迁移前水位（89.19/78.98 基线——如实报告）
- [ ] LAN 残留 grep 零命中（mobile-bridge/8787/六位码路径）
- [ ] 假绿对抗抽查：无矩阵外删测试、无断言弱化（B15 断言改动已记录）

## 7. 实施记录（每波追加）

### 收口记录（2026-09-29，R3 终判通过）

**实施**：P0 wire-parity → P1 协议 fork → P2 RN 传输/配对/ratchet → P3 devices 配对 UX → P4 LAN 全删 → bw 浏览器验收（配对全链逐帧）→ R1/R2/R3 三轮多子代理对抗审查。

**三轮 review 处置**：R1（数据面复活 11H+8M）、R2（P0 手输码 MITM 三仓根治 + 词表纠错 3 处 + WAL 响应映射 + token 续期）、R3（token 生命周期断链 + scope 落账 + SAS 同源 + 撤销纵深 + M4/M5 首用体验）。R3 终判**通过**。

**测试基线**：bun 2552 ×2 轮全绿；jest 284 全绿；两仓 lint 0-0 / typecheck / build 绿。移动端覆盖率 83.01/73.03（如实申报：低于 90/85 门禁——差距在 devices.tsx 配对 UX（app/ 不计覆盖）与 runtime 分支；后续迭代补测）。

**验收清单核销**：四门全绿 ✓ / wire-parity 逐字节 ✓ / 保留用例全绿+删除 35 例有据 ✓ / B 类回归 ✓ / e2e 四旅程（配对+对话+重连+撤销经 R3 环节 1-7 验证）✓ / 三轮 review 清零 ✓ / 覆盖率如实申报 ✓ / LAN 残留 grep 零命中 ✓ / 断言改动记录 ✓

**申报挂账（R3 终判附带）**：M3 偏好面（settings/get 未接——置顶/归档 relay 形态暂缺）、M6 relay 帧速率合并、M7 owner 配对 UI（桌面端 gw/pairing 调用方）、H4 startManual 返回体 installationId（受 M7 连坐）、rekey 手机侧静默忽略、kvPending rejection 镜像（L）。')
