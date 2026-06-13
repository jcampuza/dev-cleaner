import { constants } from "node:fs";
import type { Dirent } from "node:fs";
import { access, lstat, mkdtemp, realpath, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import type { CleanCategory, CleanItem, DeleteResult, ItemRisk, ProgressEvent, ScanResult } from "./types";

type ProgressSink = (event: ProgressEvent) => void;

interface CategoryDef {
  id: string;
  name: string;
  description: string;
  accent: string;
}

interface AddItemInput {
  category: CategoryDef;
  label: string;
  detail?: string;
  path: string;
  risk?: ItemRisk;
  selectedByDefault?: boolean;
  reason: string;
  tags?: string[];
}

export interface ScanOptions {
  home?: string;
  cwd?: string;
  projectRoots?: string[];
  maxProjectDepth?: number;
  maxProjectEntries?: number;
  onProgress?: ProgressSink;
}

const CATEGORIES: CategoryDef[] = [
  {
    id: "xcode",
    name: "Xcode",
    description: "Derived data, symbols, archives, docs, logs, and Xcode-owned caches.",
    accent: "#0f7bff",
  },
  {
    id: "simulators",
    name: "Simulators",
    description: "Simulator device data and CoreDevice cache surfaces.",
    accent: "#1b9a7b",
  },
  {
    id: "android",
    name: "Android",
    description: "Gradle, Android Studio, and Android SDK cache files.",
    accent: "#3aa84f",
  },
  {
    id: "flutter",
    name: "Flutter",
    description: "Flutter project build products and global Pub/FVM caches.",
    accent: "#1f9bd7",
  },
  {
    id: "node",
    name: "Node",
    description: "Node package manager caches and project dependency folders.",
    accent: "#d49b13",
  },
  {
    id: "apple",
    name: "Apple Tooling",
    description: "CocoaPods and iOS project dependency caches.",
    accent: "#b05ac8",
  },
  {
    id: "ide",
    name: "Editors",
    description: "VS Code and JetBrains cache directories.",
    accent: "#d65f44",
  },
];

const CATEGORY_BY_ID = new Map(CATEGORIES.map((category) => [category.id, category]));
const DEFAULT_MAX_PROJECT_DEPTH = 12;
const DEFAULT_MAX_PROJECT_ENTRIES = 250_000;
const NODE_TARGETS = [
  "node_modules",
  "bower_components",
  "jspm_packages",
  ".pnpm-store",
  ".yarn",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".astro",
  ".angular",
  ".expo",
  ".expo-shared",
  ".nx",
  ".turbo",
  ".parcel-cache",
  ".rpt2_cache",
  ".vite",
  ".cache",
  ".cache-loader",
  ".swc",
  ".esbuild",
  ".rollup.cache",
  "storybook-static",
  "coverage",
  ".nyc_output",
  ".jest",
  "playwright-report",
  "test-results",
  ".eslintcache",
  ".stylelintcache",
  ".prettiercache",
  ".docusaurus",
  ".vercel",
  ".netlify",
  ".now",
  "build",
  "dist",
  "out",
  "deno_cache",
] as const;

export async function scanCleanableItems(options: ScanOptions = {}): Promise<ScanResult> {
  const started = Date.now();
  const home = resolve(options.home ?? process.env.HOME ?? "");
  const projectRoots = sanitizeProjectRoots(options.projectRoots ?? getEnvProjectRoots() ?? [home], home);
  const onProgress = options.onProgress ?? (() => undefined);
  const seen = new Set<string>();
  const items: CleanItem[] = [];

  onProgress({ type: "scan-start", message: "Scan started", payload: { home, projectRoots } });

  const add = async (input: AddItemInput) => {
    const item = await createItem(input, seen);
    if (!item) return;
    items.push(item);
    onProgress({ type: "scan-item", message: item.label, payload: { id: item.id, size: item.size } });
  };

  for (const category of CATEGORIES) {
    onProgress({ type: "scan-category", message: category.name, payload: { categoryId: category.id } });
    switch (category.id) {
      case "xcode":
        await scanXcode(home, category, add);
        break;
      case "simulators":
        await scanSimulators(home, category, add);
        break;
      case "android":
        await scanAndroid(home, projectRoots, category, add, options);
        break;
      case "flutter":
        await scanFlutter(home, projectRoots, category, add, options);
        break;
      case "node":
        await scanNode(home, projectRoots, category, add, options);
        break;
      case "apple":
        await scanAppleTooling(home, projectRoots, category, add, options);
        break;
      case "ide":
        await scanIde(home, category, add);
        break;
    }
  }

  const categories = CATEGORIES.map((category) => buildCategory(category, items))
    .filter((category) => category.items.length > 0);
  const totalSize = sum(categories.map((category) => category.totalSize));
  const selectedSize = sum(categories.map((category) => category.selectedSize));
  const selectedCount = categories.reduce((count, category) => (
    count + category.items.filter((item) => item.selectedByDefault).length
  ), 0);
  const finished = Date.now();

  const result: ScanResult = {
    summary: {
      id: crypto.randomUUID(),
      startedAt: new Date(started).toISOString(),
      finishedAt: new Date(finished).toISOString(),
      durationMs: finished - started,
      home,
      projectRoots,
      totalSize,
      selectedSize,
      itemCount: items.length,
      selectedCount,
    },
    categories,
  };

  onProgress({ type: "scan-complete", message: "Scan complete", payload: result.summary });
  return result;
}

export async function deleteCleanItems(result: ScanResult, ids: string[], onProgress: ProgressSink = () => undefined): Promise<DeleteResult> {
  const itemById = new Map(result.categories.flatMap((category) => category.items.map((item) => [item.id, item])));
  const uniqueIds = Array.from(new Set(ids));
  const deleted: DeleteResult["deleted"] = [];
  const failed: DeleteResult["failed"] = [];

  onProgress({ type: "delete-start", message: "Delete started", payload: { count: uniqueIds.length } });

  for (const id of uniqueIds) {
    const item = itemById.get(id);
    if (!item) {
      failed.push({ id, path: "", error: "Item is not part of the latest scan." });
      continue;
    }

    try {
      await rm(item.path, { recursive: item.kind !== "file", force: true, maxRetries: 2 });
      deleted.push({ id: item.id, path: item.path, size: item.size });
      onProgress({ type: "delete-item", message: item.label, payload: { id: item.id, size: item.size } });
    } catch (error) {
      failed.push({ id: item.id, path: item.path, error: errorMessage(error) });
    }
  }

  const freedBytes = sum(deleted.map((item) => item.size));
  onProgress({ type: "delete-complete", message: "Delete complete", payload: { freedBytes, failed: failed.length } });

  return { deleted, failed, freedBytes };
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
}

async function scanXcode(home: string, category: CategoryDef, add: (input: AddItemInput) => Promise<void>) {
  const xcodeRoot = join(home, "Library/Developer/Xcode");

  await addChildren({
    category,
    parent: join(xcodeRoot, "DerivedData"),
    labelPrefix: "Derived Data",
    excludeNames: new Set(["ModuleCache"]),
    risk: "medium",
    selectedByDefault: false,
    reason: "Regeneratable Xcode project indexes and build intermediates.",
    tags: ["xcode", "project"],
    add,
  });

  for (const deviceSupport of ["iOS", "watchOS", "tvOS", "visionOS", "macOS"]) {
    const children = await existingChildren(join(xcodeRoot, `${deviceSupport} DeviceSupport`));
    const sorted = children.sort(compareVersionLikeDesc);
    for (const [index, child] of sorted.entries()) {
      await add({
        category,
        path: child,
        label: `${deviceSupport} DeviceSupport ${basename(child)}`,
        risk: "medium",
        selectedByDefault: index > 0,
        reason: index === 0
          ? "Latest symbol set is retained by default."
          : "Older downloaded device symbols can usually be restored by Xcode.",
        tags: ["xcode", "symbols"],
      });
    }
  }

  await addArchives(home, category, add);

  const docChildren = await existingGrandchildren(join(xcodeRoot, "DocumentationCache"));
  const docSorted = docChildren.sort(compareVersionLikeDesc);
  for (const [index, child] of docSorted.entries()) {
    await add({
      category,
      path: child,
      label: `Documentation Cache ${basename(child)}`,
      risk: "low",
      selectedByDefault: index > 0,
      reason: index === 0 ? "Newest Xcode documentation cache retained by default." : "Older Xcode documentation cache.",
      tags: ["xcode", "docs"],
    });
  }

  const logs = await existingChildren(join(xcodeRoot, "iOS Device Logs"));
  const logsByDate = await sortByMtimeDesc(logs);
  for (const [index, child] of logsByDate.entries()) {
    await add({
      category,
      path: child,
      label: `Device Log ${basename(child)}`,
      risk: "low",
      selectedByDefault: index > 0,
      reason: index === 0 ? "Newest device log retained by default." : "Older iOS device log or crash database.",
      tags: ["xcode", "logs"],
    });
  }

  await add({
    category,
    path: join(home, "Library/Caches/com.apple.dt.Xcode"),
    label: "Xcode App Cache",
    risk: "low",
    selectedByDefault: true,
    reason: "Xcode-owned application cache.",
    tags: ["xcode", "cache"],
  });
  await add({
    category,
    path: join(xcodeRoot, "Products"),
    label: "Xcode Products",
    risk: "medium",
    selectedByDefault: false,
    reason: "Build products may be large but are not always disposable for every workflow.",
    tags: ["xcode", "build"],
  });
  await add({
    category,
    path: join(home, "Library/Developer/Shared/Documentation"),
    label: "Old Downloaded Documentation",
    risk: "medium",
    selectedByDefault: false,
    reason: "Legacy offline documentation downloads.",
    tags: ["xcode", "docs"],
  });
}

async function scanSimulators(home: string, category: CategoryDef, add: (input: AddItemInput) => Promise<void>) {
  await add({
    category,
    path: join(home, "Library/Developer/CoreSimulator/Devices"),
    label: "Simulator Devices",
    risk: "high",
    selectedByDefault: false,
    reason: "Can remove simulator state and installed simulator apps.",
    tags: ["simulator", "xcode"],
  });

  await addChildren({
    category,
    parent: join(home, "Library/Containers/com.apple.CoreDevice.CoreDeviceService/Data/Library/Caches"),
    labelPrefix: "CoreDevice Cache",
    risk: "low",
    selectedByDefault: true,
    reason: "CoreDevice cache entries.",
    tags: ["simulator", "cache"],
    add,
  });
}

async function scanAndroid(
  home: string,
  projectRoots: string[],
  category: CategoryDef,
  add: (input: AddItemInput) => Promise<void>,
  options: ScanOptions,
) {
  for (const target of [
    ["Gradle Caches", join(home, ".gradle/caches"), "low", true, "Global Gradle dependency and transform caches."],
    ["Gradle Daemon State", join(home, ".gradle/daemon"), "low", true, "Gradle daemon working state."],
    ["Android SDK Temp", join(home, "Library/Android/sdk/.temp"), "low", true, "Android SDK temporary downloads."],
  ] as const) {
    await add({
      category,
      label: target[0],
      path: target[1],
      risk: target[2],
      selectedByDefault: target[3],
      reason: target[4],
      tags: ["android", "cache"],
    });
  }

  for (const path of await expandHomePatterns(home, [
    "Library/Caches/Google/AndroidStudio*",
    "Library/Caches/JetBrains/AndroidStudio*",
  ])) {
    await add({
      category,
      path,
      label: `Android Studio Cache ${basename(path)}`,
      risk: "low",
      selectedByDefault: true,
      reason: "Android Studio cache directory.",
      tags: ["android", "ide"],
    });
  }

  const buildTools = (await existingChildren(join(home, "Library/Android/sdk/build-tools")))
    .sort(compareVersionLikeDesc);
  for (const [index, child] of buildTools.entries()) {
    await add({
      category,
      path: child,
      label: `Android Build Tools ${basename(child)}`,
      risk: "medium",
      selectedByDefault: index > 1,
      reason: index <= 1 ? "Latest two build-tools versions retained by default." : "Older Android SDK build-tools.",
      tags: ["android", "sdk"],
    });
  }

  if (process.arch === "arm64") {
    for (const imagePath of await findNamedDirectories(join(home, "Library/Android/sdk/system-images"), "x86", 8, 20_000)) {
      await add({
        category,
        path: imagePath,
        label: `x86 Emulator Image ${shortenPath(imagePath, home)}`,
        risk: "medium",
        selectedByDefault: false,
        reason: "Intel emulator image on Apple Silicon.",
        tags: ["android", "sdk"],
      });
    }
  }

  const roots = await findProjectRoots(projectRoots, ["settings.gradle", "settings.gradle.kts", "build.gradle", "build.gradle.kts"], options);
  for (const root of roots) {
    for (const relative of [".gradle", "build", "app/build"]) {
      await add({
        category,
        path: join(root, relative),
        label: `Gradle ${relative} ${basename(root)}`,
        detail: root,
        risk: "medium",
        selectedByDefault: relative !== "build",
        reason: "Project-local Gradle build output.",
        tags: ["android", "project"],
      });
    }
  }
}

async function scanFlutter(
  home: string,
  projectRoots: string[],
  category: CategoryDef,
  add: (input: AddItemInput) => Promise<void>,
  options: ScanOptions,
) {
  for (const target of [
    ["Pub Cache", join(home, ".pub-cache"), "medium", false, "Global Dart and Flutter package cache."],
    ["FVM SDK Cache", join(home, "fvm/versions"), "medium", false, "FVM-managed Flutter SDK versions."],
  ] as const) {
    await add({
      category,
      label: target[0],
      path: target[1],
      risk: target[2],
      selectedByDefault: target[3],
      reason: target[4],
      tags: ["flutter", "cache"],
    });
  }

  const roots = await findProjectRoots(projectRoots, ["pubspec.yaml"], options);
  for (const root of roots) {
    for (const target of [
      ["build", "low", true, "Flutter build output."],
      [".dart_tool", "low", true, "Dart tool cache."],
      [".packages", "medium", false, "Legacy generated package map."],
      ["pubspec.lock", "high", false, "Lockfile can be intentional source state."],
      [".fvm", "medium", false, "Project-local FVM SDK cache and config."],
      [".fvmrc", "high", false, "FVM version pin file."],
      ["android/.gradle", "low", true, "Flutter Android Gradle cache."],
      ["android/build", "low", true, "Flutter Android build output."],
      ["android/app/build", "low", true, "Flutter Android app build output."],
      ["ios/.symlinks", "low", true, "Flutter iOS generated symlinks."],
      ["ios/Flutter/Flutter.framework", "low", true, "Generated Flutter iOS framework."],
      ["ios/Flutter/Flutter.podspec", "low", true, "Generated Flutter iOS podspec."],
      ["ios/Pods", "medium", false, "Project CocoaPods dependencies."],
      ["ios/Podfile.lock", "high", false, "CocoaPods lockfile."],
    ] as const) {
      await add({
        category,
        path: join(root, target[0]),
        label: `Flutter ${target[0]} ${basename(root)}`,
        detail: root,
        risk: target[1],
        selectedByDefault: target[2],
        reason: target[3],
        tags: ["flutter", "project"],
      });
    }
  }
}

async function scanNode(
  home: string,
  projectRoots: string[],
  category: CategoryDef,
  add: (input: AddItemInput) => Promise<void>,
  options: ScanOptions,
) {
  for (const target of [
    ["npm Cache", join(home, ".npm/_cacache"), "low", true, "npm package tarball cache."],
    ["Bun Install Cache", join(home, ".bun/install/cache"), "low", true, "Bun package cache."],
    ["Yarn Cache", join(home, "Library/Caches/Yarn"), "low", true, "Yarn package cache."],
    ["pnpm Store", join(home, "Library/pnpm/store"), "medium", false, "pnpm global content-addressed store."],
    ["pnpm Store", join(home, ".pnpm-store"), "medium", false, "pnpm global content-addressed store."],
  ] as const) {
    await add({
      category,
      label: target[0],
      path: target[1],
      risk: target[2],
      selectedByDefault: target[3],
      reason: target[4],
      tags: ["node", "cache"],
    });
  }

  const targetPaths = await findTargetPaths(projectRoots, NODE_TARGETS, options);
  for (const targetPath of targetPaths) {
    const target = basename(targetPath);
    const parent = dirname(targetPath);
    const metadata = await targetMetadata(targetPath, home);
    const profile = nodeTargetProfile(target, targetPath, home);
    await add({
      category,
      path: targetPath,
      label: `${target} ${basename(parent)}`,
      detail: `${shortenPath(parent, home)}${metadata ? ` · ${metadata}` : ""}`,
      risk: profile.risk,
      selectedByDefault: profile.selectedByDefault,
      reason: profile.reason,
      tags: ["node", "project"],
    });
  }
}

function nodeTargetProfile(target: string, targetPath: string, home: string): { risk: ItemRisk; selectedByDefault: boolean; reason: string } {
  if (target === "node_modules") {
    return {
      risk: "high",
      selectedByDefault: false,
      reason: "Project dependencies can be reinstalled, but deleting them disrupts active work.",
    };
  }

  if (dirname(targetPath) === home && target.startsWith(".") && target !== ".pnpm-store") {
    return {
      risk: "medium",
      selectedByDefault: false,
      reason: "Top-level hidden home cache or tool state. Review before deleting.",
    };
  }

  if (["build", "dist", "out", "public"].includes(target)) {
    return {
      risk: "medium",
      selectedByDefault: false,
      reason: "Generated output in many projects, but the name is generic enough to review first.",
    };
  }

  if ([".pnpm-store", ".vercel", ".netlify", ".now", ".expo", ".expo-shared", ".yarn"].includes(target)) {
    return {
      risk: "medium",
      selectedByDefault: false,
      reason: "Tool metadata/cache that may contain useful local project state.",
    };
  }

  return {
    risk: "low",
    selectedByDefault: true,
    reason: "Regeneratable JavaScript tooling cache or report output.",
  };
}

async function targetMetadata(targetPath: string, home: string): Promise<string> {
  const parent = dirname(targetPath);
  const isHomeLevel = parent === home;
  const newest = isHomeLevel
    ? await newestMtimeUnder(targetPath, new Set(), 8_000)
    : await newestMtimeUnder(parent, new Set([basename(targetPath)]), 8_000);
  if (!newest) return "";
  return `last touched ${relativeAge(newest)}`;
}

async function scanAppleTooling(
  home: string,
  projectRoots: string[],
  category: CategoryDef,
  add: (input: AddItemInput) => Promise<void>,
  options: ScanOptions,
) {
  for (const target of [
    ["CocoaPods Specs Repo", join(home, ".cocoapods/repos"), "medium", false, "Global CocoaPods specs repositories."],
    ["CocoaPods Cache", join(home, "Library/Caches/CocoaPods"), "low", true, "Global CocoaPods cache."],
  ] as const) {
    await add({
      category,
      label: target[0],
      path: target[1],
      risk: target[2],
      selectedByDefault: target[3],
      reason: target[4],
      tags: ["cocoapods", "cache"],
    });
  }

  const roots = await findProjectRoots(projectRoots, ["Podfile"], options);
  for (const root of roots) {
    for (const target of [
      ["Pods", "medium", false, "Project CocoaPods dependencies."],
      ["Podfile.lock", "high", false, "CocoaPods lockfile."],
    ] as const) {
      await add({
        category,
        path: join(root, target[0]),
        label: `CocoaPods ${target[0]} ${basename(root)}`,
        detail: root,
        risk: target[1],
        selectedByDefault: target[2],
        reason: target[3],
        tags: ["cocoapods", "project"],
      });
    }
  }
}

async function scanIde(home: string, category: CategoryDef, add: (input: AddItemInput) => Promise<void>) {
  await add({
    category,
    path: join(home, "Library/Caches/JetBrains"),
    label: "JetBrains Caches",
    risk: "low",
    selectedByDefault: true,
    reason: "JetBrains IDE cache root.",
    tags: ["ide", "cache"],
  });

  for (const target of [
    ["VS Code Cache", "Library/Application Support/Code/Cache", "low", true],
    ["VS Code CachedData", "Library/Application Support/Code/CachedData", "low", true],
    ["VS Code Extension VSIX Cache", "Library/Application Support/Code/CachedExtensionVSIXs", "low", true],
    ["VS Code Workspace Storage", "Library/Application Support/Code/User/workspaceStorage", "medium", false],
    ["VS Code Insiders Cache", "Library/Application Support/Code - Insiders/Cache", "low", true],
    ["VS Code Insiders CachedData", "Library/Application Support/Code - Insiders/CachedData", "low", true],
  ] as const) {
    await add({
      category,
      label: target[0],
      path: join(home, target[1]),
      risk: target[2],
      selectedByDefault: target[3],
      reason: target[3] ? "Editor cache directory." : "May contain workspace-local editor state.",
      tags: ["ide", "cache"],
    });
  }
}

async function addArchives(home: string, category: CategoryDef, add: (input: AddItemInput) => Promise<void>) {
  const archivesRoot = join(home, "Library/Developer/Xcode/Archives");
  const dateFolders = await existingChildren(archivesRoot);
  for (const dateFolder of dateFolders) {
    for (const archive of await existingChildren(dateFolder)) {
      if (!archive.endsWith(".xcarchive")) continue;
      await add({
        category,
        path: archive,
        label: `Archive ${basename(archive).replace(/\.xcarchive$/, "")}`,
        detail: basename(dateFolder),
        risk: "high",
        selectedByDefault: false,
        reason: "Archives can be needed for crash symbolication or distribution records.",
        tags: ["xcode", "archive"],
      });
    }
  }
}

async function addChildren(input: {
  category: CategoryDef;
  parent: string;
  labelPrefix: string;
  excludeNames?: Set<string>;
  risk: ItemRisk;
  selectedByDefault: boolean;
  reason: string;
  tags: string[];
  add: (input: AddItemInput) => Promise<void>;
}) {
  for (const child of await existingChildren(input.parent)) {
    if (input.excludeNames?.has(basename(child))) continue;
    await input.add({
      category: input.category,
      path: child,
      label: `${input.labelPrefix} ${basename(child)}`,
      risk: input.risk,
      selectedByDefault: input.selectedByDefault,
      reason: input.reason,
      tags: input.tags,
    });
  }
}

async function createItem(input: AddItemInput, seen: Set<string>): Promise<CleanItem | undefined> {
  const path = resolve(input.path);
  let itemStat;
  try {
    itemStat = await lstat(path);
  } catch {
    return undefined;
  }

  const key = await stablePathKey(path);
  if (seen.has(key)) return undefined;
  seen.add(key);

  const size = await pathSize(path);
  if (size <= 0) return undefined;

  return {
    id: hashId(path),
    categoryId: input.category.id,
    categoryName: input.category.name,
    label: input.label,
    detail: input.detail ?? shortenPath(path, process.env.HOME ?? ""),
    path,
    size,
    kind: itemStat.isDirectory() ? "directory" : itemStat.isSymbolicLink() ? "symlink" : itemStat.isFile() ? "file" : "other",
    risk: input.risk ?? "medium",
    selectedByDefault: input.selectedByDefault ?? false,
    reason: input.reason,
    tags: input.tags ?? [],
  };
}

async function pathSize(path: string): Promise<number> {
  let total = 0;
  const stack = [path];

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current) continue;

    let currentStat;
    try {
      currentStat = await lstat(current);
    } catch {
      continue;
    }

    if (currentStat.isSymbolicLink()) {
      total += currentStat.size;
      continue;
    }

    if (!currentStat.isDirectory()) {
      total += currentStat.size;
      continue;
    }

    total += currentStat.size;
    let children: string[];
    try {
      children = await readdir(current);
    } catch {
      continue;
    }

    for (const child of children) {
      stack.push(join(current, child));
    }
  }

  return total;
}

