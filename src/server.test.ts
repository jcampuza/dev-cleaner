import { afterEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { deleteCleanItems, makeFixtureDir, scanCleanableItems } from "./cleaner";
import { createServerOptions, createServerState, getInitialProjectRoots, parseCliOptions } from "./server";

const originalHome = process.env.HOME;
const originalRoots = process.env.DEV_CLEANER_SCAN_ROOTS;
const fixtures = new Set<string>();

afterEach(async () => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalRoots === undefined) delete process.env.DEV_CLEANER_SCAN_ROOTS;
  else process.env.DEV_CLEANER_SCAN_ROOTS = originalRoots;

  await Promise.all(Array.from(fixtures, (fixture) => rm(fixture, { recursive: true, force: true })));
  fixtures.clear();
});

async function fixtureHome() {
  const fixture = await makeFixtureDir();
  fixtures.add(fixture);
  const home = join(fixture, "home");
  await mkdir(home, { recursive: true });
  process.env.HOME = home;
  return { fixture, home };
}

function serve(
  state = createServerState(),
  dependencies?: NonNullable<Parameters<typeof createServerOptions>[1]>,
) {
  return Bun.serve({ ...createServerOptions(state, dependencies), port: 0 });
}

function jsonPost(server: Bun.Server<undefined>, path: string, body: unknown, headers: HeadersInit = {}) {
  return fetch(new URL(path, server.url), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

test("parses full scan flags", () => {
  expect(parseCliOptions(["-f"])).toEqual({ full: true, noOpen: false });
  expect(parseCliOptions(["--full", "--no-open"])).toEqual({ full: true, noOpen: true });
});

test("full scan starts from the user home folder", () => {
  process.env.HOME = "/tmp/dev-cleaner-home";
  delete process.env.DEV_CLEANER_SCAN_ROOTS;

  expect(getInitialProjectRoots(parseCliOptions(["--full"]))).toEqual(["/tmp/dev-cleaner-home"]);
});

test("explicit scan roots override full scan", () => {
  process.env.HOME = "/tmp/dev-cleaner-home";
  process.env.DEV_CLEANER_SCAN_ROOTS = "/tmp/one:/tmp/two";

  expect(getInitialProjectRoots(parseCliOptions(["--full"]))).toEqual(["/tmp/one", "/tmp/two"]);
});

test("serves state through Bun routes", async () => {
  const state = createServerState();
  state.projectRoots = ["/tmp/dev-cleaner-home"];
  const server = Bun.serve({
    ...createServerOptions(state),
    port: 0,
  });

  try {
    const response = await fetch(new URL("/api/state", server.url));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({
      status: "idle",
      scan: null,
      partialScan: null,
      projectRoots: ["/tmp/dev-cleaner-home"],
      activeOperation: null,
      operationId: null,
    });
  } finally {
    await server.stop(true);
  }
});

test("rejects mutation requests with a foreign origin or non-JSON content type", async () => {
  const server = serve();

  try {
    const foreign = await jsonPost(server, "/api/scan", {}, { origin: "https://example.com" });
    const plain = await fetch(new URL("/api/scan", server.url), { method: "POST", body: "{}" });

    expect(foreign.status).toBe(403);
    expect(await foreign.json()).toEqual({ error: "Cross-origin requests are not allowed." });
    expect(plain.status).toBe(415);
    expect(await plain.json()).toEqual({ error: "Content-Type must be application/json." });
  } finally {
    await server.stop(true);
  }
});

test("reports active scan state and rejects scan/delete conflicts", async () => {
  const { fixture } = await fixtureHome();
  const state = createServerState();
  state.projectRoots = [fixture];
  let releaseScan!: () => void;
  let markStarted!: () => void;
  const scanStarted = new Promise<void>((resolve) => { markStarted = resolve; });
  const scanBarrier = new Promise<void>((resolve) => { releaseScan = resolve; });
  const server = serve(state, {
    scan: async (options) => {
      markStarted();
      await scanBarrier;
      return scanCleanableItems(options);
    },
    delete: deleteCleanItems,
  });

  try {
    const activeScan = jsonPost(server, "/api/scan", { projectRoots: [fixture] });
    await scanStarted;
    const stateResponse = await fetch(new URL("/api/state", server.url));
    const conflictingScan = await jsonPost(server, "/api/scan", {});
    const conflictingDelete = await jsonPost(server, "/api/delete", { ids: ["item"] });

    expect(await stateResponse.json()).toMatchObject({
      status: "scanning",
      activeOperation: "scan",
      operationId: expect.any(String),
    });
    expect(conflictingScan.status).toBe(409);
    expect(conflictingDelete.status).toBe(409);
    expect(await conflictingScan.json()).toEqual({ error: "A scan operation is already running." });
    expect(await conflictingDelete.json()).toEqual({ error: "A scan operation is already running." });
    releaseScan();
    expect((await activeScan).status).toBe(200);
  } finally {
    releaseScan();
    await server.stop(true);
  }
});

test("clears failed operation state and accepts a later scan", async () => {
  const { fixture } = await fixtureHome();
  const state = createServerState();
  state.projectRoots = [fixture];
  let attempts = 0;
  const server = serve(state, {
    scan: async (options) => {
      attempts += 1;
      if (attempts === 1) throw new Error("fixture scan failed");
      return scanCleanableItems(options);
    },
    delete: deleteCleanItems,
  });

  try {
    const failed = await jsonPost(server, "/api/scan", { projectRoots: [fixture] });
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({ error: "fixture scan failed" });
    expect(state.status).toBe("error");
    expect(state.activeOperation).toBeNull();
    expect(state.operationId).toBeNull();

    const recovered = await jsonPost(server, "/api/scan", { projectRoots: [fixture] });
    expect(recovered.status).toBe(200);
    expect(state.status).toBe("complete");
    expect(state.activeOperation).toBeNull();
  } finally {
    await server.stop(true);
  }
});

test("reconciles the saved scan snapshot after deletion", async () => {
  const { fixture, home } = await fixtureHome();
  const cache = join(home, ".bun/install/cache");
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, "pkg.tgz"), "cached package");
  const state = createServerState();
  state.projectRoots = [fixture];
  const server = serve(state);

  try {
    const scanResponse = await jsonPost(server, "/api/scan", { projectRoots: [fixture] });
    const scan = await scanResponse.json();
    const item = scan.categories.flatMap((category: { items: Array<{ path: string }> }) => category.items)
      .find((entry: { path: string }) => entry.path === cache);
    expect(item).toBeDefined();

    const deletedResponse = await jsonPost(server, "/api/delete", { ids: [item.id] });
    const deleted = await deletedResponse.json();
    const savedItems = deleted.scan.categories.flatMap((category: { items: unknown[] }) => category.items);

    expect(deletedResponse.status).toBe(200);
    expect(deleted.deleted).toHaveLength(1);
    expect(savedItems).toHaveLength(scan.summary.itemCount - 1);
    expect(deleted.scan.summary.itemCount).toBe(scan.summary.itemCount - 1);
    expect(state.scan).toEqual(deleted.scan);
  } finally {
    await server.stop(true);
  }
});

