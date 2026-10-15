/**
 * Client 接口适配（T58）：invoke/subscribe 形态与 @x3code/contracts Client 同构
 * （UI/共享包零改动消费）；实现走 RelayTransport（relay 链路）。
 */
import { UiEventSchema, type ApiMethod, type Client, type ClientCapabilities, type UiEvent, type Unsubscribe } from '@x3code/contracts';
import { readCommandError, type CommandError } from '@x3code/relay-protocol';
import { mapResponseData, translateCommand } from '../relay/command-map';

type Subscriber = (event: UiEvent) => void;

/** invoke 面（RelayTransport 的子集——注入式，测试内存桩）。 */
export interface ClientTransportFace {
  sendCommand(spec: { command: string; id: string; args?: Record<string, unknown> }): Promise<boolean>;
  waitResponse(id: string, timeoutMs?: number): Promise<{ id: string; command: string; success: boolean; data?: unknown; error?: CommandError }>;
}

export interface BridgeClientDeps {
  transport: ClientTransportFace;
  capabilities?: ClientCapabilities;
}

export interface BridgeClient extends Client {
  /** transport 事件泵接入点（装配层把 ws 回调接到这里）。 */
  dispatch(rawEvent: unknown): void;
}

// R3 H7：id 每安装随机前缀——gateway (deviceId,commandId) 去重磁盘持久，跨重启
// 同 id 碰撞会重放陈旧响应（错线程数据上屏）
const bootId = Array.from(globalThis.crypto.getRandomValues(new Uint8Array(4)))
  .map((b) => b.toString(16).padStart(2, '0'))
  .join('');
let invokeCounter = 1;

export function createBridgeClient(deps: BridgeClientDeps): BridgeClient {
  const subscribers = new Set<Subscriber>();
  return {
    capabilities: deps.capabilities ?? { fileDialog: false, systemNotification: true },
    async invoke(method: ApiMethod, params: unknown): Promise<unknown> {
      const id = `c${bootId}.${invokeCounter++}`;
      // 词表翻译（H2）：ApiMethod → gateway host 命令 + 参数名
      const { command, args } = translateCommand(method, (params ?? {}) as Record<string, unknown>);
      const transportAtSend = deps.transport; // 在途响应归旧 transport 认领（换绑不丢）
      const sent = await transportAtSend.sendCommand({ command, id, args });
      if (!sent) return { ok: false, error: { kind: 'transient', message: 'host_unavailable' } };
      const response = await transportAtSend.waitResponse(id);
      if (response.success) return { ok: true, data: mapResponseData(command, response.data) };
      // 失败原因取 CommandError.code；线上形状缺失或不成形时给显式缺因标记，
      // 展示层据此提示重试而非「未知错误」。
      // code 是文案映射的键（展示层据此查 REASON_COPY）；message 是服务端给的原始原因，
      // 对 internal 这类兜底码承载唯一线索（如 host 顶层 catch 塞的 Error.message），
      // 一并透出供诊断，不在此处丢弃。
      const parsedError = readCommandError(response.error);
      if (parsedError === null) return { ok: false, error: { kind: 'transient', message: 'no_reason' } };
      return {
        ok: false,
        error: { kind: 'transient', message: parsedError.code, reason: parsedError.message },
      };
    },
    subscribe(onEvent: (event: UiEvent) => void): Unsubscribe {
      subscribers.add(onEvent);
      return () => {
        subscribers.delete(onEvent);
      };
    },
    dispatch(rawEvent: unknown): void {
      // 运行时形状守卫（桥透传未知事件形态——旧客户端不崩新事件）
      const parsed = UiEventSchema.safeParse(rawEvent);
      if (!parsed.success) return;
      for (const subscriber of Array.from(subscribers)) {
        try {
          subscriber(parsed.data);
        } catch {
          // 单订阅者异常隔离（与 testkit MockClient 同语义）
        }
      }
    },
  };
}