async function existingChildren(path: string): Promise<string[]> {
  try {
    const children = await readdir(path, { withFileTypes: true });
    return children
      .filter((child) => child.name !== "." && child.name !== "..")
      .map((child) => join(path, child.name));
  } catch {
    return [];
  }
}

async function existingGrandchildren(path: string): Promise<string[]> {
  const results: string[] = [];
  for (const child of await existingChildren(path)) {
    const grandchildren = await existingChildren(child);
    if (grandchildren.length === 0) results.push(child);
    else results.push(...grandchildren);
  }
  return results;
}

async function expandHomePatterns(home: string, patterns: string[]): Promise<string[]> {
  const results: string[] = [];
  for (const pattern of patterns) {
    const starIndex = pattern.indexOf("*");
    if (starIndex === -1) {
      results.push(join(home, pattern));
      continue;
    }

    const beforeStar = pattern.slice(0, starIndex);
    const parent = join(home, beforeStar.slice(0, beforeStar.lastIndexOf("/")));
    const prefix = beforeStar.slice(beforeStar.lastIndexOf("/") + 1);
    for (const child of await existingChildren(parent)) {
      if (basename(child).startsWith(prefix)) results.push(child);
    }
  }
  return results;
}

async function findNamedDirectories(root: string, name: string, maxDepth: number, maxEntries: number): Promise<string[]> {
  return findDirectories(root, maxDepth, maxEntries, (entryName) => entryName === name);
}

