import { z } from "zod";

/**
 * 应用设置（主进程 settings.json 的形状）。
 * provider 的 apiKey 只存主进程（safeStorage 加密落盘），任何 API 响应不回传。
 */

/** 自定义模型条目：id + 能力声明（reasoning=false 思考档建议 Off；vision=true 写 providers.json 的 input ["text","image"]——false 时 hub 能力门对携图 prompt 硬拒）。 */
export const ProviderModelSchema = z
  .object({
    id: z.string().min(1),
    /** providers.json 的模型级 reasoning 能力（决定思考档位可选的提示面）。 */
    reasoning: z.boolean(),
    /** providers.json 的模型级 input 模态声明（true → ["text","image"]；自建多模态模型必须声明，否则 hub 能力门拒图）。 */
    vision: z.boolean().default(false),
    /** providers.json 的模型级 contextWindow（compaction 触发阈值；缺省回落 hub 默认）。 */
    contextWindow: z.number().int().positive().optional(),
    /** providers.json 的模型级 maxTokens（单次输出上限；缺省回落 hub 默认）。 */
    maxTokens: z.number().int().positive().optional(),
  })
  .strict();
export type ProviderModel = z.infer<typeof ProviderModelSchema>;

/**
 * API 协议词表（host-hub providers.json 的 protocol 字段同源：anthropic | openai）。
 * 词表外协议 hub 目录不接受（写入即被剔除降级）。
 */
export const ApiFormatSchema = z.enum(["anthropic", "openai"]);
export type ApiFormat = z.infer<typeof ApiFormatSchema>;

/** 词表顺序即 UI 选项顺序（文案由 strings 提供）。 */
export const API_FORMAT_IDS: readonly ApiFormat[] = ApiFormatSchema.options;

/** 词表判定：UI 选择器据此决定「回退显示原值」还是「按词表展示」。 */
export function isApiFormat(value: string): value is ApiFormat {
  return (API_FORMAT_IDS as readonly string[]).includes(value);
}

/** 旧协议词形读盘归一（anthropic-messages→anthropic、openai-completions/responses→openai；
 *  写侧只产新词表——归一是数据迁移非兼容层；词表外语形保持原样交 UI 回退显示）。 */
export function normalizeLegacyApiFormat(value: string): string {
  if (value === "anthropic-messages") return "anthropic";
  if (value === "openai-completions" || value === "openai-responses") return "openai";
  return value;
}

export const ProviderConfigSchema = z
  .object({
    /** providers.json 的档案名（= host-hub 目录 providerId/set_model 寻址键；撞 hub 预设键会被写前校验拒绝）。 */
    name: z.string().min(1),
    baseUrl: z.string().min(1),
    /** providers.json 的 protocol 字段。持久化面保持宽松：磁盘上手写形态不得因 UI 词表收窄被判非法而整表降级丢配置。 */
    api: z.string().min(1),
    models: z.array(ProviderModelSchema).min(1),
  })
  .strict();
export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

/** 闲置自动回收档位（分钟）；词表顺序即 UI 选项顺序。 */
export const IDLE_RECYCLE_MINUTE_OPTIONS = [3, 5, 10, 15] as const;
export type IdleRecycleMinutes = (typeof IDLE_RECYCLE_MINUTE_OPTIONS)[number];
export const IdleRecycleMinutesSchema = z.union([z.literal(3), z.literal(5), z.literal(10), z.literal(15)]);

/**
 * relay 接入配置（全局统一）：settings.json 是唯一真相，agentDir/gateway.json 是
 * spawn 期由 serializeGatewayConfig 派生的落盘产物（与 providers.json 同形）。
 * remoteEnabled 缺省 true：开箱即可配对（网关内置局域网中继——使用者零配置，
 * 扫码或输 6 位码即连）。relayUrl 非空 = 自建外部中继（高级；wss 生产形态）。
 */
export const RelayConfigSchema = z
  .object({
    /** 远程接入总开关；true 且 relayUrl 空 = 内置中继（同网段直连）。 */
    remoteEnabled: z.boolean().default(true),
    /** relay WSS 基址；空串 = 内置中继。 */
    relayUrl: z.string().default(""),
    /** relay 长期身份签名指纹（wss 形态校验用；空串交由 x-harness 拒启并回原因）。 */
    relayKeyFingerprint: z.string().default(""),
  })
  .strict();
export type RelayConfig = z.infer<typeof RelayConfigSchema>;

/** 未配置 relay 的空形态（单一真相：schema 缺省与降级共用一份）。 */
export const EMPTY_RELAY_CONFIG: RelayConfig = { remoteEnabled: true, relayUrl: "", relayKeyFingerprint: "" };

