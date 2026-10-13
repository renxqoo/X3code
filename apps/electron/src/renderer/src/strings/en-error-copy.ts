/** 英文错误文案查表（自 en.ts 拆出：kind 全集分派 + 跨节共享句单一真相）。 */
import type { ApiError, ApiErrorKind, TransientFace } from '@x3code/contracts';

/** 错误文案查表：键集 = ApiErrorKind 全集（Record 编译期封闭——新增 kind 不加键不编译）；
 *  函数值用于 transient（face 细分）与 unregistered_code（原文透传）。 */
export type ErrorCopyTable = Record<ApiErrorKind, string | ((error: ApiError) => string)>;

/** 跨节共用句（flow/thread 提示与 errorCopy 查表同一句子，单一真相） */
export const imagesDeniedCopy = 'This model does not accept image attachments. Remove them or switch to a multimodal model.';
export const imagesTooManyCopy = 'Too many image attachments (max 8). Remove some.';
export const noActiveSessionCopy = 'No active session — start a new task first (⌘N).';
export const resumeFailedCopy = 'Resuming the conversation failed. Try again.';
export const openEditorMissingCopy = 'No editor found. Install the code, cursor, or zed CLI and retry.';
export const bashImagesRejectedCopy = 'Direct commands cannot carry images. Remove them or send as a message.';

/** transient 族 host_* 面孔共用句（宿主代际切换窗口的各形态对用户是同一件事） */
const hostNotReadyCopy = 'The agent host is not ready (starting or restarting). Try again shortly.';
/** transient 细分面孔句（face 是瞬态失败的可读面孔——kind 恒为 transient 无区分度） */
const transientFaceCopy: Record<TransientFace, string> = {
  busy: 'The agent host is busy. Try again shortly.',
  timeout: 'The operation timed out. Try again.',
  host_unavailable: hostNotReadyCopy,
  host_restarting: hostNotReadyCopy,
  host_failed: hostNotReadyCopy,
  host_not_running: hostNotReadyCopy,
  host_disposed: hostNotReadyCopy,
  write_failed: 'The write failed. Try again.',
  command_failed: 'The command failed. Try again.',
  bridge_unavailable: 'The app bridge is unavailable. Try again.',
};

