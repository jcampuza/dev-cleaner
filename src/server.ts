import { $ } from "bun";
import { parseArgs } from "node:util";
import { deleteCleanItems, scanCleanableItems } from "./cleaner";
import appHtml from "./client/index.html";
import type { ProgressEvent, ScanResult, ScanStatus } from "./types";

interface ServerState {
  status: ScanStatus;
  scan: ScanResult | null;
  projectRoots: string[];
  clients: Set<ReadableStreamDefaultController<Uint8Array>>;
}

interface CliOptions {
  full: boolean;
  noOpen: boolean;
}

const encoder = new TextEncoder();

export function createServerState(): ServerState {
  return {
    status: "idle",
    scan: null,
    projectRoots: getInitialProjectRoots(),
    clients: new Set(),
  };
}

export function createServerOptions(state = createServerState()) {
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
        POST: withRouteErrors(state, (request) => scan(state, request)),
      },
      "/api/delete": {
        POST: withRouteErrors(state, (request) => deleteItems(state, request)),
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

function stateResponse(state: ServerState): Response {
  return json({
    status: state.status,
    scan: state.scan,
    projectRoots: state.projectRoots,
  });
}

async function scan(state: ServerState, request: Request): Promise<Response> {
  if (state.status === "scanning") {
    return json({ error: "A scan is already running." }, 409);
  }

  const body = await readJson<{ projectRoots?: string[] }>(request);
  const requestedRoots = normalizeRoots(body.projectRoots);
  if (requestedRoots.length > 0) state.projectRoots = requestedRoots;

  state.status = "scanning";
  state.scan = await scanCleanableItems({
    projectRoots: state.projectRoots,
    onProgress: (event) => broadcast(state, event),
  });
  state.status = "complete";

  return json(state.scan);
}

async function deleteItems(state: ServerState, request: Request): Promise<Response> {
  if (!state.scan) return json({ error: "Run a scan before deleting." }, 400);

  const body = await readJson<{ ids?: string[] }>(request);
  const ids = Array.isArray(body.ids) ? body.ids.filter((id) => typeof id === "string") : [];
  if (ids.length === 0) return json({ error: "No item IDs were provided." }, 400);

  const result = await deleteCleanItems(state.scan, ids, (event) => broadcast(state, event));
  return json(result);
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
