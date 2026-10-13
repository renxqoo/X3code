import { app, BrowserWindow, dialog, ipcMain, Notification, shell } from 'electron';

import { registerIpcWindowActions } from './window-actions-ipc';
import { join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import { seedBundledRg } from './rg-seed';

import { EMPTY_RELAY_CONFIG, ApiSchemas, type UiEvent } from '@x3code/contracts';
import { appError } from '@x3code/api';

import { createApiRoutes } from './api-routes';
import { createBrowserHost } from './browser-host/browser-host';

/** Chrome 二进制发现（D7：环境变量 > 标准位置探测；null = 引导态）。 */
/** bw CLI 发现（PATH 解析；找不到 = 确认门通知链降级，不影响面板主功能）。 */
function findBwCli(): string | null {
  const pathEnv = process.env['PATH'] ?? '';
  for (const dir of pathEnv.split(':')) {
    const candidate = join(dir, 'bw');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function detectChromePath(): string | null {
  const fromEnv = process.env['BUN_CHROME_PATH'];
  if (fromEnv !== undefined && fromEnv.length > 0) return fromEnv;
  const candidates = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}
import { createSkillImporter } from './skill-import';
import { createPluginImporter } from './plugin-import';
import { createAgentDefinitionsStore } from './agent-definitions-store';
import { createFileLogger, createFileSettings } from './file-settings';
import { packagedGatewayEntry, packagedHubCandidates, resolveGatewayEntry, resolveHubPaths } from './hub-paths';
import { writeGatewayConfig } from './gateway-config';
import { resolveAppPaths, resolveDataDir, resolveUserDataDir } from './paths';
import { createPaiRuntime } from './x3code-runtime';
import { staleGateway, startGatewayProcess, type GatewayProcess } from './gateway-process';
import { createProviderKeyStore } from './provider-key-store';
import { TRAFFIC_LIGHT_Y } from '../shared/window-chrome';
import { createRuntimeMonitor } from '@x3code/infra';
import { writeDiagnosticsBundle } from './export-diagnostics';

// 开启 Web 内容可访问性树（辅助技术 + 自动化验证都依赖它）
app.commandLine.appendSwitch('force-renderer-accessibility');

// 两根分离：Chromium userData 留在平台标准位置（macOS 下 ~/Library/Application
// Support/<应用名>），只承载内核产物；业务数据与 Agent 内核数据固定落在 ~/.pai。
// 重定向必须在单实例锁之前——锁文件随 userData 走，X3CODE_USER_DATA_DIR 同时覆盖
// 两根，让 worktree 并行实例连同锁一起获得独立数据区。
const dataDir = resolveDataDir(process.env, app.getPath('home'));
app.setPath('userData', resolveUserDataDir(process.env, app.getPath('userData')));

// 单实例锁：双开会在 sqlite 注册表与 host 进程上互相踩踏，第二实例聚焦首实例后退出
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });
}

  app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

