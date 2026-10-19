import { createProjectSerializer, createStorageEngine, type Project } from "@openreel/core";
import { restoreMediaItem } from "../utils/media-recovery";

const apiBase = (import.meta.env.VITE_ALTER_BOT_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";
let editorToken = "";
const serializer = createProjectSerializer(createStorageEngine());
const knownMedia = new Map<string, Blob>();
const backendMedia = new Map<string, string>();
const knownAssetIds = new Map<string, string>();

export async function remoteFetch(path: string, init: NonNullable<Parameters<typeof fetch>[1]> = {}) {
  return fetch(apiUrl(path), { ...init, credentials: "omit", headers: { ...(editorToken ? { Authorization: `Bearer ${editorToken}` } : {}), ...(init.headers || {}) } });
}

function apiUrl(path: string): string {
  return `${apiBase}${path}`;
}

async function request<T>(path: string, init: { method: string; body: string; headers?: Record<string, string> }): Promise<T> {
  const response = await fetch(apiUrl(path), { ...init, credentials: "omit", headers: { "Content-Type": "application/json", ...(editorToken ? { Authorization: `Bearer ${editorToken}` } : {}), ...(init.headers ?? {}) } });
  const body = await response.json().catch(() => null) as { error?: string } & T;
  if (!response.ok) throw new Error(body?.error || `Remote project request failed (${response.status})`);
  return body;
}

export interface RemoteProjectSession {
  kind?: "editor" | "worker";
  id: string;
  name: string;
  project: Project;
  version: number;
  updatedAt: string;
}

export async function openRemoteProject(token: string | undefined, projectId: string): Promise<RemoteProjectSession> {
  const key = `alter-editor:${projectId}`;
  editorToken = sessionStorage.getItem(key) || "";
  let session: RemoteProjectSession;
  if (!token && editorToken) {
    session = (await bridgeRequest<{ project: RemoteProjectSession }>({ action: "load" })).project;
  } else {
    const result = await request<{ project: RemoteProjectSession; token: string }>("/api/video/editor-session", { method: "POST", body: JSON.stringify({ token, projectId }) });
    editorToken = result.token;
    sessionStorage.setItem(key, editorToken);
    session = result.project;
  }
  return hydrateRemoteProject(session);
}

export async function saveRemoteProject(session: Pick<RemoteProjectSession, "id" | "version"> & { project: Project }): Promise<RemoteProjectSession> {
  await syncRemoteMedia(session.project);
  const result = await bridgeRequest<{ version: number }>({ action: "save", project: serializeRemoteProject(session.project), version: session.version });
  return { ...session, name: session.project.name, version: result.version, updatedAt: new Date().toISOString() };
}

interface RemoteAsset { id: string; mediaId: string | null; name: string; mimeType: string; kind: string }

async function assets(): Promise<RemoteAsset[]> {
  const response = await remoteFetch("/api/video/assets");
  if (!response.ok) throw new Error("Unable to load backend assets");
  return (await response.json()).assets;
}

export async function uploadRemoteAsset(blob: Blob, name: string, kind: "source" | "export", mediaId?: string) {
  const response = await remoteFetch("/api/video/assets", { method: "POST", headers: { "Content-Type": blob.type || "application/octet-stream", "X-Filename": encodeURIComponent(name), "X-Asset-Kind": kind, ...(mediaId ? { "X-Media-Id": mediaId } : {}) }, body: blob });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "Backend asset upload failed");
  return result.asset;
}

export async function syncRemoteMedia(project: Project) {
  for (const item of project.mediaLibrary.items) {
    const blob = item.blob || (item.fileHandle ? await item.fileHandle.getFile() : null);
    if (!blob || knownMedia.get(item.id) === blob) continue;
    const asset = await uploadRemoteAsset(blob, item.name, "source", item.id);
    backendMedia.set(item.id, asset.id);
    knownAssetIds.set(item.id, asset.id);
    knownMedia.set(item.id, blob);
  }
}

export async function getRemoteAssetFile(id: string) {
  const asset = (await assets()).find((item) => item.id === id);
  if (!asset) throw new Error("Backend asset not found");
  const response = await remoteFetch(`/api/video/assets/${id}`);
  if (!response.ok) throw new Error("Backend asset download failed");
  return new File([await response.blob()], asset.name, { type: asset.mimeType });
}

export async function bindRemoteMedia(assetId: string, mediaId: string, blob: Blob) {
  await bridgeRequest({ action: "bind_asset", assetId, mediaId });
  knownMedia.set(mediaId, blob);
  backendMedia.set(mediaId, assetId);
  knownAssetIds.set(mediaId, assetId);
}

export async function hydrateRemoteProject(session: RemoteProjectSession) {
  const stored = session.project as unknown as Record<string, unknown>;
  if (stored.project && stored.version) session.project = serializer.importFromJson(JSON.stringify(stored));
  const files = await assets();
  const references = (session.project as Project & { backendAssets?: Record<string, string> }).backendAssets || {};
  backendMedia.clear();
  for (const [id, assetId] of Object.entries(references)) backendMedia.set(id, assetId);
  session.project = { ...session.project, mediaLibrary: { ...session.project.mediaLibrary, items: await Promise.all(session.project.mediaLibrary.items.map(async (item) => {
    const asset = references[item.id] ? files.find((file) => file.id === references[item.id]) : files.find((file) => file.mediaId === item.id && file.kind === "source");
    if (!asset) return restoreMediaItem(item, undefined);
    const blob = (knownAssetIds.get(item.id) === asset.id ? knownMedia.get(item.id) : null) || await getRemoteAssetFile(asset.id);
    const restored = await restoreMediaItem(item, blob);
    if (restored.blob) knownMedia.set(item.id, restored.blob);
    backendMedia.set(item.id, asset.id);
    knownAssetIds.set(item.id, asset.id);
    return restored;
  })) } };
  return session;
}

export async function refreshRemoteProject() {
  return hydrateRemoteProject((await bridgeRequest<{ project: RemoteProjectSession }>({ action: "load" })).project);
}

export function serializeRemoteProject(project: Project): unknown {
  return { ...JSON.parse(serializer.exportToJson(project)).project, backendAssets: Object.fromEntries(backendMedia) };
}

export function bridgeRequest<T>(body: unknown): Promise<T> {
  return request<T>("/api/video/bridge", {
    method: "POST",
    body: JSON.stringify(body),
  });
}
