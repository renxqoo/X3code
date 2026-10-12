# AGENTS.md — X3code（Electron + host-hub 多 Agent 桌面应用）

**X3code**：monorepo（bun workspaces，scope `@x3code/*`）。两个应用壳共用同一套业务包：

- **apps/electron**：macOS 桌面端。Electron 应用通过**单个 host-hub 宿主进程**承载多对话 × 多 thread 的 AI Agent：host 进程管线程表与模型目录，每活跃会话一个 worker 子进程（内裹 Agent 内核 + WAL 会话）。
- **apps/mobile**：React Native 手机端（Expo + expo-router）。经 relay 加密协议连桌面端的 hub-gateway，复用同一批 host-hub 线程，不另起一套 Agent 内核。

X3code 与 host-hub 的全部交互只有 JSONL stdio 协议（心跳 1Hz、confirm 对话框 ui_request/ui_response、settled 终态信号）；协议规格真相源 = x-harness 仓库 `apps/host-hub/src/protocol/` 代码，本仓 `packages/contracts` 维护类型镜像。

两种 hub 执行形态：脚本形态（bunPath=bun + hubEntry=入口路径，dev 与打包 dist 形态）与直执行形态（hubEntry=null、bunPath = 自包含可执行，`bun build --compile` 单文件；此形态 worker 自举装载在引擎层拒收）。

## 项目结构

### 仓库拓扑

本仓是驱动端，Agent 内核与网关在**旁级私有检出** `../x-harness`：

```
/Users/wrr/work/agent-app     ← 本仓（X3code 驱动端）
/Users/wrr/work/x-harness     ← 旁级检出（hub 内核，本仓不修改其代码）
  apps/host-hub               ← 宿主进程 + worker（协议真相源）
  apps/hub-gateway            ← 远程接入门（桌面 = gateway 的 owner）
  apps/hub-relay              ← 中继服务
  apps/cli
```

`apps/electron/src/main/hub-paths.ts` 是宿主/gateway 路径解析链的单一真相：设置覆盖 > 环境变量（`X3CODE_HUB_ENTRY` / `X3CODE_BUN_PATH` / `X3CODE_GATEWAY_ENTRY` / `X3CODE_HARNESS_ROOT`）> dev 同级探测（`../x-harness/apps/*`，源码入口优先、dist 兜底）> 打包产物候选。

### 目录清单

| 路径 | 职责 |
| --- | --- |
| `apps/electron/src/main` | 主进程：运行时装配、API 路由、宿主与网关进程管理、文件系统与 git、凭据与设置、导入器 |
| `apps/electron/src/preload` | 沙箱桥（contextBridge）：仅 `invoke` / `subscribe` / `window` / `gateway` 四个面 |
| `apps/electron/src/renderer` | 渲染层 React：侧栏、会话舞台、输入区、设置、面板、命令面板、文案目录 |
| `apps/mobile/app` | expo-router 路由（每文件一屏） |
| `apps/mobile/src/features` | 移动端功能域：chat / composer / history / settings / usage / workspace / navigation / privacy |
| `apps/mobile/src/components` | 移动端通用组件（`ui/` 为 RN 版设计系统，`brand/`、`navigation/` 为应用壳） |
| `apps/mobile/src/mobile` | 移动端接入层：`relay/`（配对与加密传输）、`transport/`（Client 适配）、`state/`（会话与历史同步） |
| `apps/mobile/src/store` | zustand stores：会话、历史、输入区、导航、设置、附件、demo |
| `packages/contracts` | 类型与 Port 单一真相：hub 协议镜像、命令、视图、设置、权限、插件、relay 词表（zod 校验） |
| `packages/api` | hub 接口统一封装：七域命令门面、transport 管线、ApiError 解码、views 收窄映射、events 帧编解码、verbs 路由工厂 |
| `packages/infra` | 宿主进程监督（spawn/心跳/挂死重启/优雅停机）、SQLite 注册表、运行时监控采样 |
| `packages/core` | 预留的调度与预算包（当前仅空导出，装配尚未落此层） |
| `packages/ui` | 桌面渲染层通用组件（shadcn 风格，Tailwind v4） |
| `packages/ui-thread` | PC 与移动端共用的工具执行派生层（类别判定、摘要、并行分组、diff 归并、开合策略） |
| `packages/relay-protocol` | relay 线协议栈（帧、信封、ratchet、PAKE 配对、分块重传）：x-harness remote-protocol 的逐字 fork，crypto 换 @noble 纯 JS |
| `packages/testkit` | 公共测试资产：MockClient、帧回放器 |
| `oxlint-plugins/x3code` | 架构宪法插件：electron 宿主面、包间依赖矩阵、浏览器码禁 node 内建 |
| `oxlint-plugins/ui` | UI 纪律插件：一个 .tsx 一个组件/hook |
| `rule/` | 组件域规范：拆分粒度（component-split）与区域重构方法论（component-refactor） |
| `tasks/` | 任务文档与实施顺序（T0–T59，含 relay 迁移与插件运行时规划） |
| `scripts/packaging` | 冒烟包资源同步：拷 bun、编译 host-hub 与 hub-gateway、收依赖闭包 |
| `scripts/ui-e2e` | 端到端驾驶装置：假 hub + CDP 驱动真 Electron 走四场景（不入库、每次重建） |
| `resources/` | 打包产物载荷（bun 二进制、host-hub、hub-gateway），gitignore，构建期生成 |
| `.github/workflows` | `pr`（四门 + x-harness 检出）、`nightly`（定时）、`release`（手动） |

