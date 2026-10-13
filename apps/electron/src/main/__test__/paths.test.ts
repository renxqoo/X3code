import { describe, expect, test } from "bun:test";

import { resolveAppPaths, resolveDataDir, resolveUserDataDir } from "../paths";

const PLATFORM_USER_DATA = "/Users/u/Library/Application Support/X3code";

describe("resolveDataDir（业务数据根：缺省 ~/.pai，X3CODE_USER_DATA_DIR 隔离覆盖）", () => {
  test("未设置 env → home 下 .pai", () => {
    expect(resolveDataDir({}, "/home/u")).toBe("/home/u/.pai");
  });

  test('env 为空串视为未设置（避免 X3CODE_USER_DATA_DIR="" 把数据根清成空路径）', () => {
    expect(resolveDataDir({ X3CODE_USER_DATA_DIR: "" }, "/home/u")).toBe("/home/u/.pai");
  });

  test("env 非空 → 整体重定向（worktree 并行实例独立数据区）", () => {
    expect(resolveDataDir({ X3CODE_USER_DATA_DIR: "/tmp/wt-user-data" }, "/home/u")).toBe("/tmp/wt-user-data");
  });
});

describe("resolveUserDataDir（Chromium 根：缺省留在平台标准位置）", () => {
  test("未设置 env → 沿用 Electron 默认 userData，内核产物不回灌 ~/.pai", () => {
    expect(resolveUserDataDir({}, PLATFORM_USER_DATA)).toBe(PLATFORM_USER_DATA);
  });

  test("env 非空 → 整体重定向（连同单实例锁一起隔离）", () => {
    expect(resolveUserDataDir({ X3CODE_USER_DATA_DIR: "/tmp/wt" }, PLATFORM_USER_DATA)).toBe("/tmp/wt");
  });

  test("env 为空串视为未设置", () => {
    expect(resolveUserDataDir({ X3CODE_USER_DATA_DIR: "" }, PLATFORM_USER_DATA)).toBe(PLATFORM_USER_DATA);
  });
});

describe("resolveAppPaths（两根分离：业务数据在 dataDir，内核产物在 userDataDir）", () => {
  test("业务路径全部落在 dataDir 下", () => {
    expect(resolveAppPaths(PLATFORM_USER_DATA, "/home/u/.pai")).toEqual({
      userDataDir: PLATFORM_USER_DATA,
      dataDir: "/home/u/.pai",
      agentDir: "/home/u/.pai/agent",
      registryDb: "/home/u/.pai/registry.sqlite",
      settingsFile: "/home/u/.pai/settings.json",
      providerKeysFile: "/home/u/.pai/provider-keys.json",
      logFile: "/home/u/.pai/main.log",
    });
  });

  test("业务路径不与 Chromium 根重叠（否则内核产物会重新混进 ~/.pai）", () => {
    const paths = resolveAppPaths(PLATFORM_USER_DATA, "/home/u/.pai");
    const business = [paths.agentDir, paths.registryDb, paths.settingsFile, paths.providerKeysFile, paths.logFile];
    expect(business.every((p) => p.startsWith(paths.dataDir))).toBe(true);
    expect(paths.userDataDir).not.toBe(paths.dataDir);
  });
});