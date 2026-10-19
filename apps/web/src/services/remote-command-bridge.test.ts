import { beforeEach, afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  project: { id: "document-1", name: "Test" },
  request: vi.fn(), execute: vi.fn(), save: vi.fn(), rollback: vi.fn(), commit: vi.fn(), error: vi.fn(),
}));
vi.mock("@openreel/agent", () => ({
  executeTool: mocks.execute,
  getTool: () => ({}),
  toolDefs: () => [{ name: "trim_clip", inputSchema: { type: "object" } }],
}));
vi.mock("./agent/host-singleton", () => ({
  getLiveEditorHost: () => ({ setJobRunner: vi.fn(), getProject: () => mocks.project, beginTransaction: () => ({ id: "transaction-1" }), commitTransaction: mocks.commit, rollbackTransaction: mocks.rollback }),
  runExclusive: (fn: () => Promise<unknown>) => fn(),
}));
vi.mock("./agent/export-job-runner", () => ({ createExportJobRunner: () => vi.fn() }));
vi.mock("../stores/project-store", () => ({ useProjectStore: { getState: () => ({ project: mocks.project }) } }));
vi.mock("../stores/engine-store", () => ({ useEngineStore: { getState: () => ({ initialized: true }) } }));
vi.mock("../stores/notification-store", () => ({ toast: { error: mocks.error } }));
vi.mock("./remote-project", () => ({ bridgeRequest: mocks.request, saveRemoteProject: mocks.save, serializeRemoteProject: (project: unknown) => project, syncRemoteMedia: vi.fn().mockResolvedValue(undefined), refreshRemoteProject: vi.fn(), getRemoteAssetFile: vi.fn(), bindRemoteMedia: vi.fn() }));
import { startRemoteCommandBridge } from "./remote-command-bridge";
import type { RemoteProjectSession } from "./remote-project";

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.execute.mockResolvedValue({ ok: true, summary: "Trimmed to two seconds" });
  mocks.request.mockImplementation(async (body: { action: string }) => body.action === "poll"
    ? { version: 1, command: { id: "command-1", name: "trim_clip", arguments: { clipId: "clip-1", duration: 2 } } }
    : { version: 2 });
});
afterEach(() => { vi.useRealTimers(); });
const session = () => ({ id: "remote-1", project: mocks.project, version: 1, kind: "worker" }) as unknown as RemoteProjectSession;

it("discovers native tools, executes in a transaction and persists the result", async () => {
  const stop = startRemoteCommandBridge(session());
  await vi.advanceTimersByTimeAsync(0);
  stop();
  expect(mocks.request.mock.calls[0][0].capabilities[0].name).toBe("trim_clip");
  expect(mocks.execute).toHaveBeenCalledWith("trim_clip", { clipId: "clip-1", duration: 2 }, expect.any(Object));
  expect(mocks.commit).toHaveBeenCalledOnce();
  expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ action: "finish", commandId: "command-1", version: 1, result: { ok: true, summary: "Trimmed to two seconds" } }));
});

it("rolls back a failed native action and reports failure", async () => {
  mocks.execute.mockResolvedValue({ ok: false, summary: "Invalid transition adjacency" });
  const stop = startRemoteCommandBridge(session());
  await vi.advanceTimersByTimeAsync(0);
  stop();
  expect(mocks.rollback).toHaveBeenCalledOnce();
  expect(mocks.commit).not.toHaveBeenCalled();
  expect(mocks.request).toHaveBeenCalledWith(expect.objectContaining({ action: "finish", result: { ok: false, summary: "Invalid transition adjacency" } }));
});

it("does not replay an edit when reporting its result loses the connection", async () => {
  mocks.request.mockImplementation(async (body: { action: string }) => {
    if (body.action === "poll") return { version: 1, command: { id: "command-1", name: "trim_clip", arguments: {} } };
    throw new Error("Connection lost");
  });
  const stop = startRemoteCommandBridge(session());
  await vi.advanceTimersByTimeAsync(10000);
  stop();
  expect(mocks.execute).toHaveBeenCalledOnce();
  expect(mocks.error).toHaveBeenCalledWith("TBot connection stopped", "Connection lost");
});
