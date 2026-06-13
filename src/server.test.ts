import { afterEach, expect, test } from "bun:test";
import { createServerOptions, createServerState, getInitialProjectRoots, parseCliOptions } from "./server";

const originalHome = process.env.HOME;
const originalRoots = process.env.DEV_CLEANER_SCAN_ROOTS;

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;

  if (originalRoots === undefined) delete process.env.DEV_CLEANER_SCAN_ROOTS;
  else process.env.DEV_CLEANER_SCAN_ROOTS = originalRoots;
});

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
      projectRoots: ["/tmp/dev-cleaner-home"],
    });
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
