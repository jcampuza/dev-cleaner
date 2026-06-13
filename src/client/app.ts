interface CleanItem {
  id: string;
  label: string;
  detail: string;
  size: number;
  risk: "low" | "medium" | "high";
  reason: string;
  selectedByDefault: boolean;
}

interface CleanCategory {
  id: string;
  name: string;
  description: string;
  accent: string;
  items: CleanItem[];
  totalSize: number;
}

interface ScanResult {
  summary: {
    home: string;
    projectRoots: string[];
    totalSize: number;
    itemCount: number;
    durationMs: number;
    finishedAt: string;
  };
  categories: CleanCategory[];
}

interface AppState {
  scan: ScanResult | null;
  selected: Set<string>;
  itemsById: Map<string, CleanItem>;
  selectedBytes: number;
  categoryFilters: Set<string>;
  riskFilters: Set<CleanItem["risk"]>;
  searchQuery: string;
  busy: boolean;
}

const state: AppState = {
  scan: null,
  selected: new Set(),
  itemsById: new Map(),
  selectedBytes: 0,
  categoryFilters: new Set(),
  riskFilters: new Set(),
  searchQuery: "",
  busy: false,
};

const virtualWindows = new Map<string, string>();
let visibleCategories: CleanCategory[] = [];
let toastTimer = 0;
let virtualFrame = 0;

const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing element: ${id}`);
  return element as T;
};

const itemHeight = () => window.matchMedia("(max-width: 520px)").matches ? 88 : 72;

const formatBytes = (bytes: number): string => {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const value = bytes / 1024 ** index;
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)} ${units[index]}`;
};

const escapeHtml = (value: unknown): string => String(value).replace(/[&<>"']/g, (char) => ({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
})[char] ?? char);

const toast = (message: string) => {
  const element = byId("toast");
  element.textContent = message;
  element.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => element.classList.remove("show"), 2600);
};

const setBusy = (busy: boolean, label?: string) => {
  state.busy = busy;
  byId<HTMLButtonElement>("scan").disabled = busy;
  byId<HTMLButtonElement>("delete").disabled = busy || state.selected.size === 0;
  byId<HTMLButtonElement>("clear-selection").disabled = busy || state.selected.size === 0;
  if (label) byId("status").textContent = label;
};

async function requestJson<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    headers: { "content-type": "application/json" },
    ...options,
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || response.statusText);
  return data as T;
}

async function loadState() {
  const data = await requestJson<{ status: string; scan: ScanResult | null; projectRoots: string[] }>("/api/state");
  byId("scope-root").textContent = data.projectRoots.join(", ") || "~";
  if (data.scan) applyScan(data.scan);
}

