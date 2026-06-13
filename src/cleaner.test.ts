import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
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
