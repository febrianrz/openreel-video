import { useEffect, useCallback, useRef, useState, lazy, Suspense } from "react";
import { ToastContainer } from "./components/Toast";
import { MobileBlocker } from "./components/MobileBlocker";
import { WelcomeScreen } from "./components/welcome";
import { RecoveryDialog } from "./components/welcome/RecoveryDialog";
import { useUIStore } from "./stores/ui-store";
import { useProjectStore } from "./stores/project-store";
import { useRouter } from "./hooks/use-router";
import { useProjectRecovery } from "./hooks/useProjectRecovery";
import { useKieAIPoller } from "./hooks/useKieAIPoller";
import { toast } from "./stores/notification-store";
import { SOCIAL_MEDIA_PRESETS, type SocialMediaCategory } from "@openreel/core";
import { ToolcraftText as Text } from "@openreel/ui";
import { openRemoteProject } from "./services/remote-project";
import { startRemoteCommandBridge } from "./services/remote-command-bridge";

const EditorInterface = lazy(() =>
  import("./components/editor/EditorInterface").then((m) => ({
    default: m.EditorInterface,
  }))
);
const ScriptViewDialog = lazy(() =>
  import("./components/editor/ScriptViewDialog").then((m) => ({ default: m.ScriptViewDialog })),
);
const SearchModal = lazy(() =>
  import("./components/editor/SearchModal").then((m) => ({ default: m.SearchModal })),
);
const SharePage = lazy(() =>
  import("./pages/SharePage").then((m) => ({ default: m.SharePage })),
);
const LoadingSpinner: React.FC<{ message: string }> = ({ message }) => (
  <div className="h-screen w-screen bg-background flex flex-col items-center justify-center">
    <div className="w-10 h-10 border-2 border-primary border-t-transparent rounded-full animate-spin mb-3" />
    <Text type="supporting" color="secondary" className="text-sm text-text-secondary">{message}</Text>
  </div>
);

const PRESET_DIMENSIONS: Record<string, SocialMediaCategory> = {
  "1080x1920": "tiktok",
  "1920x1080": "youtube-video",
  "1080x1080": "instagram-post",
  "720x1280": "instagram-stories",
  "1280x720": "youtube-video",
};