async function scan() {
  setBusy(true, "Scanning");
  try {
    const data = await requestJson<ScanResult>("/api/scan", {
      method: "POST",
      body: JSON.stringify({}),
    });
    applyScan(data);
    toast(`Scan complete: ${formatBytes(data.summary.totalSize)} found`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    byId("status").textContent = message;
    toast(message);
  } finally {
    setBusy(false);
  }
}

async function deleteSelected() {
  const ids = Array.from(state.selected);
  if (ids.length === 0) return;
  const confirmed = confirm(`Delete ${ids.length} selected item(s)? This removes files from disk.`);
  if (!confirmed) return;
  setBusy(true, "Deleting");
  try {
    const deleted = await requestJson<{ freedBytes: number; failed: unknown[] }>("/api/delete", {
      method: "POST",
      body: JSON.stringify({ ids }),
    });
    toast(`Deleted ${formatBytes(deleted.freedBytes)}${deleted.failed.length ? `, ${deleted.failed.length} failed` : ""}`);
    await scan();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    byId("status").textContent = message;
    toast(message);
  } finally {
    setBusy(false);
  }
}

function applyScan(scanResult: ScanResult) {
  state.scan = scanResult;
  state.selected = new Set();
  state.itemsById = new Map();
  state.selectedBytes = 0;

  for (const item of scanResult.categories.flatMap((category) => category.items)) {
    state.itemsById.set(item.id, item);
    if (item.selectedByDefault) {
      state.selected.add(item.id);
      state.selectedBytes += item.size;
    }
  }

  byId("scope-root").textContent = scanResult.summary.projectRoots.join(", ") || scanResult.summary.home;
  render();
}

function hasActiveFilters(): boolean {
  return state.categoryFilters.size > 0 || state.riskFilters.size > 0 || state.searchQuery.trim().length > 0;
}

function itemMatchesSearch(item: CleanItem, query: string): boolean {
  if (!query) return true;
  const haystack = `${item.label} ${item.detail} ${item.reason}`.toLowerCase();
  return haystack.includes(query);
}

function getVisibleCategories(): CleanCategory[] {
  if (!state.scan) return [];
  const query = state.searchQuery.trim().toLowerCase();

  return state.scan.categories
    .filter((category) => state.categoryFilters.size === 0 || state.categoryFilters.has(category.id))
    .map((category) => {
      const items = category.items.filter((item) => {
        const riskMatches = state.riskFilters.size === 0 || state.riskFilters.has(item.risk);
        return riskMatches && itemMatchesSearch(item, query);
      });
      return {
        ...category,
        items,
        totalSize: items.reduce((total, item) => total + item.size, 0),
      };
    })
    .filter((category) => category.items.length > 0);
}

function filteredSummaryText(): string {
  if (!state.scan) return "No scan";
  if (!hasActiveFilters()) return `${state.scan.summary.itemCount} shown`;
  const count = visibleCategories.reduce((total, category) => total + category.items.length, 0);
  return `${count}/${state.scan.summary.itemCount} shown`;
}

function renderStats() {
  const scanResult = state.scan;
  byId("total-size").textContent = scanResult ? formatBytes(scanResult.summary.totalSize) : "0 B";
  byId("selected-size").textContent = formatBytes(state.selectedBytes);
  byId("item-count").textContent = scanResult ? String(scanResult.summary.itemCount) : "0";
  byId("duration").textContent = scanResult ? `${scanResult.summary.durationMs} ms` : "0 ms";
  byId("category-count").textContent = scanResult ? String(hasActiveFilters() ? visibleCategories.length : scanResult.categories.length) : "0";
  byId("scan-id").textContent = scanResult ? scanResult.summary.finishedAt.replace("T", " ").replace(/\.\d+Z$/, "Z") : "No scan";
  byId("filtered-count").textContent = scanResult ? filteredSummaryText() : "No scan";
  byId<HTMLButtonElement>("delete").disabled = state.busy || state.selected.size === 0;
  byId<HTMLButtonElement>("clear-selection").disabled = state.busy || state.selected.size === 0;
  byId("status").textContent = scanResult ? `${scanResult.summary.home} · ${scanResult.summary.projectRoots.join(", ")}` : "Idle";
}

function render() {
  const scanResult = state.scan;
  visibleCategories = getVisibleCategories();
  renderStats();
  virtualWindows.clear();

  if (!scanResult || scanResult.categories.length === 0) {
    byId("results").className = "empty";
    byId("results").textContent = "No cleanable files found";
    byId("category-nav").innerHTML = "";
    return;
  }

  byId("category-nav").innerHTML = scanResult.categories.map((category) => {
    const visibleCategory = visibleCategories.find((entry) => entry.id === category.id);
    const visibleCount = visibleCategory?.items.length ?? 0;
    const countLabel = hasActiveFilters() ? `${visibleCount}/${category.items.length} items` : `${category.items.length} items`;
    return `
    <button class="nav-row ${state.categoryFilters.has(category.id) ? "active" : ""}" data-category-filter="${category.id}">
      <span class="swatch" style="--mark:${category.accent}"></span>
      <span><strong>${escapeHtml(category.name)}</strong><small>${countLabel}</small></span>
      <span>${formatBytes(category.totalSize)}</span>
    </button>
  `;
  }).join("");

  document.querySelectorAll<HTMLButtonElement>("[data-risk-filter]").forEach((button) => {
    const risk = button.dataset.riskFilter as CleanItem["risk"] | undefined;
    button.classList.toggle("active", Boolean(risk && state.riskFilters.has(risk)));
  });

  const rowHeight = itemHeight();
  const results = byId("results");
  results.className = "";
  results.innerHTML = visibleCategories.length > 0 ? visibleCategories.map((category) => `
    <section class="category" id="category-${category.id}">
      <div class="category-title">
        <span class="stripe" style="--mark:${category.accent}"></span>
        <div>
          <h2>${escapeHtml(category.name)}</h2>
          <p>${escapeHtml(category.description)}</p>
        </div>
        <div class="category-actions">
          <span class="badge">${formatBytes(category.totalSize)}</span>
          <button class="icon-btn" title="Select area" data-select-category="${category.id}">✓</button>
          <button class="icon-btn" title="Clear area" data-clear-category="${category.id}">×</button>
        </div>
      </div>
      <div class="items" data-category-id="${category.id}" style="height: ${category.items.length * rowHeight}px"></div>
    </section>
  `).join("") : `<div class="empty">No cleanable files match the current filters</div>`;

  renderVirtualLists(true);
}

function renderVirtualLists(force = false) {
  if (!state.scan) return;

  const categories = new Map(visibleCategories.map((category) => [category.id, category]));
  const rowHeight = itemHeight();
  const viewportHeight = window.innerHeight;
  const overscan = 8;

  document.querySelectorAll<HTMLElement>(".items[data-category-id]").forEach((container) => {
    const categoryId = container.dataset.categoryId;
    const category = categoryId ? categories.get(categoryId) : undefined;
    if (!category) return;

    container.style.height = `${category.items.length * rowHeight}px`;

    const rect = container.getBoundingClientRect();
    const totalHeight = category.items.length * rowHeight;
    const visibleTop = Math.max(0, -rect.top);
    const visibleBottom = Math.min(totalHeight, viewportHeight - rect.top);
    const start = visibleBottom <= 0 || visibleTop >= totalHeight
      ? 0
      : Math.max(0, Math.floor(visibleTop / rowHeight) - overscan);
    const end = visibleBottom <= 0 || visibleTop >= totalHeight
      ? 0
      : Math.min(category.items.length, Math.ceil(visibleBottom / rowHeight) + overscan);
    const key = `${start}:${end}:${rowHeight}`;

    if (!force && virtualWindows.get(category.id) === key) return;
    virtualWindows.set(category.id, key);

    container.innerHTML = category.items.slice(start, end)
      .map((item, index) => renderItemRow(item, (start + index) * rowHeight))
      .join("");
  });
}

function renderItemRow(item: CleanItem, offset: number): string {
  return `
    <label class="item virtual-row" style="transform: translateY(${offset}px)">
      <input type="checkbox" data-item="${item.id}" ${state.selected.has(item.id) ? "checked" : ""} />
      <span>
        <span class="item-name">${escapeHtml(item.label)}</span>
        <small>${escapeHtml(item.detail)} · ${escapeHtml(item.reason)}</small>
      </span>
      <span class="badge ${item.risk}" title="${riskTitle(item.risk)}">${item.risk}</span>
      <span class="size">${formatBytes(item.size)}</span>
    </label>
  `;
}

function riskTitle(risk: CleanItem["risk"]): string {
  if (risk === "low") return "Usually disposable cache or report output. Preselected by default.";
  if (risk === "medium") return "Regeneratable but workflow-specific. Review before deleting.";
  return "Dependency, archive, simulator state, or lock-like data. Opt-in only.";
}

function updateSelected(item: CleanItem, selected: boolean, refreshStats = true) {
  const alreadySelected = state.selected.has(item.id);
  if (selected === alreadySelected) return;

  if (selected) {
    state.selected.add(item.id);
    state.selectedBytes += item.size;
  } else {
    state.selected.delete(item.id);
    state.selectedBytes -= item.size;
  }
  if (refreshStats) renderStats();
}

function setCategorySelection(categoryId: string, selected: boolean) {
  const category = visibleCategories.find((entry) => entry.id === categoryId)
    ?? state.scan?.categories.find((entry) => entry.id === categoryId);
  if (!category) return;
  for (const item of category.items) updateSelected(item, selected, false);
  renderStats();
  renderVirtualLists(true);
}

function clearSelection() {
  if (state.selected.size === 0) return;
  state.selected.clear();
  state.selectedBytes = 0;
  renderStats();
  renderVirtualLists(true);
  toast("Selection cleared");
}

function toggleCategoryFilter(categoryId: string) {
  if (state.categoryFilters.has(categoryId)) state.categoryFilters.delete(categoryId);
  else state.categoryFilters.add(categoryId);
  window.scrollTo({ top: 0, behavior: "smooth" });
  render();
}

function toggleRiskFilter(risk: CleanItem["risk"]) {
  if (state.riskFilters.has(risk)) state.riskFilters.delete(risk);
  else state.riskFilters.add(risk);
  window.scrollTo({ top: 0, behavior: "smooth" });
  render();
}

function clearFilters() {
  state.categoryFilters.clear();
  state.riskFilters.clear();
  state.searchQuery = "";
  byId<HTMLInputElement>("text-search").value = "";
  render();
}

function scheduleVirtualRender() {
  if (virtualFrame) return;
  virtualFrame = window.requestAnimationFrame(() => {
    virtualFrame = 0;
    renderVirtualLists();
  });
}

document.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || !target.dataset.item) return;
  const item = state.itemsById.get(target.dataset.item);
  if (!item) return;
  updateSelected(item, target.checked);
});

