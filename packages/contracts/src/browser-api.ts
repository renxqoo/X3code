import { z } from 'zod';

/**
 * 浏览器面板契约（T61）：共享 Chrome + bw attach 双客户端架构。
 * 面板投屏/输入/拾取走 invoke；帧与状态走独立 subscribe 面
 * （x3code:browser-event，与 x3code:event 流式通道隔离）。
 * 事件词表封闭（BROWSER_EVENT_TYPES 双向断言，同 UI_EVENT_TYPES 模式）。
 */

// —— 常量（装配注入的真相源之外的固定事实）——

/** 地址栏 scheme 白名单（与 bw POLICY_BLOCKED 对齐：file:// 拒绝）。 */
export const BROWSER_URL_SCHEMES = ['http:', 'https:', 'about:', 'data:'] as const;

/** 视口预设（面板下拉；resize/viewportSet 共用）。 */
export const BROWSER_VIEWPORT_PRESETS = [
  { id: 'desktop', width: 1286, height: 832 },
  { id: 'tablet', width: 768, height: 1024 },
  { id: 'mobile', width: 375, height: 812 },
] as const;
export type BrowserViewportPresetId = (typeof BROWSER_VIEWPORT_PRESETS)[number]['id'];

/** 拾取脱敏：属性名/URL 键命中（子串、大小写不敏感）即值替换为掩码。 */
export const PICK_SENSITIVE_KEY_PATTERN = /password|token|secret|key|auth|credential/i;
/** 拾取脱敏：文本内容模式（API key 前缀 / Bearer / 长 base64 串）。 */
export const PICK_SENSITIVE_TEXT_PATTERNS = [/sk-[A-Za-z0-9_-]{8,}/g, /ghp_[A-Za-z0-9]{20,}/g, /AKIA[A-Z0-9]{12,}/g, /Bearer\s+[A-Za-z0-9._-]{12,}/g, /[A-Za-z0-9+/]{40,}={0,2}/g] as const;
export const PICK_MASK = '***';
/** outerHtml 先脱敏后截断的上限。 */
export const PICK_OUTER_HTML_LIMIT = 2048;
export const PICK_TEXT_PREVIEW_LIMIT = 120;

// —— 基础形状 ——

export const BrowserTabViewSchema = z.object({
  targetId: z.string().min(1),
  url: z.string(),
  title: z.string(),
  active: z.boolean(),
}).strict();
export type BrowserTabView = z.infer<typeof BrowserTabViewSchema>;

export const BrowserNavStateSchema = z.object({
  targetId: z.string().min(1),
  url: z.string(),
  canBack: z.boolean(),
  canForward: z.boolean(),
  loading: z.boolean(),
}).strict();
export type BrowserNavState = z.infer<typeof BrowserNavStateSchema>;

/** 投屏帧 metadata（CDP screencastFrame metadata 透传；渲染层画布→页面坐标换算依据）。 */
export const BrowserFrameMetaSchema = z.object({
  deviceWidth: z.number().int().positive(),
  deviceHeight: z.number().int().positive(),
  pageScaleFactor: z.number().positive(),
}).strict();
export type BrowserFrameMeta = z.infer<typeof BrowserFrameMetaSchema>;

/** host 相位（与既有 host 事件相位词表区分：多 chromeMissing 引导态）。 */
export const BROWSER_HOST_PHASES = ['starting', 'ready', 'restarting', 'failed', 'chromeMissing'] as const;
export type BrowserHostPhase = (typeof BROWSER_HOST_PHASES)[number];

// —— 输入事件（判别联合：四类异形参数）——

export const BrowserInputEventSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('mouse'),
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    button: z.enum(['left', 'right', 'middle']),
    press: z.boolean(),
    clickCount: z.number().int().positive().max(3).default(1),
  }).strict(),
  z.object({
    kind: z.literal('wheel'),
    x: z.number().finite().nonnegative(),
    y: z.number().finite().nonnegative(),
    deltaX: z.number().finite(),
    deltaY: z.number().finite(),
  }).strict(),
  z.object({
    kind: z.literal('key'),
    key: z.string().min(1).max(64),
    down: z.boolean(),
    modifiers: z.array(z.enum(['alt', 'ctrl', 'meta', 'shift'])).default([]),
  }).strict(),
  z.object({
    kind: z.literal('insertText'),
    text: z.string().min(1).max(1000),
  }).strict(),
]);
export type BrowserInputEvent = z.infer<typeof BrowserInputEventSchema>;

// —— 拾取元素（PickedElement：脱敏管线后的定形形状）——

export const PickedElementSchema = z.object({
  tag: z.string().min(1).max(40),
  id: z.string().max(200).optional(),
  classes: z.array(z.string().max(100)).max(20),
  ariaLabel: z.string().max(100).optional(),
  textPreview: z.string().max(120),
  selector: z.string().max(200),
  bbox: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).strict(),
  styles: z.object({
    fontSize: z.string().max(40), color: z.string().max(60), backgroundColor: z.string().max(60),
    margin: z.string().max(80), padding: z.string().max(80), display: z.string().max(40),
  }).strict(),
  outerHtml: z.string().max(2048),
  pageUrl: z.string().max(2048),
}).strict();
export type PickedElement = z.infer<typeof PickedElementSchema>;

// —— invoke 方法 schema ——

const targetIdOnly = z.object({ targetId: z.string().min(1) }).strict();

