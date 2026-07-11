import { $ } from "bun";
import { parseArgs } from "node:util";
import { deleteCleanItems, scanCleanableItems } from "./cleaner";
import appHtml from "./client/index.html";
import type { CleanCategory, CleanItem, PartialScanResult, ProgressEvent, ScanResult, ScanStatus, ServerOperation } from "./types";

interface ServerState {
  status: ScanStatus;
  scan: ScanResult | null;
  projectRoots: string[];
  partialScan: PartialScanResult | null;
  activeOperation: ServerOperation | null;
  operationId: string | null;
  clients: Set<ReadableStreamDefaultController<Uint8Array>>;
}

interface CliOptions {
  full: boolean;
  noOpen: boolean;
}

interface ServerDependencies {
  scan: typeof scanCleanableItems;
  delete: typeof deleteCleanItems;
}

const encoder = new TextEncoder();

export function createServerState(): ServerState {
  return {
    status: "idle",
    scan: null,
    projectRoots: getInitialProjectRoots(),
    partialScan: null,
    activeOperation: null,
    operationId: null,
    clients: new Set(),
  };
}

export function createServerOptions(state = createServerState(), dependencies: ServerDependencies = { scan: scanCleanableItems, delete: deleteCleanItems }) {
  return {
    routes: {
      "/": appHtml,
      "/favicon.ico": {
        GET: new Response(null, { status: 204 }),
      },
      "/api/state": {
        GET: withRouteErrors(state, () => stateResponse(state)),
      },
      "/api/events": {
        GET: withRouteErrors(state, (request, server) => eventStream(state, request, server)),
      },
      "/api/scan": {
        POST: withRouteErrors(state, (request) => scan(state, request, dependencies)),
      },
      "/api/delete": {
        POST: withRouteErrors(state, (request) => deleteItems(state, request, dependencies)),
      },
    },
    fetch() {
      return json({ error: "Not found" }, 404);
    },
    error(error) {
      return routeError(state, error);
    },
  } satisfies Bun.Serve.Options<undefined>;
}

export async function startServer() {
  const port = parsePort(process.env.PORT) ?? 3421;
  const hostname = process.env.HOST ?? "127.0.0.1";
  const cliOptions = parseCliOptions();
  const state = createServerState();
  state.projectRoots = getInitialProjectRoots(cliOptions);
  const server = Bun.serve({
    ...createServerOptions(state),
    hostname,
    port,
  });

  const url = `http://${server.hostname}:${server.port}`;
  console.log(`Dev Cleaner running at ${url}`);
  console.log(`Scan roots: ${state.projectRoots.join(", ")}`);

  if (!cliOptions.noOpen) {
    void openBrowser(url);
  }

  return server;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      "cache-control": "no-store",
    },
  });
}

async function readJson<T>(request: Request): Promise<T> {
  if (!request.body) return {} as T;
  return await request.json() as T;
}

function validateMutationRequest(request: Request): Response | undefined {
  const origin = request.headers.get("origin");
  if (origin && origin !== new URL(request.url).origin) {
    return json({ error: "Cross-origin requests are not allowed." }, 403);
  }
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    return json({ error: "Content-Type must be application/json." }, 415);
  }
}

function stateResponse(state: ServerState): Response {
  return json({
    status: state.status,
    scan: state.scan,
    partialScan: state.partialScan,
    projectRoots: state.projectRoots,
    activeOperation: state.activeOperation,
    operationId: state.operationId,
  });
}

async function scan(state: ServerState, request: Request, dependencies: ServerDependencies): Promise<Response> {
  const invalid = validateMutationRequest(request);
  if (invalid) return invalid;
  if (state.activeOperation) return json({ error: `A ${state.activeOperation} operation is already running.` }, 409);

  const body = await readJson<{ projectRoots?: string[] }>(request);
  if (Object.hasOwn(body, "projectRoots")) state.projectRoots = normalizeRoots(body.projectRoots);

  const sessionId = crypto.randomUUID();
  state.activeOperation = "scan";
  state.operationId = sessionId;
  state.status = "scanning";
  state.partialScan = null;
  try {
    const result = await dependencies.scan({
      projectRoots: state.projectRoots,
      scanId: sessionId,
      onProgress: (event) => {
        applyProgress(state, event);
        broadcast(state, event);
      },
    });
    if (state.operationId === sessionId) {
      state.scan = result;
      state.partialScan = null;
      state.status = "complete";
    }
    return json(result);
  } finally {
    if (state.operationId === sessionId) {
      state.activeOperation = null;
      state.operationId = null;
    }
  }
}

async function deleteItems(state: ServerState, request: Request, dependencies: ServerDependencies): Promise<Response> {
  const invalid = validateMutationRequest(request);
  if (invalid) return invalid;
  if (state.activeOperation) return json({ error: `A ${state.activeOperation} operation is already running.` }, 409);
  if (!state.scan) return json({ error: "Run a scan before deleting." }, 400);

  const body = await readJson<{ ids?: string[] }>(request);
  const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === "string") : [];
  if (ids.length === 0) return json({ error: "No item IDs were provided." }, 400);

  const operationId = crypto.randomUUID();
  state.activeOperation = "delete";
  state.operationId = operationId;
  try {
    const result = await dependencies.delete(state.scan, ids, (event) => broadcast(state, { ...event, sessionId: operationId }));
    const deletedIds = new Set(result.deleted.map((item) => item.id));
    state.scan = removeDeletedItems(state.scan, deletedIds);
    return json({ ...result, scan: state.scan });
  } finally {
    if (state.operationId === operationId) {
      state.activeOperation = null;
      state.operationId = null;
    }
  }
}