document.addEventListener("click", (event) => {
  const target = (event.target as Element | null)?.closest("button");
  if (!target) return;
  if (target.dataset.categoryFilter) toggleCategoryFilter(target.dataset.categoryFilter);
  if (target.dataset.riskFilter) toggleRiskFilter(target.dataset.riskFilter as CleanItem["risk"]);
  if (target.dataset.selectCategory) setCategorySelection(target.dataset.selectCategory, true);
  if (target.dataset.clearCategory) setCategorySelection(target.dataset.clearCategory, false);
});

window.addEventListener("scroll", scheduleVirtualRender, { passive: true });
window.addEventListener("resize", () => renderVirtualLists(true));

byId("scan").addEventListener("click", scan);
byId("clear-selection").addEventListener("click", clearSelection);
byId("delete").addEventListener("click", deleteSelected);
byId("clear-filters").addEventListener("click", clearFilters);
byId<HTMLInputElement>("text-search").addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement)) return;
  state.searchQuery = target.value;
  render();
});

const events = new EventSource("/api/events");
events.addEventListener("message", (event) => {
  try {
    const data = JSON.parse(event.data);
    if (data.message && ["scan-category", "delete-item"].includes(data.type)) {
      byId("status").textContent = data.message;
    }
  } catch {
    // Ignore malformed progress events.
  }
});

loadState().catch((error) => {
  byId("status").textContent = error instanceof Error ? error.message : String(error);
});
