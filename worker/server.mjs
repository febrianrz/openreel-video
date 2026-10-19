import { chromium } from "playwright-core";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { createEncoderBridge } from "./encoder.mjs";

const api = new URL(process.env.TBOT_API_URL || "http://tbot:3000");
const editor = new URL(process.env.OPENREEL_EDITOR_URL || "https://reel.alterindonesia.com");
const secret = process.env.OPENREEL_WORKER_TOKEN;
if (!secret || secret.length < 32) throw new Error("OPENREEL_WORKER_TOKEN must contain at least 32 characters");
const workerId = randomUUID();
const capacity = Math.max(1, Math.min(10, Number(process.env.OPENREEL_WORKER_CONCURRENCY || 2)));
const allowedOrigins = new Set([api.origin, editor.origin, ...(process.env.TBOT_PUBLIC_URL ? [new URL(process.env.TBOT_PUBLIC_URL).origin] : []), ...(process.env.OPENREEL_ALLOWED_ORIGINS || "").split(",").filter(Boolean)]);
const pages = new Map();
let lastHeartbeat = 0;
let capabilities = [];
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || "/usr/bin/chromium", headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--enable-webgl", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"] });
async function shutdown() {
  try {
    await browser.close();
    await fetch(new URL("/api/video/worker", api), { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ workerId, active: [], capabilities, capacity, shutdown: true }), signal: AbortSignal.timeout(10000) });
  } finally { process.exit(0); }
}
process.once("SIGTERM", () => { void shutdown(); });
process.once("SIGINT", () => { void shutdown(); });

async function newContext() {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 900 } });
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (["blob:", "data:"].includes(url.protocol) || allowedOrigins.has(url.origin)) await route.continue();
    else await route.abort();
  });
  return context;
}

const bootstrap = await newContext();
const catalogPage = await bootstrap.newPage();
await catalogPage.goto(`${editor.origin}/?backendWorker=1#/editor`, { waitUntil: "domcontentloaded", timeout: 120000 });
await catalogPage.waitForFunction(() => Array.isArray(window.__alterCapabilities), undefined, { timeout: 120000 });
capabilities = await catalogPage.evaluate(() => window.__alterCapabilities);
await bootstrap.close();

async function attach({ projectId, token }) {
  const context = await newContext();
  await context.addInitScript(({ projectId, token, origin }) => {
    if (location.origin === origin) sessionStorage.setItem(`alter-editor:${projectId}`, token);
  }, { projectId, token, origin: editor.origin });
  const page = await context.newPage();
  const encoder = createEncoderBridge(api, token);
  await page.exposeBinding("__alterEncoder", encoder.handle);
  context.on("close", () => { void encoder.dispose(); });
  pages.set(projectId, { context, page, lastBusy: Date.now() });
  page.on("download", async (download) => {
    try {
      const path = await download.path();
      const response = await fetch(new URL("/api/video/assets", api), { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream", "X-Filename": encodeURIComponent(download.suggestedFilename()), "X-Asset-Kind": "export" }, body: createReadStream(path), duplex: "half", signal: AbortSignal.timeout(600000) });
      if (!response.ok) throw new Error(`Export upload failed (${response.status})`);
    } catch (error) { console.error("OpenReel export delivery:", error.message); }
  });
  await page.goto(`${editor.origin}/?backendWorker=1#/editor?projectId=${encodeURIComponent(projectId)}`, { waitUntil: "domcontentloaded", timeout: 120000 });
}

createServer((_request, response) => {
  const healthy = Date.now() - lastHeartbeat < 90000;
  response.writeHead(healthy ? 200 : 503, { "Content-Type": "application/json" });
  response.end(JSON.stringify({ healthy, activeProjects: pages.size, capabilities: capabilities.length }));
}).listen(Number(process.env.PORT || 8091), "0.0.0.0");

for (;;) {
  try {
    for (const [id, entry] of pages) {
      const failed = entry.page.isClosed() || await entry.page.evaluate(() => Boolean(window.__alterBridgeFailed)).catch(() => true);
      if (failed) { await entry.context.close().catch(() => {}); pages.delete(id); }
    }
    const response = await fetch(new URL("/api/video/worker", api), { method: "POST", headers: { Authorization: `Bearer ${secret}`, "Content-Type": "application/json" }, body: JSON.stringify({ workerId, active: [...pages.keys()], capabilities, capacity }), signal: AbortSignal.timeout(20000) });
    if (!response.ok) throw new Error(`Worker heartbeat rejected (${response.status})`);
    const result = await response.json();
    lastHeartbeat = Date.now();
    for (const { id, busy } of result.activity) {
      const entry = pages.get(id);
      if (!entry) continue;
      if (busy) entry.lastBusy = Date.now();
      else if (Date.now() - entry.lastBusy > 60000) { await entry.context.close(); pages.delete(id); }
    }
    await Promise.all(result.assignments.map((assignment) => attach(assignment).catch(async (error) => {
      const entry = pages.get(assignment.projectId);
      await entry?.context.close().catch(() => {});
      pages.delete(assignment.projectId);
      console.error("OpenReel project worker:", error.message);
    })));
  } catch (error) { console.error("OpenReel worker:", error.message); }
  await delay(5000);
}
