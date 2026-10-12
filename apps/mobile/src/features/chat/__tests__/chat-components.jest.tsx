import { act, fireEvent, render } from "@testing-library/react-native";
import { beforeEach, describe, expect, it, jest } from "@jest/globals";
import * as React from "react";
import { ChatHeader } from "@/features/chat/chat-header";
import { EmptyChat } from "@/features/chat/empty-chat";
import { TurnLoadingRow } from "@/features/chat/turn-loading-row";
import { PermissionCard } from "@/features/chat/permission-card";
import { TimelineList } from "@/features/chat/timeline-list";
import { SessionRow } from "@/features/history/session-row";
import { WorkspaceSheet } from "@/features/workspace/workspace-sheet";
import { useConversationStore } from "@/store/conversation-store";
import { useHistoryStore } from "@/store/history-store";
import { useNavigationStore } from "@/store/navigation-store";
import { TestWrapper } from "@/test/test-wrapper";
import { testSession } from "@/test/session-fixture";

jest.mock("expo-router", () => ({ useRouter: () => ({ push: jest.fn(), back: jest.fn() }) }));

const walkthrough = testSession("session-mobile", {
  title: "X3code Mobile 视觉走查",
  preview: "已完成 5 个页面的移动端适配检查。",
  project: "X3code Mobile",
  timeLabel: "09:18",
  unread: true,
  messages: [
    { id: "user-mobile", kind: "user", text: "把移动端界面改成更克制的 Pai 风格。", createdAt: "09:15" },
    { id: "code-mobile", kind: "code", title: "ComposerPanel.tsx", language: "tsx", text: "export function ComposerPanel() {\n  return (\n    <CompactComposer />\n  );\n}", createdAt: "09:18", lineCount: 24, summary: "+18 -9" },
    { id: "status-mobile", kind: "status", text: "已完成移动端视觉走查", status: "ok", durationMs: 18500, summary: "5 个页面，0 个错误", createdAt: "09:18" },
  ],
});

const release = testSession("session-release", {
  title: "检查发布前变更",
  preview: "Android 权限问题需要重试。",
  project: "agent-app",
  timeLabel: "昨天",
  state: "paused",
  messages: [
    { id: "assistant-release", kind: "assistant", text: "发布检查已完成大部分，仍有一个 Android 权限问题需要处理。", createdAt: "昨天" },
    { id: "status-release", kind: "status", text: "Android 权限检查失败", status: "failed", durationMs: 3200, summary: "Android 14 权限声明缺失", createdAt: "昨天" },
  ],
});