/** ApiError → 展示文案（W2 查表收口：kind 分派替代 reason 串嗅探） */
export const enErrorCopy = {
  unknown_thread: 'This conversation is no longer available. Reopen it and try again.',
  thread_superseded: 'This conversation was superseded by a fork. Continue in the new one.',
  thread_not_live: 'The conversation is not active. Reopen it and try again.',
  session_unreadable: 'The conversation file could not be read. It may be corrupted.',
  already_open: 'This conversation is already open.',
  thread_limit: 'The conversation limit was reached. Close some conversations and try again.',
  streaming_window: 'The conversation is still responding. Try again once it finishes.',
  invalid_input: 'Invalid input. Check it and try again.',
  unknown_command: 'Unknown command.',
  capability_thinking: 'The selected thinking level was rejected: the model does not declare reasoning support — turn on the "Reasoning" toggle on its model row in channel settings, or set effort back to Default.',
  capability_images: imagesDeniedCopy,
  capability_plugin: 'Context analytics plugin not loaded: the context usage indicator is unavailable (remove it from plugins.disabled in hub settings).',
  images_too_many: imagesTooManyCopy,
  model_unavailable: 'The selected model is unavailable. Check the provider configuration in Settings.',
  cursor_stale: 'The conversation view is out of date. Refresh and try again.',
  state_conflict: 'The state changed while you were working. Refresh and try again.',
  name_conflict: 'An entry with that name already exists. Pick another name.',
  trust_required: 'This operation requires trusted mode. Reopen the conversation as trusted.',
  path_forbidden: 'That path is outside the allowed scope.',
  io_failed: 'A read or write failed. Try again.',
  internal: 'An internal error occurred. Try again.',
  bash_denied: 'The command was denied.',
  protocol: 'A protocol error occurred. Retry or restart the app.',
  compact_rejected: 'Context compaction was rejected. Try again later.',
  plugin_install_failed: 'Plugin failed to load. Check error details.',
  plugin_uninstall_failed: 'Plugin failed to unload (dependencies or load-state issue).',
  plugin_source_invalid: 'Invalid plugin source (missing plugin.json or contains SDK imports).',
  plugin_name_invalid: 'Invalid plugin name.',
  plugin_exists: 'A plugin with this name is already installed.',
  plugin_builtin_immutable: 'Built-in plugins cannot be removed, only disabled.',
  unregistered_code: (error: ApiError): string => {
    if (error.kind !== 'unregistered_code') return error.message ?? error.kind;
    return error.message.length === 0 ? error.code : `${error.code}: ${error.message}`;
  },
  transient: (error: ApiError): string => {
    if (error.kind !== 'transient') return error.message ?? error.kind;
    const base = transientFaceCopy[error.face];
    return error.message === undefined || error.message.length === 0 ? base : `${base} (${error.message})`;
  },
  provider_name_conflict: 'Channel name collides with an existing channel on its key variable — pick another name.',
  provider_api_unsupported: 'Protocol unsupported (Anthropic / OpenAI compatible only).',
  provider_baseurl_invalid: 'Base URL must start with http:// or https://.',
  provider_baseurl_changed: 'The base URL changed — re-enter this channel\'s API key so the stored one is not sent to the new host.',
  settings_unavailable: 'The local settings file could not be read; the save was cancelled to protect existing configuration. Please retry.',
  invalid_params: 'Invalid parameters. Check them and try again.',
  internal_error: 'An internal error occurred. Try again.',
  unknown_method: 'Unknown method.',
  invalid_payload: 'The payload is invalid.',
  malformed_response: 'The response was malformed. Try again.',
  unknown_session: 'The conversation does not exist or was closed.',
  thread_id_mismatch: 'The conversation id does not match. Reopen the conversation.',
  session_path_forbidden: 'The conversation path is outside the allowed scope.',
  cwd_not_allowed: 'That directory is outside the allowed scope.',
  cwd_forbidden: 'The current directory is not accessible.',
  cwd_not_found: 'The working directory does not exist. It may have been moved or deleted.',
  export_failed: 'Export failed. Try again.',
  dialog_unavailable: 'The system dialog is unavailable. Try again.',
  editor_not_found: openEditorMissingCopy,
  skill_not_found: 'That skill was not found. It may have been removed.',
  skill_source_invalid: 'Skill source is unusable: no SKILL.md in the directory, or the path is invalid.',
  skill_invalid: 'Skill cannot be parsed: the frontmatter does not meet loader requirements (flat name/description lines, SKILL.md under 1MB).',
  skill_name_invalid: 'Invalid skill name: start with a letter or digit, then letters, digits, dot, underscore, or hyphen (up to 64 characters).',
  skill_exists: 'A skill with this name is already installed. Enable "Overwrite" and retry.',
  skill_write_failed: 'Skill write failed: rolled back; existing skills are unaffected.',
  skill_not_registered: 'The skill was written but is missing from the skill list; the loader view may be out of sync. Reopen the app and check.',
  skill_not_supported: 'This x-harness version does not support skill installation. Upgrade x-harness and retry.',
  branch_exists: 'A branch with that name already exists. Pick another name.',
  invalid_branch: 'That branch name is not valid. Pick another name.',
  dirty_worktree: 'The working tree has uncommitted changes. Commit or stash them before switching branches.',
  branch_in_other_worktree: 'This branch is already checked out in another worktree (see path in the error detail).',
  conflict_files: 'Switching would overwrite uncommitted files (see list in the error detail).',
  unknown_branch: 'That branch no longer exists. Refresh and try again.',
  not_a_repo: 'That folder is not a git repository.',
  git_unavailable: 'git was not found on this system, so branches cannot be changed.',
  empty_message: 'The message is empty.',
  no_active_session: noActiveSessionCopy,
  resume_failed: resumeFailedCopy,
  bootstrap_crashed: 'The app failed to start. Restart it and try again.',
  compact_images_rejected: 'Compaction requests cannot carry image attachments.',
  bash_images_rejected: bashImagesRejectedCopy,
} satisfies ErrorCopyTable;
