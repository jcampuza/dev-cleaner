import { render } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type {
  CleanCategory,
  CleanItem,
  DeleteResult,
  ItemRisk,
  PartialScanResult,
  ProgressEvent,
  ProjectIndexProgress,
  ScanResult,
  ScanStatus,
  ServerOperation,
} from "../types";
import "./styles.css";
import { compareCleanItemsBySize } from "./sort-items";

interface StateResponse {
  status: ScanStatus;
  scan: ScanResult | null;
  partialScan: PartialScanResult | null;
  projectRoots: string[];
  activeOperation: ServerOperation | null;
  operationId: string | null;
}

type ScopeMode = "caches" | "projects" | "home";

interface RuntimeState {
  scan: ScanResult | null;
  operation: ServerOperation | null;
  operationId: string | null;
  phase: string;
  connected: boolean;
  visited: number;
  startedAt: number | null;
  home: string;
}

const ROW_HEIGHT = 52;
const OVERSCAN = 10;
const riskOrder: ItemRisk[] = ["low", "medium", "high"];

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
};

const formatDuration = (ms: number): string => ms < 1000 ? `${Math.max(0, ms).toFixed(0)} ms` : `${(ms / 1000).toFixed(1)} s`;

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { headers: { "content-type": "application/json" }, ...options });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data as T;
}

function partialToScan(partial: PartialScanResult): ScanResult {
  return {
    summary: {
      id: partial.id,
      startedAt: partial.startedAt,
      finishedAt: "",
      durationMs: Math.max(0, Date.now() - Date.parse(partial.startedAt)),
      home: partial.home,
      projectRoots: partial.projectRoots,
      totalSize: partial.totalSize,
      selectedSize: 0,
      itemCount: partial.itemCount,
      selectedCount: 0,
    },
    categories: partial.categories,
  };
}

function scopeForRoots(roots: string[], home: string): ScopeMode {
  if (roots.length === 0) return "caches";
  if (roots.length === 1 && roots[0] === home) return "home";
  return "projects";
}

function flattenItems(scan: ScanResult | null): CleanItem[] {
  return scan?.categories.flatMap((category) => category.items) ?? [];
}

function addStreamItems(scan: ScanResult | null, incoming: CleanItem[], home: string): ScanResult {
  const current = scan ?? partialToScan({
    id: `pending-${Date.now()}`,
    startedAt: new Date().toISOString(),
    home,
    projectRoots: [],
    categories: [],
    totalSize: 0,
    itemCount: 0,
  });
  const knownIds = new Set(flattenItems(current).map((item) => item.id));
  const items = incoming.filter((item) => !knownIds.has(item.id));
  if (items.length === 0) return current;
  const categories = current.categories.map((category) => ({ ...category, items: [...category.items] }));
  let addedSize = 0;
  for (const item of items) {
    let category = categories.find((entry) => entry.id === item.categoryId);
    if (!category) {
      category = { id: item.categoryId, name: item.categoryName, description: "", accent: "#7ee787", items: [], totalSize: 0, selectedSize: 0 };
      categories.push(category);
    }
    category.items.push(item);
    category.totalSize += item.size;
    addedSize += item.size;
  }
  return {
    summary: {
      ...current.summary,
      itemCount: current.summary.itemCount + items.length,
      totalSize: current.summary.totalSize + addedSize,
    },
    categories,
  };
}

function TerminalButton(props: preact.JSX.ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "run" | "danger" }) {
  const { tone, class: className, ...rest } = props;
  return <button class={`${className ?? ""} ${tone ? `tone-${tone}` : ""}`.trim()} type="button" {...rest} />;
}

function Stat({ label, value }: { label: string; value: string }) {
  return <span class="stat"><span class="prompt">{label}=</span><strong>{value}</strong></span>;
}