### 运行时数据流

```
渲染层 ──invoke/subscribe──▶ preload ──IPC──▶ main/api-routes（ApiSchemas 校验）
                                                    │
                                          main/x3code-runtime（装配根：唯一 HubApi 实例 + 注册表 + 内存会话表）
                                                    │
                                    infra/host-process（监督状态机 + 增量 env 注入）
                                                    │
                                        host-hub 子进程（JSONL stdio）
```


### 门禁命令（以根 `package.json` 为准）

```
bun run lint      # oxlint --type-aware .：0 error 0 warning
bun run build     # electron-vite build（main/preload/renderer 三面）+ mobile build:web
bun test          # bun 原生 runner：全仓 __test__ 套件（覆盖率默认开）
bun run test      # 仅移动端 jest --coverage --runInBand
bun run ci        # lint → typecheck → build → test
```

各包类型检查用其自身 `tsconfig.json` 跑 `tsc --noEmit`（base 见 `tsconfig.base.json`：strict + noUncheckedIndexedAccess + verbatimModuleSyntax）。根 `typecheck` 脚本当前不在 `package.json` 中，`bun run ci` 的该段需逐包补齐后再作为门禁引用。

---

## 不能做哪些事

- 不能写 TODO：必须把当前任务完成到所有测试通过、无已知异常问题，交付一个生产可用的版本才算结束
- 不写兼容代码：不兼容老代码、不留旧路径别名或双轨字段，同一事实只需要一套接口实现，发现旧实现立即删除
- UI 使用同一套风格的组件：基于现有 shadcn 组件开发；后面会多次使用的 UI 必须封装成通用组件，避免重复开发
- 不能留有安全问题和内存泄漏问题：出现必须修复，不允许「先记着以后修」
- bug 修复不做最小修补：不能只基于现在的实现考虑修复方案，要为以后的项目扩展考虑，用可持续、可扩展的方案根治当前 bug
- 不写版本叙事：代码、注释、UI 文案里禁止出现「v1/v2 改了什么」「某版本修复了 XX」之类的内容；版本变更历史只属于 CHANGELOG/log 文档
- 对外文档只描述当前行为：README、用户文档等不写 v1/v2 版本相关问题与新旧对比；版本差异只出现在 CHANGELOG/发布说明
- 不允许假绿：禁止为过门禁加 skip、注释或删除断言、调低覆盖率阈值；禁止 `UNSAFE_*` 查询（RNTL v14 已移除，用了断言永不执行而测试仍能编译，门禁对真实缺陷直接失明）；catch 块不得 `void error` 吞异常（要么降级返回空形态，要么可见化）
- 禁止 `git stash` / `git reset --hard` 等一切销毁性 git 操作

## 代码风格

- TypeScript strict；结果用判别联合（`{ ok: true; ... } | { ok: false; reason }`）而非抛业务异常；垃圾输入返回空形态降级，不崩溃
- 错误 message 用中性英文；用户可见文案只写在文案目录（桌面 `apps/electron/src/renderer/src/strings/`、移动端 `apps/mobile/src/strings/`），禁止在组件或主进程硬编码
- 单一真相：类型与 Port 定义只住在 `packages/contracts/`；同一事实只定义一次、放最底层被依赖的包；可变值（开关/阈值）装配注入
- 一动词一文件：文件装了两件事先拆；模块单测放同目录 `__test__/`，禁止跨包引用别的包 `__test__` 私有文件（公共测试资产只有 testkit〔含 fake-hub〕与 T1 夹具库）
- 能不用 class 就不用：一切优先写成 function；仅当 class 写法在所有方面都优于 function 实现时才允许 class，非必要不使用 class
- function 保持单一职责；一个文件不要堆太多 function——围绕一件事组织，多了就拆文件
- UI 纪律：一个 .tsx 只放一个组件或 hook，嵌套定义组件/hook 禁止（每次渲染重建）——由 `ui/no-multi-component` 插件强制
- 业务包不 `import 'electron'`（Electron API 只出现在 apps/electron），保证 `bun test` 零 mock 可测；依赖白名单与环境面纪律由 oxlint 插件 `x3code/*` 强制（`oxlint-plugins/x3code/`，宪法见 `.oxlintrc.json`：改规则 = 修宪法，就近同步插件测试）
- 注释只说明当前代码的作用与用途，以及代码表达不了的约束（协议事实、事件时序约定、平台坑）；禁止版本叙事（某版本改了什么/修复了什么），那是 log 文档的职责
- 格式化用 oxfmt（非门禁）；命名与注释密度跟随所在模块现状
- 禁止写代码注释