describe("chat and history components", () => {
  beforeEach(() => {
    useNavigationStore.setState({ drawerOpen: false, sheet: null });
    useConversationStore.getState().startNewSession();
  });

  it("renders user attachments, assistant text, code preview and status rows", async () => {
    const session = walkthrough;
    const view = await render(<TimelineList generating={false} messages={session.messages} />);
    await fireEvent.press(view.getByLabelText(/展开过程流/));
    expect(view.getByText("ComposerPanel.tsx")).toBeTruthy();
    await fireEvent.press(view.getByText("ComposerPanel.tsx"));
    expect(view.getByText("5 个页面，0 个错误")).toBeTruthy();
    expect(view.getByText("已完成移动端视觉走查")).toBeTruthy();
    await view.rerender(<TimelineList generating={false} messages={release.messages} />);
    expect(view.getByText("Android 权限检查失败")).toBeTruthy();
  });

  it("执行中指示贴消息流末尾、最后一条消息后面且不固定悬浮（用户裁决：与 PC 对话列表同实现）", async () => {
    const view = await render(
      <TimelineList generating messages={[{ id: "u1", kind: "user", text: "最后一条消息", createdAt: "now" }]} />,
    );
    const order = JSON.stringify(view.toJSON());
    // 贴在最后一条消息后面：不浮到屏幕最底部，也不进头部
    expect(order.indexOf("X3code 正在生成回复")).toBeGreaterThan(order.indexOf("最后一条消息"));
    // 不固定：样式里没有任何 position 定位（随消息流滚动）
    const row = view.getByLabelText("X3code 正在生成回复");
    const styles = (Array.isArray(row.props.style) ? row.props.style : [row.props.style]) as readonly { position?: string }[];
    expect(styles.every((entry) => entry?.position === undefined)).toBe(true);
    // 未生成不渲染
    const idle = await render(<TimelineList generating={false} messages={[]} />);
    expect(idle.queryByLabelText("X3code 正在生成回复")).toBeNull();
  });

  it("执行中指示视觉本体只有旋转指示（与 PC 同形态）：无可见文案，语义靠读屏；全应用唯一旋转 loading 在这里", async () => {
    const view = await render(<TurnLoadingRow />);
    expect(view.getByLabelText("X3code 正在生成回复")).toBeTruthy();
    expect(view.queryByText(/正在生成/)).toBeNull();
    expect(view.getAllByTestId("loading-spinner", { includeHiddenElements: true })).toHaveLength(1);
  });

  it("opens empty workspace and quick prompts（无示例对话入口）", async () => {
    const workspace = jest.fn();
    const prompt = jest.fn();
    const view = await render(
      <>
        <EmptyChat onPrompt={prompt} onWorkspace={workspace} />
        <PermissionCard />
      </>,
    );
    await fireEvent.press(view.getByText("选择工作空间"));
    expect(workspace).toHaveBeenCalledTimes(1);
    expect(view.queryByText("查看示例对话")).toBeNull();
    await fireEvent.press(view.getByText("分析当前项目"));
    await fireEvent.press(view.getByText("定位并修复问题"));
    await fireEvent.press(view.getByText("审查代码质量"));
    expect(prompt).toHaveBeenNthCalledWith(
      1,
      "分析当前项目结构、关键模块和潜在风险，并给出可执行改进计划。",
    );
    expect(prompt).toHaveBeenNthCalledWith(
      2,
      "定位当前项目中的错误或失败测试，分析根因并完成修复。",
    );
    expect(prompt).toHaveBeenNthCalledWith(3, "审查当前代码变更，检查正确性、安全性和可维护性。");
    await act(() =>
      Promise.resolve(
        useConversationStore
          .getState()
          .requestPermission({ id: "p", title: "运行测试", command: "bun test", approved: null }),
      ),
    );
    await view.rerender(<PermissionCard />);
    await fireEvent.press(view.getByText("允许一次"));
    // 应答即清卡（dialog/respond 发送；裁决经事件流对账）
    expect(useConversationStore.getState().permissionQueue).toEqual([]);
  });

  it("renders chat header and opens history/task configuration", async () => {
    const view = await render(<ChatHeader />);
    await fireEvent.press(view.getByLabelText("打开对话历史"));
    expect(useNavigationStore.getState().drawerOpen).toBe(true);
    await fireEvent.press(view.getByLabelText("任务配置"));
    expect(useNavigationStore.getState().sheet).toBe("task-config");
  });

  it("opens and manages a session row", async () => {
    const session = walkthrough;
    const open = jest.fn();
    const action = jest.fn();
    const view = await render(
      <SessionRow active onAction={action} onOpen={open} session={session} />,
    );
    expect(view.getByLabelText(session.title).props.accessibilityState).toEqual({ selected: true });
    await fireEvent.press(view.getByLabelText(session.title));
    await fireEvent.press(view.getByLabelText(`${session.title} 更多操作`));
    expect(open).toHaveBeenCalledTimes(1);
    expect(action).toHaveBeenCalledTimes(1);
  });

  it("shows closed conversation states without duplicate unread markers（paused=worker 异常才标红）", async () => {
    const unread = walkthrough;
    const workingUnread = { ...unread, state: "working" as const };
    const pausedUnread = { ...unread, id: "paused-unread", state: "paused" as const };
    const view = await render(<><SessionRow onAction={jest.fn()} onOpen={jest.fn()} session={workingUnread} /><SessionRow onAction={jest.fn()} onOpen={jest.fn()} session={pausedUnread} /></>);
    expect(view.getByText("进行中")).toBeTruthy();
    expect(view.getByText("异常")).toBeTruthy();
    expect(view.queryByLabelText("未读")).toBeNull();
    await view.rerender(<SessionRow onAction={jest.fn()} onOpen={jest.fn()} session={unread} />);
    expect(view.getByLabelText("未读")).toBeTruthy();
  });

  it("只列电脑端会话用过的目录，不接受手输路径（症状：手输未知目录建出错工作区）", async () => {
    useHistoryStore.setState({
      sessions: [
        testSession("ws-1", { project: "/work/agent-app" }),
        testSession("ws-2", { project: "/work/agent-app" }),
        testSession("ws-3", { project: "/work/other" }),
      ],
      query: "",
    });
    useNavigationStore.getState().openSheet("workspace");
    const view = await render(
      <TestWrapper>
        <WorkspaceSheet />
      </TestWrapper>,
    );
    // 打开即列出，不需先搜索
    expect(view.getByText("agent-app")).toBeTruthy();
    expect(view.getAllByText("agent-app")).toHaveLength(1);
    expect(view.getByText("other")).toBeTruthy();
    // 输入只过滤，不产生新工作空间
    await fireEvent.changeText(view.getByLabelText("搜索工作空间"), "/work/agent-app");
    expect(view.getByText("agent-app")).toBeTruthy();
    expect(view.queryByText("other")).toBeNull();
    await fireEvent.press(view.getByText("agent-app"));
    expect(useNavigationStore.getState().sheet).toBeNull();
    expect(useConversationStore.getState()).toMatchObject({
      workspaceId: "/work/agent-app",
      workspacePath: "/work/agent-app",
    });
  });

  it("电脑端没有目录时不提供手输路径（症状：空面板无从下手）", async () => {
    useHistoryStore.setState({ sessions: [], query: "" });
    useNavigationStore.getState().openSheet("workspace");
    const view = await render(
      <TestWrapper>
        <WorkspaceSheet />
      </TestWrapper>,
    );
    expect(view.queryByText(/^使用 /)).toBeNull();
    expect(view.getByLabelText("搜索工作空间")).toBeTruthy();
  });
});
