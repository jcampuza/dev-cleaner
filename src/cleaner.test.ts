import { afterEach, beforeEach, expect, test } from "bun:test";
import { lstat, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { makeFixtureDir, scanCleanableItems, deleteCleanItems } from "./cleaner";

let fixture: string;

beforeEach(async () => {
  fixture = await makeFixtureDir();
});

afterEach(async () => {
  await rm(fixture, { recursive: true, force: true });
});

test("scans xcode device support and keeps latest version unselected", async () => {
  const root = join(fixture, "home");
  await mkdir(join(root, "Library/Developer/Xcode/iOS DeviceSupport/17.1 (21B74)"), { recursive: true });
  await mkdir(join(root, "Library/Developer/Xcode/iOS DeviceSupport/16.4 (20E247)"), { recursive: true });
  await writeFile(join(root, "Library/Developer/Xcode/iOS DeviceSupport/17.1 (21B74)/symbols.bin"), "new");
  await writeFile(join(root, "Library/Developer/Xcode/iOS DeviceSupport/16.4 (20E247)/symbols.bin"), "old-old-old");

  const result = await scanCleanableItems({ home: root, cwd: fixture, projectRoots: [fixture] });
  const items = result.categories.flatMap((category) => category.items);
  const latest = items.find((item) => item.label.includes("17.1"));
  const older = items.find((item) => item.label.includes("16.4"));

  expect(latest).toBeDefined();
  expect(older).toBeDefined();
  expect(latest?.selectedByDefault).toBe(false);
  expect(older?.selectedByDefault).toBe(true);
});

test("finds project artifacts only under configured roots", async () => {
  const root = join(fixture, "home");
  const project = join(fixture, "workspace/app");
  const outside = join(fixture, "outside/app");
  await mkdir(join(project, "node_modules/pkg"), { recursive: true });
  await mkdir(join(outside, "node_modules/pkg"), { recursive: true });
  await writeFile(join(project, "package.json"), "{}");
  await writeFile(join(project, "node_modules/pkg/index.js"), "dependency");
  await writeFile(join(outside, "package.json"), "{}");
  await writeFile(join(outside, "node_modules/pkg/index.js"), "dependency");

  const result = await scanCleanableItems({ home: root, cwd: fixture, projectRoots: [join(fixture, "workspace")] });
  const labels = result.categories.flatMap((category) => category.items.map((item) => item.path));

  expect(labels.some((path) => path.includes("workspace/app/node_modules"))).toBe(true);
  expect(labels.some((path) => path.includes("outside/app/node_modules"))).toBe(false);
});

test("finds nested node targets without requiring package manifests", async () => {
  const root = join(fixture, "home");
  const nested = join(root, "dev/archive/web-app");
  await mkdir(join(nested, "node_modules/pkg"), { recursive: true });
  await mkdir(join(nested, ".pnpm-store/v3/files"), { recursive: true });
  await mkdir(join(nested, ".next/cache"), { recursive: true });
  await writeFile(join(nested, "node_modules/pkg/index.js"), "dependency");
  await writeFile(join(nested, ".pnpm-store/v3/files/blob"), "store");
  await writeFile(join(nested, ".next/cache/entry"), "cache");

  const result = await scanCleanableItems({ home: root, maxProjectDepth: 8 });
  const items = result.categories.flatMap((category) => category.items);

  expect(items.some((item) => item.path.endsWith("web-app/node_modules"))).toBe(true);
  expect(items.some((item) => item.path.endsWith("web-app/.pnpm-store"))).toBe(true);
  expect(items.some((item) => item.path.endsWith("web-app/.next"))).toBe(true);
});

test("treats max project depth as inclusive", async () => {
  const root = join(fixture, "home");
  const atLimit = join(root, "one/two/node_modules/pkg");
  const beyondLimit = join(root, "one/two/three/node_modules/pkg");
  await mkdir(atLimit, { recursive: true });
  await mkdir(beyondLimit, { recursive: true });
  await writeFile(join(atLimit, "index.js"), "at-limit");
  await writeFile(join(beyondLimit, "index.js"), "beyond-limit");

  const result = await scanCleanableItems({ home: root, projectRoots: [root], maxProjectDepth: 2 });
  const paths = result.categories.flatMap((category) => category.items.map((item) => item.path));

  expect(paths).toContain(join(root, "one/two/node_modules"));
  expect(paths).not.toContain(join(root, "one/two/three/node_modules"));
});

test("limits project discovery by visited directory count", async () => {
  const root = join(fixture, "home");
  const events: Array<{ type: string; payload?: unknown }> = [];
  await mkdir(join(root, "project/node_modules/pkg"), { recursive: true });
  await writeFile(join(root, "project/node_modules/pkg/index.js"), "dependency");

  const exhausted = await scanCleanableItems({
    home: root,
    projectRoots: [root],
    maxProjectEntries: 1,
    onProgress: (event) => events.push(event),
  });
  const allowed = await scanCleanableItems({ home: root, projectRoots: [root], maxProjectEntries: 2 });
  const paths = (result: typeof allowed) => result.categories.flatMap((category) => category.items.map((item) => item.path));

  expect(paths(exhausted)).not.toContain(join(root, "project/node_modules"));
  expect(paths(allowed)).toContain(join(root, "project/node_modules"));
  expect(events.findLast((event) => event.type === "scan-index")?.payload).toMatchObject({
    entriesVisited: 1,
    cappedRoots: [root],
  });
});

test("does not traverse symlinked directories during project discovery", async () => {
  const root = join(fixture, "home");
  const external = join(fixture, "external");
  await mkdir(join(root, "workspace"), { recursive: true });
  await mkdir(join(external, "node_modules/pkg"), { recursive: true });
  await writeFile(join(external, "node_modules/pkg/index.js"), "dependency");
  await symlink(external, join(root, "workspace/linked-project"));

  const result = await scanCleanableItems({ home: root, projectRoots: [root] });
  const paths = result.categories.flatMap((category) => category.items.map((item) => item.path));

  expect(paths).not.toContain(join(root, "workspace/linked-project/node_modules"));
  expect((await lstat(join(root, "workspace/linked-project"))).isSymbolicLink()).toBe(true);
});

test("emits ordered scan progress with usable payloads", async () => {
  const root = join(fixture, "home");
  const cache = join(root, ".bun/install/cache");
  const events: Array<{ type: string; message: string; payload?: unknown }> = [];
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, "pkg.tgz"), "cached package");

  const result = await scanCleanableItems({
    home: root,
    projectRoots: [fixture],
    onProgress: (event) => events.push(event),
  });

  expect(events[0]).toMatchObject({
    type: "scan-start",
    message: "Scan started",
    payload: { home: root, projectRoots: [fixture] },
  });
  expect(events.at(-1)).toMatchObject({ type: "scan-complete", payload: result.summary });
  const itemIndex = events.findIndex((event) => event.type === "scan-item");
  const nodeCategoryIndex = events.findIndex((event) => event.type === "scan-category" && event.message === "Node");
  expect(itemIndex).toBeGreaterThan(nodeCategoryIndex);
  expect(events[itemIndex]?.payload).toMatchObject({
    id: expect.any(String),
    size: expect.any(Number),
  });
});

