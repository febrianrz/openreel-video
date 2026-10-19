import { createProjectSerializer, createStorageEngine, type Project } from "@openreel/core";

const apiBase = (import.meta.env.VITE_ALTER_BOT_API_URL as string | undefined)?.replace(/\/$/, "") ?? "";
const serializer = createProjectSerializer(createStorageEngine());

function apiUrl(path: string): string {
  return `${apiBase}${path}`;
}

async function request<T>(path: string, init: RequestInit): Promise<T> {
  const response = await fetch(apiUrl(path), { ...init, credentials: "include", headers: { "Content-Type": "application/json", ...(init.headers ?? {}) } });
  const body = await response.json().catch(() => null) as { error?: string } & T;
  if (!response.ok) throw new Error(body?.error || `Remote project request failed (${response.status})`);
  return body;
}

export interface RemoteProjectSession {
  id: string;
  name: string;
  project: Project;
  version: number;
  updatedAt: string;
}

export async function openRemoteProject(token: string): Promise<RemoteProjectSession> {
  const result = await request<{ project: RemoteProjectSession }>("/api/video/editor-session", {
    method: "POST",
    body: JSON.stringify({ token }),
  });
  return result.project;
}

export async function saveRemoteProject(session: Pick<RemoteProjectSession, "id" | "version"> & { project: Project }): Promise<RemoteProjectSession> {
  const result = await request<{ project: RemoteProjectSession }>(`/api/video/projects/${session.id}`, {
    method: "PUT",
    body: JSON.stringify({ project: JSON.parse(serializer.exportToJson(session.project)), version: session.version }),
  });
  return result.project;
}
