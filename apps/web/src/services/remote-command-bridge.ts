import { executeTool, getTool, toolDefs } from "@openreel/agent";
import { getLiveEditorHost, runExclusive } from "./agent/host-singleton";
import { createExportJobRunner } from "./agent/export-job-runner";
import { useProjectStore } from "../stores/project-store";
import { useEngineStore } from "../stores/engine-store";
import { toast } from "../stores/notification-store";
import { bridgeRequest, saveRemoteProject, serializeRemoteProject, refreshRemoteProject, syncRemoteMedia, getRemoteAssetFile, bindRemoteMedia, type RemoteProjectSession } from "./remote-project";

export function startRemoteCommandBridge(initial: RemoteProjectSession): () => void {
  let session = initial;
  let savedProject = useProjectStore.getState().project;
  let stopped = false;
  let registered = false;
  let timer: ReturnType<typeof setTimeout>;
  const host = getLiveEditorHost();
  host.setJobRunner(createExportJobRunner());

  async function tick() {
    if (stopped) return;
    if (!useEngineStore.getState().initialized) {
      timer = setTimeout(() => { void tick(); }, 1000);
      return;
    }
    try {
      const current = useProjectStore.getState().project;
      if (current.id !== initial.project.id) { stopped = true; return; }
      if (current !== savedProject) {
        session = { ...await saveRemoteProject({ ...session, project: current }), kind: session.kind };
        savedProject = current;
      }
      if (session.kind !== "worker") {
        const latest = await bridgeRequest<{ project: RemoteProjectSession }>({ action: "load" });
        if (latest.project.version !== session.version) {
          if (useProjectStore.getState().project !== savedProject) throw new Error("Project changed while you were editing. Save a backup before reloading.");
          session = await refreshRemoteProject();
          useProjectStore.getState().loadProject(session.project);
          savedProject = useProjectStore.getState().project;
        }
        if (!stopped) timer = setTimeout(() => { void tick(); }, 2000);
        return;
      }
      const reply = await bridgeRequest<{ version: number; command: { id: string; name: string; arguments: Record<string, unknown> } | null }>({ action: "poll", ...(!registered ? { capabilities: toolDefs() } : {}) });
      registered = true;
      if (reply.version !== session.version) {
        session = await refreshRemoteProject();
        useProjectStore.getState().loadProject(session.project);
        savedProject = useProjectStore.getState().project;
      }
      const command = reply.command;
      if (command) {
        await runExclusive(async () => {
          if (stopped || useProjectStore.getState().project.id !== initial.project.id) throw new Error("Project context changed before command execution");
          const root = document.getElementById("root");
          const wasInert = root?.inert ?? false;
          if (root) root.inert = true;
          const txn = host.beginTransaction(`TBot: ${command.name}`);
          let result;
          try {
            const tool = getTool(command.name);
            if (["create_project", "open_project", "list_projects"].includes(command.name)) {
              result = { ok: false, summary: "Use TBot video_project_create/open to access projects owned by your account." };
            } else if (command.name === "save_project") {
              result = { ok: true, summary: "Saved to TBot" };
            } else if (command.name === "import_media_from_url") {
              const value = String(command.arguments.url);
              if (!value.startsWith("tbot-asset:")) throw new Error("Import media through TBot backend first");
              const assetId = value.slice("tbot-asset:".length);
              const file = await getRemoteAssetFile(assetId);
              const imported = await useProjectStore.getState().importMedia(file);
              if (!imported.success || !imported.actionId) throw new Error(imported.error?.message || "Media import failed");
              const item = host.getProject().mediaLibrary.items.find((entry) => entry.id === imported.actionId);
              if (item?.blob) await bindRemoteMedia(assetId, item.id, item.blob);
              result = { ok: true, summary: "Imported backend asset", data: { mediaId: imported.actionId, name: file.name, durationSec: item?.metadata.duration ?? 0 } };
            } else {
              result = tool ? await executeTool(command.name, command.arguments, host) : { ok: false, summary: "Unknown OpenReel tool" };
            }
            if (result.ok) host.commitTransaction(txn, command.name);
            else await host.rollbackTransaction(txn);
          } catch (error) {
            await host.rollbackTransaction(txn);
            result = { ok: false, summary: error instanceof Error ? error.message : "Editor command failed" };
          } finally {
            if (root) root.inert = wasInert;
          }
          const project = host.getProject();
          await syncRemoteMedia(project);
          const completed = await bridgeRequest<{ version: number }>({ action: "finish", commandId: command.id, version: session.version, project: serializeRemoteProject(project), result });
          session = { ...session, version: completed.version, project };
          savedProject = project;
          if (!result.ok) toast.error("TBot editing failed", result.summary);
        });
      }
    } catch (error) {
      stopped = true;
      if (session.kind === "worker") (window as Window & { __alterBridgeFailed?: boolean }).__alterBridgeFailed = true;
      toast.error("TBot connection stopped", error instanceof Error ? error.message : "Keep a local backup and reopen the project from chat.");
    }
    if (!stopped) timer = setTimeout(() => { void tick(); }, 2000);
  }
  void tick();
  return () => { stopped = true; clearTimeout(timer); };
}