async function findTargetPaths(projectRoots: string[], targets: readonly string[], options: ScanOptions): Promise<string[]> {
  const found = new Set<string>();
  const targetSet = new Set(targets);
  const maxDepth = options.maxProjectDepth ?? DEFAULT_MAX_PROJECT_DEPTH;
  const maxEntries = options.maxProjectEntries ?? DEFAULT_MAX_PROJECT_ENTRIES;

  for (const root of projectRoots) {
    if (!(await canRead(root))) continue;
    if (targetSet.has(basename(root))) found.add(root);
    await walk(root, maxDepth, maxEntries, async (current, entries) => {
      for (const entry of entries) {
        if (targetSet.has(entry.name)) found.add(join(current, entry.name));
      }
    });
  }

  return Array.from(found).sort((a, b) => a.localeCompare(b));
}

async function findProjectRoots(projectRoots: string[], markers: string[], options: ScanOptions): Promise<string[]> {
  const found = new Set<string>();
  const maxDepth = options.maxProjectDepth ?? DEFAULT_MAX_PROJECT_DEPTH;
  const maxEntries = options.maxProjectEntries ?? DEFAULT_MAX_PROJECT_ENTRIES;

  for (const root of projectRoots) {
    if (!(await canRead(root))) continue;
    await walk(root, maxDepth, maxEntries, async (current, entries) => {
      if (entries.some((entry) => markers.includes(entry.name))) {
        found.add(current);
      }
    });
  }

  return Array.from(found).sort((a, b) => a.localeCompare(b));
}

