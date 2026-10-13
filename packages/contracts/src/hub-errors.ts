/**
 * x-harness 错误码表协议镜像（T40 §2.1/§2.6）：码表单一真相在 hub 侧
 * apps/host-hub/src/shared/errors.ts；本镜像供类型/解码消费，漂移由握手对拍拦截
 * （hub get_host_info.errorCodes 与本表集合相等断言）。
 * 解码层形状守卫（isWireError）只验形状不验词表成员——新版本 hub 的未登记 code
 * 必须以原文透传（unregistered_code 兜底族），不得丢弃。
 */

export const HUB_ERROR_CODES = [
  'unknown_thread',
  'thread_superseded',
  'thread_not_live',
  'session_unreadable',
  'already_open',
  'thread_limit',
  'streaming_window',
  'invalid_input',
  'unknown_command',
  'capability_thinking',
  'capability_images',
  'capability_plugin',
  'images_too_many',
  'model_unavailable',
  'cursor_stale',
  'state_conflict',
  'name_conflict',
  'trust_required',
  'path_forbidden',
  'io_failed',
  'internal',
  'bash_denied',
  'protocol',
  'compact_rejected',
  'plugin_install_failed',
  'plugin_uninstall_failed',
] as const;

export type HubErrorCode = (typeof HUB_ERROR_CODES)[number];

export interface HubErrorShape {
  code: string;
  message: string;
}

/** 线上错误形状守卫（不校验词表成员——未登记 code 透传到兜底族） */
export function isWireError(value: unknown): value is HubErrorShape {
  if (typeof value !== 'object' || value === null) return false;
  const record = value as Record<string, unknown>;
  return typeof record['code'] === 'string' && typeof record['message'] === 'string';
}

export type HubError = { kind: HubErrorCode; message: string };
export type UnregisteredCodeError = { kind: 'unregistered_code'; code: string; message: string };
export type TransientFace =
  | 'busy' | 'timeout' | 'host_unavailable' | 'host_restarting' | 'host_failed'
  | 'host_not_running' | 'host_disposed' | 'write_failed' | 'command_failed' | 'bridge_unavailable';
export type TransientError = { kind: 'transient'; face: TransientFace; message?: string };

/** app 本地失败闭集（路由/渲染层自产；语义可对齐者并入同名 hub 族） */
export type AppErrorCode =
  | 'invalid_params' | 'internal_error' | 'unknown_method' | 'invalid_payload'
  | 'malformed_response' | 'unknown_session' | 'thread_id_mismatch'
  | 'session_path_forbidden' | 'cwd_not_allowed' | 'cwd_forbidden' | 'cwd_not_found'
  | 'export_failed' | 'dialog_unavailable' | 'editor_not_found' | 'skill_not_found'
  | 'branch_exists' | 'invalid_branch' | 'dirty_worktree' | 'conflict_files' | 'branch_in_other_worktree' | 'unknown_branch' | 'not_a_repo' | 'git_unavailable'
  | 'empty_message' | 'no_active_session' | 'resume_failed' | 'bootstrap_crashed' | 'compact_images_rejected'
  | 'bash_images_rejected'
  | 'skill_source_invalid' | 'skill_invalid' | 'skill_name_invalid' | 'skill_exists'
  | 'skill_write_failed' | 'skill_not_registered' | 'skill_not_supported'
  | 'plugin_source_invalid' | 'plugin_name_invalid' | 'plugin_exists' | 'plugin_builtin_immutable'
  | 'provider_name_conflict' | 'provider_api_unsupported' | 'provider_baseurl_invalid'
  | 'provider_baseurl_changed' | 'settings_unavailable';
export type AppError = { kind: AppErrorCode; message?: string };

/** 跨 IPC 的统一错误判别联合（渲染层文案查表按 kind 分派——Record 键集编译期封闭） */
export type ApiError = HubError | UnregisteredCodeError | TransientError | AppError;

/** ApiError 判别键全集（渲染层文案查表 Record 的键集：新增 kind 不加键不编译） */
export type ApiErrorKind = ApiError['kind'];