## 验证

每个里程碑完成 = 该步骤 `__test__` 测试全绿 + 门禁全绿（对照 `tasks/` 各文档「实施顺序」表）：

- 含契约/并发/安全面的批次必须过独立会话对抗审查（审 diff + 方案节选：契约、不处理清单、并发预算）；integration/混沌在夜间门，E2E 在发版门
- 每个修复的 bug 必须带回归用例，用例名注明症状
- 汇报必须如实报告用例数与覆盖率数字；「门禁全绿」不等于「覆盖率达标」

## UI 测试（bw 真机走查）

渲染层交互改动在四门之外补真机走查：bw CLI 驱动真实 Electron 窗口（skill `~/.pai/agent/skills/bw`），断言实际渲染文本而非组件快照。测试装置全放 /tmp，不进仓库。

1. **构建 + 隔离启动**：`apps/electron` 下 `bun run build` 产 `out/`，再 `X3CODE_USER_DATA_DIR=/tmp/pai-ui-test bw s create --electron node_modules/electron/dist/Electron.app/Contents/MacOS/Electron --electron-arg . --allow-eval`（cwd = apps/electron）。`X3CODE_USER_DATA_DIR` 重定向拿独立单实例锁与数据区——同 userData 双开即第二实例静默退出（exit 0）；`bw s close` 连带收走 `--electron` 拉起的 app。
2. **隔离数据预置**（均落 `$X3CODE_USER_DATA_DIR`）：
   - `settings.json`：providers（渠道 + `api` 协议 + models）、`defaultModel`/`projectModels` 钉住测试模型、`onboarded: true` 跳引导。
   - `agent/credentials.json`（0600）：hub 凭据（优先序 credentials > providers.json 字面 > apiKeyEnv）。app keyStore 走 safeStorage 不可预置，shell env 注入会被 hub spawn 白名单剥掉，这里是唯一不碰真凭据的注入点。
   - `agent/sessions/<id>/{header.json,events.jsonl}` + `registry.sqlite` 行 = 预置历史会话（侧栏 parked 懒恢复）；档案先过 x-harness 自己的 `validateSessionEvents` + 归档读取器再落盘。注意 parked 会话读不唤醒：stats/上下文分析要发一条消息唤醒线程后才拉得到。
3. **mock 模型服务**：本地 OpenAI SSE（`/chat/completions` 末帧带 `usage`），providers.baseUrl 指它——一轮对话零外部成本、usage 数字可控。
4. **驱动与断言**：`snap` 看可交互元素（索引随动作重排），`click`/`type`/`press` 操作，`eval` 取 DOM 文本做正/反断言，`look --out` 留截图。已知坑：clicktext 参数串撞敏感词（如「发送消息」）返回 `CONFIRMATION_REQUIRED`（确认即执行，未经许可不批）；发送按钮只有 aria-label（clicktext 只认可见文本），用输入框 `press Enter` 发送；`file://` 页面 click 偶发 `POLICY_BLOCKED: scheme not allowed: file:`，换 clicktext/press/eval 路径。
5. **收尾**：`bw s close`；临时数据留 /tmp 复用，不入库。

### 移动端（apps/mobile）走查

桌面端装置不能覆盖移动端：移动端无 Electron 可开窗，走 `expo start --web` + bw 浏览器。

1. **起Metro**：`cd apps/mobile && bun run web --port 8099`（后台常驻）；`curl localhost:8099` 期望 200。
2. **建会话**：`bw s create --url http://localhost:8099 --backend chrome --allow-eval --allow-private-network`——`--allow-private-network` 必需，否则 `POLICY_BLOCKED`。
3. **状态不可预置**：web 形态长期钥只走 sessionStorage、原生走 SecureStore（`credentials.ts`），**重启即失**。每次走查必须从「未配对」起点走完整配对流程，不得预置数据直接测功能。
4. **断言走 extract 不走 eval**：本环境 RN Web 页面的 `eval` 返回值不可用（恒 `{}`），`extract_code` 沙箱亦无 `document`；用 `snap`/`extract`。
5. **必跑的四条journey**（各自对应一类已修缺陷，详见 `/tmp/mobile-bw-walkthrough.md`）：配对发现（失败文案非空）、发送失败可见性（文案逐字可读不截断）、**从搜索/归档页打开会话后发消息**（回复必须落在当前会话）、断线自动恢复（无需手动重连）。
6. **收尾**：`bw s close`；装置与数据留/tmp，不入库。

## 提交与交付规范

- 只能提交自己改动的代码：只提交自己点名的文件路径；共享产物混有他人未提交变更时不提交，留待协调；他人在途的门禁失败如实标注归属，不越界代修
- 并行开发使用 git worktree 物理隔离，不共享工作区
- 没有 push 指令：只允许 commit，禁止任何 push / publish 操作
- Conventional Commits，正文引用任务文档节号（如 `T4 §实施顺序 M2`）；小步提交、每步可回滚、门禁全绿后再提交
- 方案与代码同变：实现推翻方案时，同一提交内先改文档再改代码，禁止口头漂移