/**
 * gateway.json 序列化（x-harness gateway 读口形状；本仓零自创键）。
 * 键序固定 + 末尾换行：同输入同输出，重生成不产生伪 diff（避免无谓重启）。
 */
export function serializeGatewayConfig(relay: RelayConfig): string {
  return `${JSON.stringify(
    {
      remoteEnabled: relay.remoteEnabled || relay.relayUrl.length > 0,
      relayUrl: relay.relayUrl,
      relayKeyFingerprint: relay.relayKeyFingerprint,
    },
    null,
    2,
  )}\n`;
}

export const SettingsSchema = z
  .object({
    /** 宿主注入点：bun 与 hub 入口脚本；null = 装配层缺省（打包产物路径）。 */
    hubDev: z
      .object({
        bunPath: z.string().nullable(),
        hubEntry: z.string().nullable(),
        /** gateway 入口脚本覆盖（开发形态）；null = 装配层缺省（dev 旁级探测 / 打包资源）。
         *  缺席键落 null（旧盘 hubDev 无此键不得因此整档降级）。 */
        gatewayEntry: z.string().nullable().default(null),
      })
      .default({ bunPath: null, hubEntry: null, gatewayEntry: null }),
    providers: z.array(ProviderConfigSchema).default([]),
    /** thread/start 的 trusted 缺省（项目扩展加载策略的全局默认）。 */
    trustedDefault: z.boolean().default(false),
    /** 新会话预选模型（"provider/modelId"）；null = 未设置（回落首个可用模型）。 */
    defaultModel: z.string().nullable().default(null),
    /** 首次引导完成标志（跳过也算完成；与 provider 配置解耦）。 */
    onboarded: z.boolean().default(false),
    /** 每项目默认模型记忆（cwd → "provider/modelId"；切换模型时写入）。 */
    projectModels: z.record(z.string(), z.string()).default({}),
    /** 置顶的历史会话文件（sessionPath 集合的数组形态）。 */
    pinnedSessions: z.array(z.string()).default([]),
    /** 已归档的历史会话文件（sessionPath 键）：侧栏与历史列表默认隐藏，设置页可恢复。 */
    archivedSessions: z.array(z.string()).default([]),
    /** 侧栏已移除（隐藏）的项目目录（cwd）；同目录新建任务即解除。 */
    hiddenProjects: z.array(z.string()).default([]),
    /** worker 闲置自动回收时长（分钟；spawn env HUB_IDLE_RETIRE_MS 注入 + 运行期 set_idle_retire_ms 同步）。 */
    idleRecycleMinutes: IdleRecycleMinutesSchema.default(5),
    /** relay 接入配置（全局统一；gateway.json 由 serializeGatewayConfig 派生）。 */
    relay: RelayConfigSchema.default(EMPTY_RELAY_CONFIG),
  })
  .strict();

export type Settings = z.infer<typeof SettingsSchema>;

/**
 * settings.json 宽容读取：磁盘历史形态就地迁移（provider 级退役字段剥离、
 * 模型 string[] 升级条目），无法解析的整体降级默认值（垃圾输入不清空磁盘文件，
 * 仅本次运行用缺省）。退役字段剥离是数据迁移不是兼容层——字段已从 schema
 * 删除，读旧盘数据时丢弃它把文件归一到新形态；整档降级只留给真垃圾输入。
 */
export function parseSettings(raw: unknown): Settings {
  const migrated = migrateSettings(raw);
  try {
    return SettingsSchema.parse(migrated);
  } catch {
    return SettingsSchema.parse({});
  }
}

function migrateSettings(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const record = raw as Record<string, unknown>;
  const providers = record["providers"];
  if (!Array.isArray(providers)) return raw;
  return { ...record, providers: providers.map(migrateProvider) };
}

/** provider 级退役字段剥离（thinkingFormat——写侧不再产出；读旧盘丢弃归一）+
 *  旧协议词形归一（anthropic-messages 等 → anthropic|openai）。 */
function migrateProvider(provider: unknown): unknown {
  if (typeof provider !== "object" || provider === null || Array.isArray(provider)) return provider;
  const { thinkingFormat: _retired, ...rest } = provider as Record<string, unknown> & { thinkingFormat?: unknown };
  void _retired;
  if (typeof rest["api"] === "string") rest["api"] = normalizeLegacyApiFormat(rest["api"]);
  const models = rest["models"];
  if (!Array.isArray(models)) return rest;
  return {
    ...rest,
    models: models.map((model) => (typeof model === "string" ? { id: model, reasoning: false } : model)),
  };
}