export const BrowserApiSchemas = {
  'browser/bootstrap': {
    params: z.object({}).strict(),
    result: z.object({
      status: z.enum(['starting', 'ready', 'chromeMissing', 'failed']),
      cdpEndpoint: z.string().nullable(),
      chromePath: z.string().nullable(),
      tabs: z.array(BrowserTabViewSchema),
      activeTargetId: z.string().nullable(),
      viewport: BrowserFrameMetaSchema.nullable(),
      navStates: z.array(BrowserNavStateSchema),
    }).strict(),
  },
  'browser/navigate': {
    params: z.object({ targetId: z.string().min(1), url: z.string().min(1).max(8192) }).strict(),
    result: z.object({ url: z.string() }).strict(),
  },
  'browser/input': {
    params: z.object({ targetId: z.string().min(1), input: BrowserInputEventSchema }).strict(),
    result: z.object({}).strict(),
  },
  'browser/tabOpen': {
    params: z.object({ url: z.string().min(1).max(8192).optional() }).strict(),
    result: z.object({ targetId: z.string().min(1) }).strict(),
  },
  'browser/tabClose': {
    params: targetIdOnly,
    result: z.object({}).strict(),
  },
  'browser/debugQuery': {
    params: z.object({ targetId: z.string().min(1), source: z.enum(['console', 'errors', 'requests', 'perf']) }).strict(),
    result: z.union([
      z.object({ source: z.literal('console'), rows: z.array(z.object({ level: z.string().max(20), text: z.string().max(2000) }).strict()) }).strict(),
      z.object({ source: z.literal('errors'), rows: z.array(z.object({ level: z.literal('error'), text: z.string().max(2000) }).strict()) }).strict(),
      z.object({ source: z.literal('requests'), rows: z.array(z.object({ url: z.string().max(2048), method: z.string().max(10), status: z.number().int(), durationMs: z.number(), size: z.number() }).strict()) }).strict(),
      z.object({ source: z.literal('perf'), summary: z.string().max(4000) }).strict(),
    ]),
  },
  'browser/confirm': {
    params: z.object({ sid: z.string().min(1), cid: z.string().min(1), approve: z.boolean() }).strict(),
    result: z.object({ ok: z.boolean() }).strict(),
  },
  'browser/pickElement': {
    params: z.object({ targetId: z.string().min(1), x: z.number().finite().nonnegative().max(7680), y: z.number().finite().nonnegative().max(4320) }).strict(),
    result: z.object({
      element: PickedElementSchema,
      shotB64: z.string(),
    }).strict(),
  },
  'browser/tabActivate': {
    params: targetIdOnly,
    result: z.object({}).strict(),
  },
  'browser/viewportSet': {
    params: z.object({
      targetId: z.string().min(1),
      width: z.number().int().positive().max(7680),
      height: z.number().int().positive().max(4320),
      preset: z.enum(['desktop', 'tablet', 'mobile']).optional(),
    }).strict(),
    result: z.object({}).strict(),
  },
  'browser/streamStart': {
    params: z.object({ targetId: z.string().min(1), maxWidth: z.number().int().positive().max(3840), maxHeight: z.number().int().positive().max(2160) }).strict(),
    result: z.object({}).strict(),
  },
  'browser/streamStop': {
    params: targetIdOnly,
    result: z.object({}).strict(),
  },
} as const;

// —— 事件帧（独立 subscribe 面：x3code:browser-event）——

const browserEventDefs = {
  frame: z.object({
    type: z.literal('frame'),
    targetId: z.string().min(1),
    /** 停/复流世代号：同 target 旧世代帧渲染层直接丢弃。 */
    streamEpoch: z.number().int().nonnegative(),
    jpegB64: z.string().min(1),
    meta: BrowserFrameMetaSchema,
  }).strict(),
  tabsChanged: z.object({
    type: z.literal('tabsChanged'),
    tabs: z.array(BrowserTabViewSchema),
  }).strict(),
  action: z.object({
    type: z.literal('action'),
    targetId: z.string().min(1),
    kind: z.enum(['click', 'input', 'change', 'keydown', 'scroll']),
    x: z.number().finite().nonnegative().optional(),
    y: z.number().finite().nonnegative().optional(),
    /** 元素简述（钩子生成：tag#id[aria]{text}），敌意输入防御见 supervisor。 */
    elementLabel: z.string().max(200).optional(),
  }).strict(),
  navState: BrowserNavStateSchema.extend({ type: z.literal('navState') }).strict(),
  viewportChanged: z.object({
    type: z.literal('viewportChanged'),
    targetId: z.string().min(1),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }).strict(),
  hostState: z.object({
    type: z.literal('hostState'),
    phase: z.enum(BROWSER_HOST_PHASES),
    cdpEndpoint: z.string().nullable().optional(),
    detail: z.string().max(500).optional(),
  }).strict(),
  confirmNotice: z.object({
    type: z.literal('confirmNotice'),
    sid: z.string().min(1),
    cid: z.string().min(1),
    reason: z.string().max(500),
  }).strict(),
};

type BrowserEventDef = (typeof browserEventDefs)[keyof typeof browserEventDefs];
export const BrowserEventSchema = z.discriminatedUnion(
  'type',
  Object.values(browserEventDefs) as [BrowserEventDef, ...BrowserEventDef[]],
);
export type BrowserEvent = z.infer<typeof BrowserEventSchema>;

/** 事件词表（封闭：新增事件必须先改本表，测试双向断言）。 */
export const BROWSER_EVENT_TYPES = Object.keys(browserEventDefs) as readonly (keyof typeof browserEventDefs)[];

// 编译期封闭断言：词表与判别联合双向绑定（漏登记即编译失败）。
type CoversUnion<T, U extends T> = [T] extends [U] ? unknown : never;
const _browserEventsCover = null as unknown as CoversUnion<BrowserEvent['type'], (typeof BROWSER_EVENT_TYPES)[number]>;
void _browserEventsCover;
