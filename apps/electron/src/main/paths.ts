import { join } from 'node:path';

/** 应用落盘布局（单一真相：全部路径从这里取）。
 *
 * 两根分离：userData 交给 Chromium（平台标准位置，承载内核产物——缓存、Cookies、
 * Local Storage、单实例锁）；dataDir 归应用自管（~/.pai，承载业务数据与 Agent 内核
 * 数据）。两者本可同根，分离是为了让 ~/.pai 只剩业务数据、免受内核产物干扰。 */
export interface AppPaths {
  /** Chromium userData：平台标准位置，随 app 身份（打包名或 npm 包名）而定。 */
  userDataDir: string;
  /** 业务数据根：设置/注册表/密钥/日志 + hub 配置与 Agent 内核数据。 */
  dataDir: string;
  /** hub 配置目录（HUB_AGENT_DIR：models.json/credentials.json/sessions/hub-settings）。 */
  agentDir: string;
  /** 会话注册表（node:sqlite）。 */
  registryDb: string;
  /** 应用设置（不含 key）。 */
  settingsFile: string;
  /** provider key 加密存储。 */
  providerKeysFile: string;
  /** 主进程日志（尺寸截断轮转）。 */
  logFile: string;
}

export function resolveAppPaths(userDataDir: string, dataDir: string): AppPaths {
  return {
    userDataDir,
    dataDir,
    agentDir: join(dataDir, 'agent'),
    registryDb: join(dataDir, 'registry.sqlite'),
    settingsFile: join(dataDir, 'settings.json'),
    providerKeysFile: join(dataDir, 'provider-keys.json'),
    logFile: join(dataDir, 'main.log'),
  };
}

/** 业务数据根：缺省 home 下 .pai；X3CODE_USER_DATA_DIR 非空整体重定向。
 * 空串视为未设置，避免把数据根清成空路径。 */
export function resolveDataDir(env: { X3CODE_USER_DATA_DIR?: string }, home: string): string {
  const override = env.X3CODE_USER_DATA_DIR;
  return override !== undefined && override.length > 0 ? override : join(home, '.pai');
}

/** Chromium userData：缺省沿用 Electron 依应用身份给出的平台标准位置；
 * X3CODE_USER_DATA_DIR 非空时整体重定向，让 worktree 并行实例连同单实例锁
 * 一起获得独立数据区——锁文件随 userData 走，锁与业务数据分处两地会失效。 */
export function resolveUserDataDir(
  env: { X3CODE_USER_DATA_DIR?: string },
  platformUserDataDir: string,
): string {
  const override = env.X3CODE_USER_DATA_DIR;
  return override !== undefined && override.length > 0 ? override : platformUserDataDir;
}