function applyProgress(state: ServerState, event: ProgressEvent) {
  if (!event.sessionId || event.sessionId !== state.operationId) return;
  if (event.type === "scan-start") {
    const payload = event.payload as { home: string; projectRoots: string[]; startedAt: string };
    state.partialScan = { id: event.sessionId, startedAt: payload.startedAt, home: payload.home, projectRoots: payload.projectRoots, categories: [], totalSize: 0, itemCount: 0 };
  } else if (event.type === "scan-category" && state.partialScan) {
    const payload = event.payload as { categoryId: string; category?: Omit<CleanCategory, "items" | "totalSize" | "selectedSize"> };
    state.partialScan.currentCategoryId = payload.categoryId;
    if (payload.category && !state.partialScan.categories.some((entry) => entry.id === payload.categoryId)) {
      state.partialScan.categories.push({ ...payload.category, items: [], totalSize: 0, selectedSize: 0 });
    }
  } else if (event.type === "scan-index" && state.partialScan) {
    state.partialScan.index = event.payload as PartialScanResult["index"];
  } else if (event.type === "scan-item" && state.partialScan) {
    appendPartialItem(state.partialScan, (event.payload as { item: CleanItem }).item);
  }
}

function appendPartialItem(partial: PartialScanResult, item: CleanItem) {
  let category = partial.categories.find((entry) => entry.id === item.categoryId);
  if (!category) {
    category = { id: item.categoryId, name: item.categoryName, description: "", accent: "", items: [], totalSize: 0, selectedSize: 0 };
    partial.categories.push(category);
  }
  category.items.push(item);
  category.totalSize += item.size;
  if (item.selectedByDefault) category.selectedSize += item.size;
  partial.totalSize += item.size;
  partial.itemCount += 1;
}

function removeDeletedItems(scan: ScanResult, deletedIds: Set<string>): ScanResult {
  const categories: CleanCategory[] = scan.categories.map((category) => {
    const items = category.items.filter((item) => !deletedIds.has(item.id));
    return { ...category, items, totalSize: items.reduce((sum, item) => sum + item.size, 0), selectedSize: items.filter((item) => item.selectedByDefault).reduce((sum, item) => sum + item.size, 0) };
  }).filter((category) => category.items.length > 0);
  const items = categories.flatMap((category) => category.items);
  return { ...scan, categories, summary: { ...scan.summary, totalSize: items.reduce((sum, item) => sum + item.size, 0), selectedSize: items.filter((item) => item.selectedByDefault).reduce((sum, item) => sum + item.size, 0), itemCount: items.length, selectedCount: items.filter((item) => item.selectedByDefault).length } };
}

function eventStream(state: ServerState, request: Request, server: Bun.Server<undefined>): Response {
  server.timeout(request, 0);

  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      streamController = controller;
      state.clients.add(controller);
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ type: "connected", message: "Connected" })}\n\n`));
    },
    cancel() {
      if (streamController) state.clients.delete(streamController);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    },
  });
}

function withRouteErrors(
  state: ServerState,
  handler: (request: Request, server: Bun.Server<undefined>) => Response | Promise<Response>,
) {
  return async (request: Request, server: Bun.Server<undefined>): Promise<Response> => {
    try {
      return await handler(request, server);
    } catch (error) {
      return routeError(state, error);
    }
  };
}

function routeError(state: ServerState, error: unknown): Response {
  state.status = "error";
  const message = error instanceof Error ? error.message : String(error);
  broadcast(state, { type: "error", message });
  return json({ error: message }, 500);
}

function broadcast(state: ServerState, event: ProgressEvent) {
  const payload = encoder.encode(`data: ${JSON.stringify(event)}\n\n`);
  for (const client of state.clients) {
    try {
      client.enqueue(payload);
    } catch {
      state.clients.delete(client);
    }
  }
}

export function parseCliOptions(args: string[] = Bun.argv): CliOptions {
  const { values } = parseArgs({
    args,
    options: {
      full: {
        type: "boolean",
        short: "f",
      },
      "no-open": {
        type: "boolean",
      },
    },
    strict: true,
    allowPositionals: true,
  });

  return {
    full: values.full === true,
    noOpen: values["no-open"] === true,
  };
}

export function getInitialProjectRoots(options: CliOptions = parseCliOptions()): string[] {
  const home = process.env.HOME;
  const envRoots = process.env.DEV_CLEANER_SCAN_ROOTS?.split(":")
    .map((root) => root.trim())
    .filter(Boolean);
  if (envRoots && envRoots.length > 0) return envRoots;
  if (options.full) return [home || process.cwd()];
  return [home || process.cwd()];
}

function normalizeRoots(roots: unknown): string[] {
  if (!Array.isArray(roots)) return [];
  return roots
    .filter((root): root is string => typeof root === "string")
    .map((root) => root.trim())
    .filter(Boolean);
}

function parsePort(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 && port < 65_536 ? port : undefined;
}

async function openBrowser(url: string) {
  try {
    if (process.platform === "darwin") {
      await $`open ${url}`.quiet();
    } else if (process.platform === "win32") {
      await $`cmd /c start ${url}`.quiet();
    } else {
      await $`xdg-open ${url}`.quiet();
    }
  } catch {
    // Browser opening is convenience-only; the URL is printed above.
  }
}
