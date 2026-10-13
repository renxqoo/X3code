/** 中文错误文案查表（自 zh.ts 拆出；键集与 en 表经 ErrorCopyTable 编译期对齐）。 */
import type { ApiError, TransientFace } from '@x3code/contracts';

import type { ErrorCopyTable } from './en-error-copy';

/** 跨节共用句（flow/thread 提示与 errorCopy 查表同一句子，单一真相；与 en 表逐句对齐） */
export const imagesDeniedCopy = '当前模型不接受图片附件，请移除附件或切换到多模态模型。';
export const imagesTooManyCopy = '图片附件超出限制（最多 8 张），请减少附件。';
export const noActiveSessionCopy = '当前没有进行中的会话，请先新建任务（⌘N）。';
export const resumeFailedCopy = '会话恢复失败，请重试。';
export const openEditorMissingCopy = '未找到可用的编辑器，可安装 code、cursor 或 zed CLI 后重试。';
export const bashImagesRejectedCopy = '直执行命令不支持携带图片，请移除附件或改用消息发送。';

/** transient 族 host_* 面孔共用句（宿主代际切换窗口的各形态对用户是同一件事） */
const hostNotReadyCopy = 'agent 宿主未就绪（正在启动或重启），请稍后重试。';
/** transient 细分面孔句（face 是瞬态失败的可读面孔——kind 恒为 transient 无区分度） */
const transientFaceCopy: Record<TransientFace, string> = {
  busy: '宿主忙，请稍后重试。',
  timeout: '操作超时，请重试。',
  host_unavailable: hostNotReadyCopy,
  host_restarting: hostNotReadyCopy,
  host_failed: hostNotReadyCopy,
  host_not_running: hostNotReadyCopy,
  host_disposed: hostNotReadyCopy,
  write_failed: '写入失败，请重试。',
  command_failed: '命令执行失败，请重试。',
  bridge_unavailable: '与主进程的连接不可用，请重试。',
};