test("delete only accepts ids from the latest scan", async () => {
  const root = join(fixture, "home");
  const cache = join(root, ".bun/install/cache");
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, "pkg.tgz"), "cached package");

  const result = await scanCleanableItems({ home: root, cwd: fixture, projectRoots: [fixture] });
  const item = result.categories.flatMap((category) => category.items).find((entry) => entry.path === cache);
  expect(item).toBeDefined();

  const deleted = await deleteCleanItems(result, [item!.id, "missing-id"]);
  expect(deleted.deleted).toHaveLength(1);
  expect(deleted.failed).toHaveLength(1);
  expect(deleted.failed[0]?.error).toContain("latest scan");
});

test("delete progress is ordered and duplicate ids are handled once", async () => {
  const root = join(fixture, "home");
  const cache = join(root, ".bun/install/cache");
  const events: Array<{ type: string; message: string; payload?: unknown }> = [];
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, "pkg.tgz"), "cached package");
  const scan = await scanCleanableItems({ home: root, projectRoots: [fixture] });
  const item = scan.categories.flatMap((category) => category.items).find((entry) => entry.path === cache)!;

  const result = await deleteCleanItems(scan, [item.id, item.id], (event) => events.push(event));

  expect(result.deleted).toHaveLength(1);
  expect(events.map((event) => event.type)).toEqual(["delete-start", "delete-item", "delete-complete"]);
  expect(events[0]?.payload).toEqual({ count: 1 });
  expect(events.at(-1)?.payload).toEqual({ freedBytes: item.size, failed: 0 });
});

test("canonicalizes nested cleanup targets before computing scan totals", async () => {
  const root = join(fixture, "home");
  const parent = join(root, "project/.next");
  const nested = join(parent, ".cache");
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, "entry"), "cached output");

  const result = await scanCleanableItems({ home: root, projectRoots: [parent, nested] });
  const matching = result.categories.flatMap((category) => category.items)
    .filter((item) => item.path === parent || item.path === nested);

  expect(matching.map((item) => item.path)).toEqual([parent]);
  expect(result.summary.totalSize).toBe(result.categories.reduce((total, category) => total + category.totalSize, 0));
});

test("counts a nested requested deletion only once", async () => {
  const root = join(fixture, "home");
  const parent = join(root, ".bun/install/cache");
  const nested = join(parent, "nested");
  await mkdir(nested, { recursive: true });
  await writeFile(join(nested, "entry"), "cached output");
  const scan = await scanCleanableItems({ home: root, projectRoots: [] });
  const parentItem = scan.categories.flatMap((category) => category.items).find((item) => item.path === parent)!;
  const nestedItem = { ...parentItem, id: `${parentItem.id}-nested`, path: nested, size: 13 };
  scan.categories[0]!.items.push(nestedItem);

  const result = await deleteCleanItems(scan, [parentItem.id, nestedItem.id]);

  expect(result.freedBytes).toBe(parentItem.size);
  expect(result.deleted).toContainEqual({ id: nestedItem.id, path: nested, size: 0 });
  expect(result.failed).toHaveLength(0);
});

test("does not report freed bytes when a scanned path was removed externally", async () => {
  const root = join(fixture, "home");
  const cache = join(root, ".bun/install/cache");
  await mkdir(cache, { recursive: true });
  await writeFile(join(cache, "pkg.tgz"), "cached package");
  const scan = await scanCleanableItems({ home: root, projectRoots: [] });
  const item = scan.categories.flatMap((category) => category.items).find((entry) => entry.path === cache)!;
  await rm(cache, { recursive: true });

  const result = await deleteCleanItems(scan, [item.id]);

  expect(result.deleted).toHaveLength(0);
  expect(result.freedBytes).toBe(0);
  expect(result.failed).toEqual([{ id: item.id, path: cache, error: "Item no longer exists." }]);
});
