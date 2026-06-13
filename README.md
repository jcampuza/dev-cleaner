# Dev Cleaner

Dev Cleaner is a Bun-first, Bun-only-ish tool for running machine disk cleanup of common development files and caches on macOS. It keeps the focused Xcode-oriented workflow from DevCleaner, then adds targeted Android, Flutter, Node, CocoaPods, Gradle, and editor cache surfaces.

The app runs a local HTTP server and serves a Bun-bundled web UI from `src/client/index.html`. No frontend framework, Vite server, or external runtime dependency is required.

## Install

Clone the repo, install dependencies, build the CLI, and link it globally:

```bash
git clone https://github.com/jcampuza/dev-cleaner.git
cd dev-cleaner
bun install
bun run build
bun link
```

`bun link` makes the `dev-cleaner` executable available globally from your shell.

## Run

```bash
dev-cleaner
```

The server binds to `127.0.0.1:3421` by default and opens the browser automatically.

Use the npkill-style full scan flag to start from the user's home folder explicitly:

```bash
dev-cleaner --full
dev-cleaner -f
```

```bash
PORT=3900 dev-cleaner --no-open
```

For local development without linking:

```bash
bun run dev
```

## Scan Scope

By default, Dev Cleaner scans from your home folder. `-f` / `--full` makes that choice explicit. Known macOS cache locations are checked directly, and project artifacts are discovered by walking the home folder for known target names.

For one-off testing or a narrower run, set scan roots with:

```bash
DEV_CLEANER_SCAN_ROOTS="$HOME/Developer:$HOME/Projects" bun run start
```

## Build

```bash
bun run build
dev-cleaner
```

The generated output in `dist/` contains the server and UI bundle.

## Test

```bash
bun run test
```

## Current Cleanup Areas

- Xcode: DerivedData, DeviceSupport, Archives, DocumentationCache, iOS Device Logs, Xcode caches, Products, old downloaded documentation.
- Simulators: CoreSimulator devices and CoreDevice caches.
- Android: Gradle caches, Android Studio caches, SDK temp files, old build-tools, Apple Silicon x86 system images, project Gradle outputs.
- Flutter: project build artifacts, Dart tool caches, Android/iOS generated artifacts, Pub cache, FVM cache.
- Node: npm, Bun, Yarn, pnpm caches, `node_modules`, pnpm stores, framework caches, bundler caches, test reports, coverage, and common generated output found under the scan scope.
- Apple Tooling: CocoaPods caches, specs repos, project `Pods`.
- Editors: VS Code and JetBrains caches.

High-risk items, lockfiles, archives, simulator device data, and dependency folders are visible but not selected by default.

## Attribution

Inspired by:

- [vashpan/xcode-dev-cleaner](https://github.com/vashpan/xcode-dev-cleaner)
- [jemishavasoya/dev-cleaner](https://github.com/jemishavasoya/dev-cleaner)
- [voidcosmos/npkill](https://github.com/voidcosmos/npkill)
