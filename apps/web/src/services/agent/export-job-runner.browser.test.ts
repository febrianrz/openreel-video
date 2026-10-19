import { afterEach, expect, it, vi } from "vitest";
vi.mock("@openreel/core", () => ({
  getExportEngine: () => ({ exportAudio: async function* () { yield { progress: 0 }; return { success: true, blob: new Blob(["audio"], { type: "audio/wav" }) }; } }),
  setEncoderBackendFactory: vi.fn(), WebCodecsBackend: class {},
}));
vi.mock("../../stores/project-store", () => ({ useProjectStore: { getState: () => ({ project: { name: "Test", settings: {} } }) } }));
vi.mock("../native-ffmpeg-backend", () => ({ NativeFFmpegBackend: class {} }));
vi.mock("../remote-project", () => ({ uploadRemoteAsset: vi.fn() }));
vi.mock("../../motion/export-motion-frame", () => ({ renderMotionCompositionFrameToDataUrl: vi.fn() }));
import { createExportJobRunner } from "./export-job-runner";

afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); vi.useRealTimers(); });
it("delivers browser exports without requiring the desktop filesystem", async () => {
  vi.useFakeTimers();
  const revoke = vi.fn();
  vi.stubGlobal("URL", { createObjectURL: () => "blob:export", revokeObjectURL: revoke });
  const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
  const result = await createExportJobRunner()("exportAudio", { format: "wav" });
  expect(result.ok).toBe(true);
  expect(result.data).toMatchObject({ storage: "browser-download", bytes: 5, contentType: "audio/wav" });
  expect(click).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(60000);
  expect(revoke).toHaveBeenCalledWith("blob:export");
});
