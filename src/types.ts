export type ItemRisk = "low" | "medium" | "high";

export type ScanStatus = "idle" | "scanning" | "complete" | "error";

export interface CleanItem {
  id: string;
  categoryId: string;
  categoryName: string;
  label: string;
  detail: string;
  path: string;
  size: number;
  kind: "file" | "directory" | "symlink" | "other";
  risk: ItemRisk;
  selectedByDefault: boolean;
  reason: string;
  tags: string[];
}

export interface CleanCategory {
  id: string;
  name: string;
  description: string;
  accent: string;
  items: CleanItem[];
  totalSize: number;
  selectedSize: number;
}

export interface ScanSummary {
  id: string;
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  home: string;
  projectRoots: string[];
  totalSize: number;
  selectedSize: number;
  itemCount: number;
  selectedCount: number;
}

export interface ScanResult {
  summary: ScanSummary;
  categories: CleanCategory[];
}

export interface DeleteResult {
  deleted: Array<{ id: string; path: string; size: number }>;
  failed: Array<{ id: string; path: string; error: string }>;
  freedBytes: number;
}

export interface ProgressEvent {
  type: "scan-start" | "scan-category" | "scan-item" | "scan-complete" | "delete-start" | "delete-item" | "delete-complete" | "error";
  message: string;
  payload?: unknown;
}