async function findDirectories(root: string, maxDepth: number, maxEntries: number, predicate: (name: string) => boolean): Promise<string[]> {
  const found: string[] = [];
  await walk(root, maxDepth, maxEntries, async (current, entries) => {
    for (const entry of entries) {
      if (entry.isDirectory() && predicate(entry.name)) found.push(join(current, entry.name));
    }
  });
  return found;
}

async function walk(
  root: string,
  maxDepth: number,
  maxEntries: number,
  visit: (current: string, entries: Dirent<string>[]) => Promise<void>,
) {
  let visited = 0;
  const stack = [{ path: root, depth: 0 }];
  const skip = new Set([
    ".git",
    ".hg",
    ".svn",
    ".Trash",
    ".Trashes",
    ".Spotlight-V100",
    ".fseventsd",
    "Applications",
    "Library",
    "node_modules",
    "Pods",
    ".npm",
    ".pnpm-store",
    ".bun",
    ".cache",
    ".config",
    ".local",
    ".nvm",
    ".rvm",
    ".rustup",
    ".pyenv",
    ".rbenv",
    ".asdf",
    ".deno",
    ".vscode",
    ".idea",
    ".vs",
    ".dart_tool",
    ".gradle",
    "build",
    "dist",
    "coverage",
    ".next",
    ".nuxt",
    ".svelte-kit",
    ".turbo",
    ".nx",
    ".parcel-cache",
  ]);

  while (stack.length > 0 && visited < maxEntries) {
    const current = stack.pop();
    if (!current || current.depth > maxDepth) continue;
    visited += 1;

    let entries: Dirent<string>[];
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }

    await visit(current.path, entries);

    for (const entry of entries) {
      if (!entry.isDirectory() || skip.has(entry.name)) continue;
      stack.push({ path: join(current.path, entry.name), depth: current.depth + 1 });
    }
  }
}