function App() {
  const activeModal = useUIStore((state) => state.activeModal);
  const closeModal = useUIStore((state) => state.closeModal);
  const skipWelcomeScreen = useUIStore((state) => state.skipWelcomeScreen);
  const openSearchModal = useUIStore((state) => state.openModal);
  const [hasOpenedScriptView, setHasOpenedScriptView] = useState(false);
  const [isRecovering, setIsRecovering] = useState(false);
  const [remoteLoading, setRemoteLoading] = useState(false);
  const createNewProject = useProjectStore((state) => state.createNewProject);
  const hasOpenProject = useProjectStore((state) => state.hasOpenProject);
  const stopRemoteBridge = useRef<(() => void) | null>(null);
  const remoteLoaded = useRef(false);
  const { isChecking, showDialog, availableSaves, recover, dismiss, clearAll } = useProjectRecovery();

  const { route, params, navigate, parsedDimensions, fps } = useRouter();
  const hasHandledInitialRoute = useRef(false);
  useKieAIPoller();
  useEffect(() => {
    if (remoteLoaded.current || route !== "editor" || !params.projectId) return;
    remoteLoaded.current = true;
    setRemoteLoading(true);
    void openRemoteProject(params.launch, params.projectId)
      .then((session) => {
        useProjectStore.getState().loadProject(session.project);
        stopRemoteBridge.current = startRemoteCommandBridge(session);
        window.history.replaceState(null, "", `#/editor?projectId=${encodeURIComponent(session.id)}`);
      })
      .catch((error) => {
        if (new URLSearchParams(window.location.search).get("backendWorker") === "1") (window as Window & { __alterBridgeFailed?: boolean }).__alterBridgeFailed = true;
        remoteLoaded.current = false;
        toast.error("Project remote gagal dibuka", error instanceof Error ? error.message : "Coba buka ulang link editor.");
      })
      .finally(() => setRemoteLoading(false));
  }, [route, params.launch, params.projectId]);

  useEffect(() => () => { stopRemoteBridge.current?.(); }, []);
  const showWelcome =
    ["welcome", "templates", "recent"].includes(route) && !skipWelcomeScreen;
  const isSharePage = route === "share" && params.shareId;

  useEffect(() => {
    if (activeModal === "scriptView") setHasOpenedScriptView(true);
  }, [activeModal]);

  useEffect(() => {
    if (hasHandledInitialRoute.current || isChecking || showDialog || isRecovering) return;

    if (route === "new") {
      hasHandledInitialRoute.current = true;

      let projectName = "New Project";
      let width = 1920;
      let height = 1080;
      let frameRate = fps;

      if (params.preset) {
        const presetKey = params.preset as SocialMediaCategory;
        const preset = SOCIAL_MEDIA_PRESETS[presetKey];
        if (preset) {
          width = preset.width;
          height = preset.height;
          frameRate = params.fps ? fps : (preset.frameRate || fps);
          projectName = `New ${presetKey.charAt(0).toUpperCase() + presetKey.slice(1).replace(/-/g, " ")} Project`;
        }
      } else if (parsedDimensions) {
        width = parsedDimensions.width;
        height = parsedDimensions.height;

        const dimensionKey = `${width}x${height}`;
        const matchingPreset = PRESET_DIMENSIONS[dimensionKey];
        if (matchingPreset) {
          const preset = SOCIAL_MEDIA_PRESETS[matchingPreset];
          frameRate = params.fps ? fps : (preset.frameRate || fps);
        }

        const aspectRatio = width / height;
        if (aspectRatio < 1) {
          projectName = "New Vertical Video";
        } else if (aspectRatio > 1) {
          projectName = "New Horizontal Video";
        } else {
          projectName = "New Square Video";
        }
      }

      createNewProject(projectName, { width, height, frameRate });
      navigate("editor");
    } else if (route === "editor" && skipWelcomeScreen) {
      hasHandledInitialRoute.current = true;
    } else if (["welcome", "templates", "recent"].includes(route)) {
      hasHandledInitialRoute.current = true;
    }
  }, [
    route,
    params,
    parsedDimensions,
    fps,
    createNewProject,
    navigate,
    skipWelcomeScreen,
    isChecking,
    showDialog,
    isRecovering,
  ]);

  useEffect(() => {
    // Recovery owns the choice until it settles. A bare editor URL still needs
    // a real project for autosave and preview-proxy lifecycle subscriptions.
    if (params.projectId || showWelcome || isSharePage || route === "new" || isChecking || showDialog || isRecovering || remoteLoading || hasOpenProject) return;
    createNewProject("New Project");
  }, [params.projectId, showWelcome, isSharePage, route, isChecking, showDialog, isRecovering, remoteLoading, hasOpenProject, createNewProject]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Escape" && route !== "editor") {
        navigate("editor");
      }
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        openSearchModal("search");
      }
    },
    [route, navigate, openSearchModal],
  );

  useEffect(() => {
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [handleKeyDown]);

  const initialTab =
    route === "templates"
      ? "templates"
      : route === "recent"
        ? "recent"
        : undefined;

  return (
    <div className="h-screen h-[100dvh] w-screen bg-background text-text-primary overflow-hidden">
      <MobileBlocker />
      {isSharePage ? (
        <Suspense fallback={<LoadingSpinner message="Loading shared video..." />}>
          <SharePage shareId={params.shareId!} />
        </Suspense>
      ) : showWelcome ? (
        <WelcomeScreen initialTab={initialTab} />
      ) : remoteLoading || !hasOpenProject || route === "new" ? (
        <LoadingSpinner message={isChecking ? "Checking for saved projects..." : showDialog ? "Choose a saved project or start fresh..." : "Opening project..."} />
      ) : (
        <Suspense fallback={<LoadingSpinner message="Loading editor..." />}>
          <EditorInterface />
        </Suspense>
      )}
      <ToastContainer />
      <Suspense fallback={null}>
        {(hasOpenedScriptView || activeModal === "scriptView") && <ScriptViewDialog isOpen={activeModal === "scriptView"} onClose={closeModal} />}
        {activeModal === "search" && <SearchModal isOpen onClose={closeModal} />}
      </Suspense>
      {!params.projectId && showDialog && availableSaves.length > 0 && (
        <RecoveryDialog
          saves={availableSaves}
          onRecover={async (saveId) => {
            // Loading a snapshot updates the store before the hash navigation
            // settles. Claim the initial route first so /new cannot replace it.
            const previouslyHandled = hasHandledInitialRoute.current;
            hasHandledInitialRoute.current = true;
            setIsRecovering(true);
            let success = false;
            try {
              success = await recover(saveId);
              if (success) navigate("editor");
            } finally {
              if (!success) hasHandledInitialRoute.current = previouslyHandled;
              setIsRecovering(false);
            }
          }}
          onDismiss={dismiss}
          onClearAll={clearAll}
        />
      )}
    </div>
  );
}

export default App;