test("serves events through Bun routes with an initial SSE message", async () => {
  const server = Bun.serve({
    ...createServerOptions(createServerState()),
    port: 0,
  });

  try {
    const response = await fetch(new URL("/api/events", server.url));

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");

    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const result = await reader!.read();
    await reader!.cancel();

    expect(new TextDecoder().decode(result.value)).toBe(
      `data: ${JSON.stringify({ type: "connected", message: "Connected" })}\n\n`,
    );
  } finally {
    await server.stop(true);
  }
});

test("streams scan progress over SSE with one operation id", async () => {
  const { fixture, home } = await fixtureHome();
  const cache = join(home, ".bun/install/cache");
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, "pkg.tgz"), "cached package");
  const state = createServerState();
  state.projectRoots = [fixture];
  const server = serve(state);

  try {
    const eventResponse = await fetch(new URL("/api/events", server.url));
    const reader = eventResponse.body!.getReader();
    const events: Array<{ type: string; sessionId?: string; payload?: unknown }> = [];
    let buffered = "";

    const scanPromise = jsonPost(server, "/api/scan", { projectRoots: [fixture] });
    while (!events.some((event) => event.type === "scan-complete")) {
      const chunk = await reader.read();
      expect(chunk.done).toBe(false);
      buffered += new TextDecoder().decode(chunk.value, { stream: true });
      const blocks = buffered.split("\n\n");
      buffered = blocks.pop() ?? "";
      for (const block of blocks) {
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (data) events.push(JSON.parse(data.slice(6)));
      }
    }
    const scanResponse = await scanPromise;
    await reader.cancel();

    const progress = events.filter((event) => event.type.startsWith("scan-"));
    const sessionIds = new Set(progress.map((event) => event.sessionId));
    const item = progress.find((event) => event.type === "scan-item");
    expect(scanResponse.status).toBe(200);
    expect(progress[0]?.type).toBe("scan-start");
    expect(progress.at(-1)?.type).toBe("scan-complete");
    expect(sessionIds.size).toBe(1);
    expect(Array.from(sessionIds)[0]).toEqual(expect.any(String));
    expect(item?.payload).toMatchObject({ item: { path: cache, size: expect.any(Number) } });
  } finally {
    await server.stop(true);
  }
});