void app.whenReady().then(async () => {
  const paths = resolveAppPaths(app.getPath('userData'), dataDir);
  const logger = createFileLogger(paths.logFile);

  // 开发态 dock 用仓库内图标（打包态由 electron-builder 的 mac.icon 写入 .app 束）
  if (process.platform === 'darwin' && !app.isPackaged) {
    app.dock?.setIcon(join(__dirname, '..', '..', 'build', 'icon.png'));
  }

  let settingsRef: ReturnType<typeof createFileSettings> | null = null;

  /** 宿主路径解析：设置覆盖 > 环境变量（开发）> dev 同级探测 > 打包产物缺省（链在 hub-paths.ts）。 */
  const resolveHubPathsForRuntime = (): { bunPath: string; hubEntry: string | null } | null => {
    const fromSettings = (() => {
      try {
        const hubDev = settingsRef?.get().hubDev;
        // bunPath 非空即显式覆盖；hubEntry null = 直执行形态（bunPath 是编译产物）
        return hubDev !== undefined && hubDev.bunPath !== null
          ? { bunPath: hubDev.bunPath, hubEntry: hubDev.hubEntry }
          : null;
      } catch {
        return null;
      }
    })();
    const fromEnv =
      process.env['X3CODE_HUB_ENTRY'] !== undefined
        ? { bunPath: process.env['X3CODE_BUN_PATH'] ?? 'bun', hubEntry: process.env['X3CODE_HUB_ENTRY'] }
        : null;
    const resources = process.resourcesPath ?? paths.userDataDir;
    // 插件宿主形态优先（dist 多文件 + node_modules 子集——线程隔离插件可用）；
    // 缺 dist 资源时回落编译单文件（零插件裁剪：worker 模式装载引擎层明确拒）
    const candidates = packagedHubCandidates(resources);
    const fromPackaged = existsSync(candidates.distEntry)
      ? { bunPath: candidates.bunPath, hubEntry: candidates.distEntry }
      : existsSync(candidates.compiledEntry)
        ? { bunPath: candidates.compiledEntry, hubEntry: null }
        : null;
    return resolveHubPaths({
      fromSettings,
      fromEnv,
      fromPackaged,
      devRepoRoot: app.isPackaged ? null : join(__dirname, '..', '..', '..', '..'),
      packaged: app.isPackaged,
      exists: existsSync,
    });
  };

  let mainWindow: BrowserWindow | null = null;
  /** 事件直发渲染层：到达即逐条推 IPC，不缓冲不延迟。全序由帧到达序保证——hub
   *  同管道先发事件帧后发 response，直发下事件恒先于 invoke 结果到达渲染层。 */
  const emitToRenderer = (event: UiEvent): void => {
    notifyIfBlurred(event);
    const target = mainWindow;
    if (target === null || target.isDestroyed()) return;
    target.webContents.send('x3code:event', event);
  };

    /** K1 系统通知：窗口失焦时的权限弹窗（confirm）与 host 失败。
   *  逐事件判定，类型预筛先行——高频 delta 期零原生调用，仅触发类事件才查焦点；
   *  每个触发事件一条通知（多会话同窗 settle 各自一条，对应独立会话）。 */
  const notifyIfBlurred = (event: UiEvent): boolean => {
    let body: string;
    if (event.type === 'dialogRequest') {
      body = event.summary ?? 'Action required';
    } else if (event.type === 'host' && event.phase === 'failed') {
      body = 'Agent host failed to start.';
    } else if (event.type === 'host' && event.phase === 'restarting') {
      body = 'Agent host is restarting.';
    } else if (event.type === 'turnSettled') {
      body = 'Turn finished.';
    } else {
      return false;
    }
    if (!Notification.isSupported()) return false;
    const win = mainWindow;
    if (win !== null && !win.isDestroyed() && win.isFocused()) return false;
    new Notification({ title: 'x3code', body }).show();
    return true;
  };

  // 装配段整体兜底：任何一步失败都继续开窗（渲染层经 bootstrap 失败态进设置引导），绝不静默悬挂
  let runtime: ReturnType<typeof createPaiRuntime> | null = null;
  let routes: ReturnType<typeof createApiRoutes> | null = null;
  let monitor: ReturnType<typeof createRuntimeMonitor> | null = null;
  // 目录选择对话框单飞标志（createApiRoutes 注入面闭包引用）
  let directoryPickerInFlight = false;
  // 本次运行中经系统选择器选过的目录：新任务页对尚无会话的目录也要能读分支/切分支
  const pickedDirectories = new Set<string>();

  // 退出时序：先停 host（stdin EOF 落盘退出）再退 app；只执行一次。
  // 注册先于装配（waitForPhase 最长 30s 的 await 窗口内退出也要走停机链）；
  // runtime 未构建（装配失败降级开窗）时同样收口到 quit——可选链会短路整条
  // promise 链使 quit 永不执行，必须显式兜底为已决议的 Promise。
  let quitting = false;
  const shutdownThenQuit = (): void => {
    if (quitting) return;
    quitting = true;
    monitor?.stop();
    const stopHost = runtime !== null ? runtime.stop().catch(() => undefined) : Promise.resolve();
    void stopHost.finally(() => {
      app.quit();
    });
  };
  app.on('before-quit', (event) => {
    if (quitting) return;
    event.preventDefault();
    shutdownThenQuit();
  });
  // 信号兜底：外部 kill/系统关机走同一条停机链（detached host 不会随主进程死亡，
  // 无此兜底则绕过 dispose 泄漏 hub 进程）；app.quit 触发的 before-quit 因
  // quitting 已置位而直通。
  process.on('SIGTERM', () => {
    shutdownThenQuit();
  });
  process.on('SIGINT', () => {
    shutdownThenQuit();
  });

  const createMainWindow = (): BrowserWindow => {
    const isDarwin = process.platform === 'darwin';
    const win = new BrowserWindow({
      width: 1200,
      height: 800,
      // 会话主列随窗口自适应收缩，最小窗口宽保证列内容（含 Composer）不被压垮
      minWidth: 900,
      minHeight: 560,
      show: false,
      // macOS 红绿灯内嵌；Windows 隐藏标题栏（保留系统边框可 resize），caption 由渲染层自绘
      titleBarStyle: isDarwin ? 'hiddenInset' : 'hidden',
      ...(isDarwin ? { trafficLightPosition: { x: 14, y: TRAFFIC_LIGHT_Y } } : {}),
      webPreferences: {
        // 沙箱渲染进程只接受 CJS preload（构建配置同步输出 .cjs）
        preload: join(__dirname, '../preload/index.cjs'),
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
    win.on('closed', () => {
      if (mainWindow === win) mainWindow = null;
    });
    win.on('ready-to-show', () => win.show());
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());

    // 壳层窗口控制：渲染层经 preload 桥触发，与业务通道 x3code:invoke 分离
    const windowActions: Record<string, () => void> = {
      minimize: () => win.minimize(),
      'toggle-maximize': () => {
        if (win.isMaximized()) {
          win.unmaximize();
        } else {
          win.maximize();
        }
      },
      close: () => win.close(),
    };
    registerIpcWindowActions(ipcMain, windowActions);
    // 外链出口：仅放行 http(s)，其余协议一律拒绝（渲染层解析已过滤，这里纵深防御）
    ipcMain.removeHandler('x3code:window-open-external');
    ipcMain.handle('x3code:window-open-external', (_event, url) => {
      if (typeof url !== 'string' || !/^https?:\/\//.test(url)) return;
      void shell.openExternal(url);
    });

    // 壳层状态初值：渲染层挂载时拉取一次（全屏恢复启动等无状态变更事件的场景也能对齐）
    ipcMain.removeHandler('x3code:window-get-state');
    ipcMain.handle('x3code:window-get-state', () => ({
      maximized: win.isMaximized(),
      fullscreen: win.isFullScreen(),
    }));

    // 壳层状态推送（最大化/全屏）：caption 图标切换与 macOS 全屏态标题块收窄共用；
    // 经既有 x3code:event 通道即时单发
    const publishWindowState = () => {
      if (win.isDestroyed()) return;
      win.webContents.send('x3code:event', {
        kind: 'window-state',
        maximized: win.isMaximized(),
        fullscreen: win.isFullScreen(),
      });
    };
    win.on('maximize', publishWindowState);
    win.on('unmaximize', publishWindowState);
    win.on('enter-full-screen', publishWindowState);
    win.on('leave-full-screen', publishWindowState);

    const devUrl = process.env['ELECTRON_RENDERER_URL'];
    if (devUrl?.startsWith('http://localhost:')) {
      void win.loadURL(devUrl);
    } else {
      void win.loadFile(join(__dirname, '../renderer/index.html'));
    }
    return win;
  };

  try {
    const keyStore = createProviderKeyStore(paths.providerKeysFile);
    const settings = createFileSettings(paths.settingsFile, keyStore);
    settingsRef = settings;
    // 运行状态监控器（T29）：2s 轮询 host 本地观测面 + Electron/os 资源采样；
    // host 未构建时降级运行（快照字段安全为 null）
    monitor = createRuntimeMonitor({
      // host 存在即订阅面可用（含 start 抛错但宿主已构建的降级形态——监控页
      // 恰恰在宿主起不来时最该工作）；未构建/装配失败安全返回 null
      host: () => {
        try {
          return runtime === null ? null : runtime.host;
        } catch {
          return null;
        }
      },
      // hub 门面（get_host_info/thread/list 命令面）：start 前窗口 getter 抛——同型收敛 null
      hub: () => {
        try {
          return runtime === null ? null : runtime.hub;
        } catch {
          return null;
        }
      },
      appMetrics: () => {
        let rssBytes = 0;
        let cpuPercent = 0;
        for (const metric of app.getAppMetrics()) {
          rssBytes += metric.memory.workingSetSize * 1024;
          cpuPercent += metric.cpu.percentCPUUsage;
        }
        return { rssBytes: Math.round(rssBytes), cpuPercent: Math.round(cpuPercent * 10) / 10 };
      },
      systemMemory: () => {
        const info = process.getSystemMemoryInfo();
        return { totalBytes: info.total * 1024, availableBytes: info.available * 1024 };
      },
      idleRecycleMinutes: () => settings.get().idleRecycleMinutes,
      appVersion: () => app.getVersion(),
      // 2s 轮询的漂移纠正：hub 报 parked/dead 而内存仍 live 的会话就地折叠
      // （thread_parked/thread_died 帧丢失的兜底对账）
      onWorkersPolled: (rows) => runtime?.reconcileWorkerStates(rows),
    });
    const monitorRef = monitor;
    monitorRef.start();
    const loggingToMonitor = {
      log(message: string): void {
        logger.log(message);
        monitorRef.noteDiagnostic(message);
      },
    };
    // rg 首启放置先于 runtime（host spawn）：hub 首个 worker 装配即解析得到内置 rg
    seedBundledRg({
      resourcesPath: app.isPackaged ? (process.resourcesPath ?? null) : null,
      agentDir: paths.agentDir,
      exists: existsSync,
      isFile: (path) => {
        try {
          return statSync(path).isFile();
        } catch {
          return false;
        }
      },
      log: (message) => loggingToMonitor.log(message),
    });
    runtime = createPaiRuntime({
      paths,
      keyStore,
      providers: () => settings.listProviders(),
      hubPaths: resolveHubPathsForRuntime,
      idleRecycleMinutes: () => settings.get().idleRecycleMinutes,
      logger: loggingToMonitor,
      emit: emitToRenderer,
    });
    const diagnosticsRoot = join(paths.userDataDir, 'diagnostics');
    // ── remote-access 网关（桌面 App = gateway 生命周期 owner + owner 全权客户端）──
    let gatewayProcess: GatewayProcess | null = null;
    /** gateway 入口解析（与宿主同链同序：设置覆盖 > env > dev 旁级探测 > 打包资源）。 */
    const resolveGatewayEntryForRuntime = (): string | null =>
      resolveGatewayEntry({
        fromSettings: (() => {
          try {
            return settingsRef?.get().hubDev.gatewayEntry ?? null;
          } catch {
            return null;
          }
        })(),
        fromEnv: process.env['X3CODE_GATEWAY_ENTRY'] ?? null,
        packagedEntry: app.isPackaged ? packagedGatewayEntry(process.resourcesPath ?? paths.userDataDir) : null,
        devRepoRoot: app.isPackaged ? null : join(__dirname, '..', '..', '..', '..'),
        packaged: app.isPackaged,
        exists: existsSync,
      });

    const getGateway = (): GatewayProcess => {
      if (gatewayProcess !== null) return gatewayProcess;
      // relay 唯一真相在 settings.json；gateway.json 每次 spawn 前重生成（网关只在启动期读入）
      try {
        writeGatewayConfig(paths.agentDir, settingsRef?.get().relay ?? EMPTY_RELAY_CONFIG);
      } catch (error) {
        logger.log(`gateway_config_write_failed:${error instanceof Error ? error.message : String(error)}`);
      }
      const hubPaths = resolveHubPathsForRuntime();
      // 网关必须持有宿主（host-attach 只认 hostBin/--host-command）——宿主路径未解析即网关未配置
      const gatewayEntry = hubPaths !== null ? resolveGatewayEntryForRuntime() : null;
      gatewayProcess = startGatewayProcess({
        bunPath: hubPaths?.bunPath ?? process.execPath,
        gatewayEntry,
        agentDir: paths.agentDir,
        hostExec: hubPaths !== null ? { command: hubPaths.bunPath, args: hubPaths.hubEntry !== null ? [hubPaths.hubEntry] : [] } : null,
        log: (message) => logger.log(message),
      });
      return gatewayProcess;
    };

    /** relay 配置变更 → 重启网关重载（gateway.json 只在网关启动期读入，不重启即拿旧形态配对）。 */
    const restartGateway = async (): Promise<void> => {
      if (gatewayProcess === null) return; // 未起过网关：配置已落盘，下次启动自然读入
      await gatewayProcess.stop();
      gatewayProcess = null;
      getGateway();
    };

    const browserHostRef: { current: ReturnType<typeof createBrowserHost> | null } = { current: null };
  // Agent worker 的 env 注入面：BW_HOME 常驻（hub→worker 全量透传已实证）；
  // X3CODE_BROWSER_CDP 随 hostState ready 回写（端口定格后）
  process.env['BW_HOME'] = join(app.getPath('userData'), 'browser-bw-home');
  browserHostRef.current = createBrowserHost({
    userDataDir: app.getPath('userData'),
    chromePath: detectChromePath(),
    bwPath: findBwCli(),
    onEvent: (event) => {
      if (event.type === 'hostState' && event.phase === 'ready' && event.cdpEndpoint !== undefined && event.cdpEndpoint !== null) {
        process.env['X3CODE_BROWSER_CDP'] = event.cdpEndpoint;
      }
      const target = mainWindow;
      if (target === null || target.isDestroyed()) return;
      target.webContents.send('x3code:browser-event', event);
    },
    log: (message) => logger.log(`browser:${message}`),
  });
  routes = createApiRoutes({
      runtime,
      settings,
      keyStore,
      monitor: monitorRef,
      browserHost: browserHostRef.current,
      restartGateway,
      onPolicySyncFailed: (minutes, reason) => {
        loggingToMonitor.log(`set_idle_retire_failed:${minutes}:${reason}`);
      },
      exportDiagnosticsBundle: () => {
        const snapshot = monitorRef.snapshot();
        const directory = writeDiagnosticsBundle(diagnosticsRoot, {
          snapshot,
          events: snapshot.events,
          stderrTail: runtime?.hostStderrTail() ?? '',
          logFile: paths.logFile,
        });
        shell.showItemInFolder(join(directory, 'summary.md'));
        return directory;
      },
      audit: (message) => logger.log(`audit:${message}`),
      onRouteRejected: (message) => logger.log(message),
      agentDefinitions: createAgentDefinitionsStore({ agentDir: paths.agentDir }),
      agentDir: paths.agentDir,
      revealPath: (path) => shell.showItemInFolder(path),
      // 技能源面：批准根 = 三个内置源根 ∪ 对话框批准目录（pickedDirectories 复用）
      skillImporter: createSkillImporter({ pickedRoots: () => [...pickedDirectories] }),
      pluginImporter: createPluginImporter({
        pickedRoots: () => [...pickedDirectories],
        agentProposalRoots: async () => {
          // agent propose 链的源目录（提案登记面——只取源目录 dirname 集合做批准根）
          if (runtime === null) return [];
          const outcome = await runtime.hub.settings.listPluginProposals({});
          if (!outcome.ok) return [];
          const raw = (outcome.data as { proposals?: unknown }).proposals;
          if (!Array.isArray(raw)) return [];
          return raw
            .map((item) => (typeof item === 'object' && item !== null ? (item as { sourcePath?: unknown }).sourcePath : undefined))
            .filter((path): path is string => typeof path === 'string' && path.startsWith('/'))
            .map((path) => path.split('/').slice(0, -1).join('/') || '/');
        },
      }),
      extraCwds: () => [...pickedDirectories],
      // 对话框单飞：在途时再调用直接按取消返回（防被攻陷渲染层并发叠弹多个模态面板）
      pickDirectory: async (defaultPath) => {
        if (directoryPickerInFlight) return null;
        directoryPickerInFlight = true;
        try {
          const options = {
            properties: ['openDirectory', 'createDirectory'] as Array<'openDirectory' | 'createDirectory'>,
            ...(defaultPath !== null ? { defaultPath } : {}),
          };
          // attach 到主窗口（模态）；窗口尚未创建时退化为应用级对话框
          const target = mainWindow !== null && !mainWindow.isDestroyed() ? mainWindow : undefined;
          const picked = target !== undefined ? await dialog.showOpenDialog(target, options) : await dialog.showOpenDialog(options);
          if (!picked.canceled && picked.filePaths[0] !== undefined) pickedDirectories.add(picked.filePaths[0]);
          return picked.canceled ? null : (picked.filePaths[0] ?? null);
        } finally {
          directoryPickerInFlight = false;
        }
      },
    });
  // ── 网关 IPC 面（进程定义在 routes 装配前：restartGateway 由设置路由回调）──
  ipcMain.handle('x3code:gateway-command', (_event, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) return { ok: false as const, reason: 'bad_payload' };
    const record = payload as { command?: unknown; args?: unknown };
    if (typeof record.command !== 'string') return { ok: false as const, reason: 'bad_command' };
    return getGateway().command({ command: record.command, args: (record.args ?? {}) as Record<string, unknown> }).then((body) => ({ ok: true as const, body }));
  });
  ipcMain.handle('x3code:gateway-status', () => {
    const stale = staleGateway(paths.agentDir);
    return { process: gatewayProcess?.status() ?? 'stopped', connected: gatewayProcess?.connected() ?? false, staleSocket: stale.stale };
  });
  app.on('before-quit', () => {
    void gatewayProcess?.stop();
    browserHostRef.current?.stop();
  });

  ipcMain.handle('x3code:invoke', (_event, payload: unknown) => {
    if (typeof payload !== 'object' || payload === null) {
      return { ok: false, error: appError('invalid_payload') };
    }
    const { method, params } = payload as { method?: unknown; params?: unknown };
    if (typeof method !== 'string' || !(method in ApiSchemas)) {
      return { ok: false, error: appError('unknown_method', String(method)) };
    }
    if (routes === null) return { ok: false, error: { kind: 'transient', face: 'host_unavailable' } };
    return routes.invoke(method, params ?? {});
  });



    if (runtime !== null) {
      await runtime.start();
    }
  } catch (error) {
    logger.log(`runtime_start_failed:${error instanceof Error ? error.message : String(error)}`);
    // host 未就绪也继续开窗：渲染层展示设置引导（配置 provider/宿主路径）
  }

  mainWindow = createMainWindow();
  if (!app.isPackaged) {
    mainWindow.webContents.openDevTools()
  }
  // macOS dock 重开：关窗后 app 常驻，activate 重建窗口
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createMainWindow();
    }
  });
});