/** ApiError → 展示文案（W2 查表收口：kind 分派替代 reason 串嗅探） */
export const zhErrorCopy = {
  unknown_thread: '会话已失效，请重新打开该会话。',
  thread_superseded: '该会话已被分叉替换，请在新的会话中继续。',
  thread_not_live: '会话不在活跃状态，请重新打开后重试。',
  session_unreadable: '会话文件无法读取，可能已损坏。',
  already_open: '该会话已打开。',
  thread_limit: '会话数量已达上限，请关闭部分会话后重试。',
  streaming_window: '会话正在回复中，请等待完成后再试。',
  invalid_input: '输入不合法，请检查后重试。',
  unknown_command: '未知命令。',
  capability_thinking: '所选思考档被拒绝：该模型未声明支持思考——在渠道设置的模型行打开「思考」开关，或把思考档调回「默认」。',
  capability_images: imagesDeniedCopy,
  capability_plugin: '上下文分析插件未装载：模型上下文用量指示不可用（可在 hub 设置 plugins.disabled 中移除禁用）。',
  images_too_many: imagesTooManyCopy,
  model_unavailable: '所选模型不可用，请在设置中检查 Provider 配置。',
  cursor_stale: '会话视图已过期，请刷新后重试。',
  state_conflict: '状态已发生变化，请刷新后重试。',
  name_conflict: '同名条目已存在，请换一个名称。',
  trust_required: '该操作需要受信模式，请以受信模式重开会话。',
  path_forbidden: '该路径不在允许范围内。',
  io_failed: '读写失败，请重试。',
  internal: '内部错误，请重试。',
  bash_denied: '命令被拒绝执行。',
  protocol: '协议错误，请重试或重启应用。',
  compact_rejected: '上下文压缩被拒绝，请稍后重试。',
  plugin_install_failed: '插件装载失败，请查看错误详情。',
  plugin_uninstall_failed: '插件卸载失败（可能存在依赖或装载态异常）。',
  plugin_source_invalid: '插件源目录无效（缺少 plugin.json 或含 SDK 依赖）。',
  plugin_name_invalid: '插件名无效。',
  plugin_exists: '同名插件已安装。',
  plugin_builtin_immutable: '内置插件不可删除，只能停用。',
  unregistered_code: (error: ApiError): string => {
    if (error.kind !== 'unregistered_code') return error.message ?? error.kind;
    return error.message.length === 0 ? error.code : `${error.code}: ${error.message}`;
  },
  transient: (error: ApiError): string => {
    if (error.kind !== 'transient') return error.message ?? error.kind;
    const base = transientFaceCopy[error.face];
    return error.message === undefined || error.message.length === 0 ? base : `${base}（${error.message}）`;
  },
  provider_name_conflict: '渠道名与现有渠道的环境变量名冲突，请换个名字。',
  provider_api_unsupported: '协议不受支持（仅 Anthropic / OpenAI 兼容）。',
  provider_baseurl_invalid: '接口地址需以 http:// 或 https:// 开头。',
  provider_baseurl_changed: '接口地址变更后需重新录入该渠道的密钥（防止存量密钥被发往新地址）。',
  settings_unavailable: '本地设置文件暂时无法读取，已取消本次保存以保护现有配置，请重试。',
  invalid_params: '参数不合法，请检查后重试。',
  internal_error: '内部错误，请重试。',
  unknown_method: '未知方法。',
  invalid_payload: '数据载荷不合法。',
  malformed_response: '响应格式异常，请重试。',
  unknown_session: '会话不存在或已关闭。',
  thread_id_mismatch: '会话标识不匹配，请重新打开会话。',
  session_path_forbidden: '会话路径不在允许范围内。',
  cwd_not_allowed: '该目录不在允许范围内。',
  cwd_forbidden: '当前目录不可访问。',
  cwd_not_found: '工作目录不存在，可能已被移动或删除。',
  export_failed: '导出失败，请重试。',
  dialog_unavailable: '系统对话框不可用，请重试。',
  editor_not_found: openEditorMissingCopy,
  skill_not_found: '未找到该技能，可能已被移除。',
  skill_source_invalid: '技能来源不可用：目录里没有 SKILL.md，或路径无效。',
  skill_invalid: '技能无法解析：frontmatter 不符合装载器要求（需要扁平的 name/description 行，且 SKILL.md 不超过 1MB）。',
  skill_name_invalid: '技能名称不合法：仅允许字母、数字开头，其余为字母、数字、点、下划线或连字符（≤64 字符）。',
  skill_exists: '同名技能已安装：可勾选「覆盖」后重试。',
  skill_write_failed: '技能写入失败：已回滚，既有技能未受影响。',
  skill_not_registered: '技能已写入，但清单回读未见该技能：装载面可能不同步，请重开应用后查看。',
  skill_not_supported: '当前 x-harness 版本不支持技能安装：请升级 x-harness 后重试。',
  branch_exists: '同名分支已存在，换一个名称。',
  invalid_branch: '分支名不合法，请换个名称。',
  dirty_worktree: '工作区有未提交改动，先提交或暂存后再切换分支。',
  branch_in_other_worktree: '该分支已被另一个 worktree 检出（详见错误信息中的路径）。',
  conflict_files: '切换会覆盖以下未提交文件：详见错误信息中的清单。',
  unknown_branch: '目标分支不存在，请刷新后重试。',
  not_a_repo: '该目录不是 git 仓库。',
  git_unavailable: '系统未找到 git 命令，无法操作分支。',
  empty_message: '消息内容为空。',
  no_active_session: noActiveSessionCopy,
  resume_failed: resumeFailedCopy,
  bootstrap_crashed: '应用启动失败，请重启后重试。',
  compact_images_rejected: '压缩请求不支持携带图片附件。',
  bash_images_rejected: bashImagesRejectedCopy,
} satisfies ErrorCopyTable;

/** transient face 词表判定（与 transientFaceCopy 同源闭集）：submitDraft 透传的
 * 失败串按此窄化——新增 face 随 Record 编译期强制带文案，词表不会漂移。 */
export function isTransientFace(token: string): token is TransientFace {
  return token in transientFaceCopy;
}