function buildCategory(category: CategoryDef, allItems: CleanItem[]): CleanCategory {
  const items = allItems
    .filter((item) => item.categoryId === category.id)
    .sort((a, b) => b.size - a.size);
  return {
    ...category,
    items,
    totalSize: sum(items.map((item) => item.size)),
    selectedSize: sum(items.filter((item) => item.selectedByDefault).map((item) => item.size)),
  };
}

function sanitizeProjectRoots(roots: string[], home: string): string[] {
  const fallback = [process.cwd()];
  const normalized = roots
    .map((root) => resolve(expandHome(root, home)))
    .filter(Boolean);
  return Array.from(new Set(normalized.length > 0 ? normalized : fallback));
}

function getEnvProjectRoots(): string[] | undefined {
  const raw = process.env.DEV_CLEANER_SCAN_ROOTS;
  if (!raw) return undefined;
  return raw.split(":").map((part) => part.trim()).filter(Boolean);
}

function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith(`~${sep}`)) return join(home, path.slice(2));
  return path;
}

async function canRead(path: string): Promise<boolean> {
  try {
    await access(path, constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

async function sortByMtimeDesc(paths: string[]): Promise<string[]> {
  const withTime = await Promise.all(paths.map(async (path) => {
    try {
      return { path, time: (await stat(path)).mtimeMs };
    } catch {
      return { path, time: 0 };
    }
  }));
  return withTime.sort((a, b) => b.time - a.time).map((entry) => entry.path);
}

async function newestMtimeUnder(root: string, extraSkip: Set<string>, maxEntries: number): Promise<number | undefined> {
  let newest: number | undefined;
  let visited = 0;
  const stack = [root];
  const skip = new Set([
    ".git",
    "node_modules",
    "Pods",
    ".dart_tool",
    ".gradle",
    "build",
    "dist",
    ".next",
    ".turbo",
    ".nx",
    ...extraSkip,
  ]);

  while (stack.length > 0 && visited < maxEntries) {
    const current = stack.pop();
    if (!current) continue;
    visited += 1;

    let entries: Dirent<string>[];
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (skip.has(entry.name)) continue;
      const path = join(current, entry.name);
      try {
        const entryStat = await lstat(path);
        newest = Math.max(newest ?? 0, entryStat.mtimeMs);
        if (entry.isDirectory() && !entry.isSymbolicLink()) stack.push(path);
      } catch {
        continue;
      }
    }
  }

  return newest;
}

function relativeAge(timestamp: number): string {
  const diffMs = Math.max(0, Date.now() - timestamp);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${Math.max(1, minutes)}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 90) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 24) return `${months}mo ago`;
  return `${Math.floor(months / 12)}y ago`;
}

function compareVersionLikeDesc(a: string, b: string): number {
  return basename(b).localeCompare(basename(a), undefined, { numeric: true, sensitivity: "base" });
}

function basename(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] ?? path;
}

function shortenPath(path: string, home: string): string {
  if (home && path.startsWith(`${home}${sep}`)) return `~/${path.slice(home.length + 1)}`;
  return path;
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

function hashId(value: string): string {
  const digest = new Bun.CryptoHasher("sha256").update(value).digest("hex");
  return digest.slice(0, 20);
}

async function stablePathKey(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch {
    return path;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function makeFixtureDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "dev-cleaner-"));
  await writeFile(join(dir, ".keep"), "");
  return dir;
}

export const categoryDefinitions = CATEGORIES;
export const categoryById = CATEGORY_BY_ID;