function App() {
  const [runtime, setRuntime] = useState<RuntimeState>({
    scan: null,
    operation: null,
    operationId: null,
    phase: "booting",
    connected: false,
    visited: 0,
    startedAt: null,
    home: "~",
  });
  const [scope, setScope] = useState<ScopeMode>("caches");
  const [rootsText, setRootsText] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [queryInput, setQueryInput] = useState("");
  const [query, setQuery] = useState("");
  const [risks, setRisks] = useState<Set<ItemRisk>>(new Set());
  const [categories, setCategories] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  const [viewportHeight, setViewportHeight] = useState(520);
  const [clock, setClock] = useState(Date.now());
  const [toast, setToast] = useState("");
  const listRef = useRef<HTMLDivElement>(null);
  const runtimeRef = useRef(runtime);
  const streamBufferRef = useRef<CleanItem[]>([]);
  const streamFrameRef = useRef(0);
  runtimeRef.current = runtime;

  const busy = runtime.operation !== null;
  const allItems = useMemo(() => flattenItems(runtime.scan), [runtime.scan]);
  const categoryOptions = useMemo(() => runtime.scan?.categories ?? [], [runtime.scan]);
  const selectedBytes = useMemo(() => allItems.reduce((sum, item) => selected.has(item.id) ? sum + item.size : sum, 0), [allItems, selected]);

  const visibleItems = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return allItems
      .filter((item) => risks.size === 0 || risks.has(item.risk))
      .filter((item) => categories.size === 0 || categories.has(item.categoryId))
      .filter((item) => !normalized || `${item.label} ${item.path} ${item.reason} ${item.tags.join(" ")}`.toLowerCase().includes(normalized))
      .sort(compareCleanItemsBySize);
  }, [allItems, categories, query, risks]);

  const start = Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN);
  const end = Math.min(visibleItems.length, Math.ceil((scrollTop + viewportHeight) / ROW_HEIGHT) + OVERSCAN);
  const renderedItems = visibleItems.slice(start, end);

  const showToast = (message: string) => {
    setToast(message);
    window.setTimeout(() => setToast((current) => current === message ? "" : current), 2800);
  };

  const hydrate = (data: StateResponse) => {
    const scan = data.activeOperation === "scan" && data.partialScan ? partialToScan(data.partialScan) : data.scan;
    const home = data.partialScan?.home ?? data.scan?.summary.home ?? runtimeRef.current.home;
    const roots = data.partialScan?.projectRoots ?? data.scan?.summary.projectRoots ?? data.projectRoots;
    setRuntime({
      scan,
      operation: data.activeOperation,
      operationId: data.operationId,
      phase: data.activeOperation === "scan" ? "scanning" : data.activeOperation === "delete" ? "deleting" : scan ? "scan complete" : "idle",
      connected: runtimeRef.current.connected,
      visited: data.partialScan?.index?.entriesVisited ?? runtimeRef.current.visited,
      startedAt: data.activeOperation === "scan" ? Date.parse(data.partialScan?.startedAt ?? new Date().toISOString()) : null,
      home,
    });
    const mode = scopeForRoots(roots, home);
    setScope(mode);
    setRootsText(mode === "projects" ? roots.join("\n") : "");
    setSelected(new Set());
  };

  const reconcile = async () => hydrate(await requestJson<StateResponse>("/api/state"));

  const flushStream = () => {
    streamFrameRef.current = 0;
    const items = streamBufferRef.current.splice(0);
    if (items.length > 0) setRuntime((value) => ({ ...value, scan: addStreamItems(value.scan, items, value.home) }));
  };

  useEffect(() => {
    const timer = window.setTimeout(() => setQuery(queryInput), 140);
    return () => clearTimeout(timer);
  }, [queryInput]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
    setScrollTop(0);
  }, [categories, query, risks]);

  useEffect(() => {
    const timer = window.setInterval(() => { if (runtimeRef.current.operation) setClock(Date.now()); }, 250);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    void reconcile().catch((error) => setRuntime((current) => ({ ...current, phase: `error: ${String(error)}` })));
    const events = new EventSource("/api/events");
    events.addEventListener("open", () => setRuntime((current) => ({ ...current, connected: true })));
    events.addEventListener("error", () => setRuntime((current) => ({ ...current, connected: false })));
    events.addEventListener("message", (message) => {
      try {
        const event = JSON.parse(message.data) as ProgressEvent | { type: "connected" };
        if (event.type === "connected") {
          setRuntime((current) => ({ ...current, connected: true }));
          return;
        }
        const starts = event.type === "scan-start" || event.type === "delete-start";
        const current = runtimeRef.current;
        if (!starts && event.sessionId && current.operationId && event.sessionId !== current.operationId) return;
        if (event.type === "scan-start") {
          const payload = event.payload as { home: string; projectRoots: string[]; startedAt: string };
          setSelected(new Set());
          setRuntime((value) => ({ ...value, scan: null, operation: "scan", operationId: event.sessionId ?? null, phase: "scanning", visited: 0, startedAt: Date.parse(payload.startedAt), home: payload.home }));
        } else if (event.type === "scan-index") {
          const progress = event.payload as ProjectIndexProgress;
          setRuntime((value) => ({ ...value, visited: progress.entriesVisited, phase: `indexing ${progress.rootsComplete}/${progress.rootsTotal} roots` }));
        } else if (event.type === "scan-category") {
          setRuntime((value) => ({ ...value, phase: `scanning ${event.message.toLowerCase()}`, operationId: event.sessionId ?? value.operationId }));
        } else if (event.type === "scan-item") {
          const item = (event.payload as { item?: CleanItem })?.item;
          if (item) {
            streamBufferRef.current.push(item);
            if (!streamFrameRef.current) streamFrameRef.current = requestAnimationFrame(flushStream);
          }
        } else if (event.type === "delete-start" || event.type === "delete-item") {
          setRuntime((value) => ({ ...value, operation: "delete", operationId: event.sessionId ?? value.operationId, phase: event.message.toLowerCase() }));
        } else if (["scan-complete", "delete-complete", "error"].includes(event.type)) {
          setRuntime((value) => ({ ...value, phase: event.type === "error" ? `error: ${event.message}` : event.message.toLowerCase() }));
          window.setTimeout(() => { void reconcile(); }, 50);
        }
      } catch { /* EventSource reconnects automatically. */ }
    });
    return () => {
      events.close();
      if (streamFrameRef.current) cancelAnimationFrame(streamFrameRef.current);
    };
  }, []);

  const rootsPayload = (): string[] | null => {
    if (scope === "caches") return [];
    if (scope === "home") return [runtime.home];
    const roots = rootsText.split(/[\n,]/).map((value) => value.trim()).filter(Boolean);
    if (roots.length === 0) { showToast("enter at least one project folder"); return null; }
    return roots;
  };

  const runScan = async () => {
    const projectRoots = rootsPayload();
    if (projectRoots === null) return;
    setSelected(new Set());
    setRuntime((current) => ({ ...current, scan: null, operation: "scan", phase: "starting scan", visited: 0, startedAt: Date.now() }));
    try {
      const scan = await requestJson<ScanResult>("/api/scan", { method: "POST", body: JSON.stringify({ projectRoots }) });
      setRuntime((current) => ({ ...current, scan, phase: "scan complete" }));
      showToast(`${scan.summary.itemCount} items / ${formatBytes(scan.summary.totalSize)}`);
    } catch (error) {
      showToast(String(error));
    } finally {
      await reconcile().catch(() => undefined);
    }
  };

  const deleteSelected = async () => {
    if (selected.size === 0 || !confirm(`Delete ${selected.size} selected item(s)? This removes files from disk.`)) return;
    setRuntime((current) => ({ ...current, operation: "delete", phase: "deleting selected items" }));
    try {
      const result = await requestJson<DeleteResult & { scan?: ScanResult }>("/api/delete", { method: "POST", body: JSON.stringify({ ids: [...selected] }) });
      if (result.scan) setRuntime((current) => ({ ...current, scan: result.scan ?? current.scan }));
      setSelected(new Set());
      showToast(`freed ${formatBytes(result.freedBytes)}${result.failed.length ? ` / ${result.failed.length} failed` : ""}`);
    } catch (error) {
      showToast(String(error));
    } finally {
      await reconcile().catch(() => undefined);
    }
  };

  const toggleSet = <T,>(current: Set<T>, value: T): Set<T> => {
    const next = new Set(current);
    next.has(value) ? next.delete(value) : next.add(value);
    return next;
  };

  const totalSize = runtime.scan?.summary.totalSize ?? 0;
  const elapsed = runtime.startedAt ? clock - runtime.startedAt : runtime.scan?.summary.durationMs ?? 0;

  return <main class="terminal">
    <header class="command-bar">
      <div class="identity"><span class="sigil">$</span><span>dev-cleaner</span><span class={`connection ${runtime.connected ? "online" : "offline"}`}>{runtime.connected ? "connected" : "reconnecting"}</span></div>
      <div class="commands">
        <TerminalButton tone="run" disabled={busy} onClick={runScan}>[ run scan ]</TerminalButton>
        <TerminalButton disabled={busy || selected.size === 0} onClick={() => setSelected(new Set())}>[ clear ]</TerminalButton>
        <TerminalButton tone="danger" disabled={busy || selected.size === 0} onClick={deleteSelected}>[ delete {selected.size} ]</TerminalButton>
      </div>
    </header>

    <section class="telemetry" aria-label="Scan progress">
      <span class="phase"><span class="cursor">{busy ? "█" : ">"}</span> {runtime.phase}</span>
      <Stat label="found" value={formatBytes(totalSize)} />
      <Stat label="items" value={String(allItems.length)} />
      <Stat label="visited" value={runtime.visited ? runtime.visited.toLocaleString() : "-"} />
      <Stat label="elapsed" value={formatDuration(elapsed)} />
      <Stat label="selected" value={formatBytes(selectedBytes)} />
    </section>

    <section class="control-line" aria-label="Scan and result controls">
      <div class="control-group scope-control"><span class="prompt">scope:</span>{(["caches", "projects", "home"] as ScopeMode[]).map((mode) =>
        <label class={scope === mode ? "active" : ""}><input type="radio" name="scope" value={mode} checked={scope === mode} disabled={busy} onChange={() => setScope(mode)} />{mode}</label>)}
      </div>
      {scope === "projects" && <textarea aria-label="Project folders" value={rootsText} disabled={busy} rows={1} placeholder="/path/to/work, /path/to/code" onInput={(event) => setRootsText(event.currentTarget.value)} />}
      <label class="search"><span class="prompt">grep:</span><input type="search" value={queryInput} placeholder="path / name / reason" onInput={(event) => setQueryInput(event.currentTarget.value)} /></label>
    </section>

    <section class="filter-line">
      <span class="prompt">risk:</span>
      {riskOrder.map((risk) => <TerminalButton class={`chip ${risks.has(risk) ? "active" : ""} risk-${risk}`} aria-pressed={risks.has(risk)} onClick={() => setRisks((current) => toggleSet(current, risk))}>{risk}</TerminalButton>)}
      <span class="prompt split">type:</span>
      {categoryOptions.map((category) => <TerminalButton class={`chip ${categories.has(category.id) ? "active" : ""}`} aria-pressed={categories.has(category.id)} onClick={() => setCategories((current) => toggleSet(current, category.id))}>{category.name.toLowerCase()}</TerminalButton>)}
      {(risks.size > 0 || categories.size > 0 || queryInput) && <TerminalButton class="reset" onClick={() => { setRisks(new Set()); setCategories(new Set()); setQueryInput(""); }}>[ reset ]</TerminalButton>}
    </section>

    <section class="results-shell" aria-labelledby="results-title">
      <div class="list-head">
        <span id="results-title">SIZE-SORTED RESULTS</span>
        <span>{visibleItems.length}/{allItems.length} entries</span>
        <span class="sort">sort: size desc</span>
      </div>
      <div class="column-head"><span></span><span>size</span><span>risk</span><span>type</span><span>path / reason</span></div>
      <div class="result-list" ref={listRef} tabIndex={0} aria-label="Size-sorted cleanable items" onScroll={(event) => { setScrollTop(event.currentTarget.scrollTop); setViewportHeight(event.currentTarget.clientHeight); }}>
        {visibleItems.length === 0
          ? <div class="empty">{busy ? "scanning... results will stream here" : runtime.scan ? "no entries match" : "select a scope and run scan"}</div>
          : <div class="virtual-space" style={{ height: `${visibleItems.length * ROW_HEIGHT}px` }}>
            {renderedItems.map((item, index) => <label class="result-row" key={item.id} style={{ transform: `translateY(${(start + index) * ROW_HEIGHT}px)` }}>
              <input type="checkbox" checked={selected.has(item.id)} aria-label={`Select ${item.label}`} onChange={(event) => setSelected((current) => {
                const next = new Set(current); event.currentTarget.checked ? next.add(item.id) : next.delete(item.id); return next;
              })} />
              <strong class="size">{formatBytes(item.size)}</strong>
              <span class={`risk risk-${item.risk}`}>{item.risk}</span>
              <span class="category">{item.categoryName}</span>
              <span class="path"><strong>{item.label}</strong><code>{item.path}</code><small>{item.reason}</small></span>
            </label>)}
          </div>}
      </div>
    </section>

    <footer><span>scope_root={runtime.scan?.summary.projectRoots.length ? runtime.scan.summary.projectRoots.join(",") : "known-caches"}</span><span>no items selected by default</span></footer>
    <div class={`toast ${toast ? "show" : ""}`} role="status" aria-live="polite">{toast}</div>
  </main>;
}

const root = document.getElementById("root");
if (!root) throw new Error("Missing #root");
render(<App />, root);
