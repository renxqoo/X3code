/**
 * hub spawn env 白名单构造：宿主环境只携带进程运行所必需的系统变量，
 * 一切模型渠道凭据（OPENAI_API_KEY、ANTHROPIC_AUTH_TOKEN 等第三方 env key）
 * 不得透传——hub 侧 pi 会把「有 env key 的内置渠道」判定为可用模型，
 * 渠道真相只允许来自 app 设置面注入的 $X3CODE_KEY_*。
 */

/**
 * 具名放行：进程运行与网络栈必需的系统变量（跨平台并集；多平台多余项无害）。
 * 匹配大小写不敏感（Windows 环境块保留原始大小写：SystemRoot/windir/ComSpec）。
 */
const NAMED_ALLOW = new Set([
  'PATH',
  'HOME',
  'LANG',
  'LANGUAGE',
  'TERM',
  'SHELL',
  'USER',
  'LOGNAME',
  'TMPDIR',
  'TZ',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'SSH_AUTH_SOCK',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'SYSTEMROOT',
  'SYSTEMDRIVE',
  'COMSPEC',
  'APPDATA',
  'LOCALAPPDATA',
  'PROGRAMFILES',
  'PROGRAMDATA',
  'USERPROFILE',
  'WINDIR',
  'PUBLIC',
  'OS',
  'TEMP',
  'TMP',
  'HOMEDRIVE',
  'HOMEPATH',
  'USERNAME',
  'PATHEXT',
  'PROCESSOR_ARCHITECTURE',
]);

/** 前缀放行：区域化与桌面环境变量族。 */
const PREFIX_ALLOW = ['LC_', 'XDG_'];

/** 过滤后的宿主 env（新对象；键保留原始大小写，不修改入参）。注入面（$X3CODE_KEY_* 等）由调用方合并。 */
export function hubSpawnEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    const upper = name.toUpperCase();
    // 代理变量的两种历史形态都放行（curl 系小写 / 工具链大写）
    const proxy = upper.endsWith('_PROXY') && ['HTTP', 'HTTPS', 'ALL', 'NO'].includes(upper.slice(0, -6));
    if (!NAMED_ALLOW.has(upper) && !proxy && !PREFIX_ALLOW.some((prefix) => upper.startsWith(prefix))) continue;
    out[name] = value;
  }
  return out;
}
