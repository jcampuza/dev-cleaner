import type { CleanItem } from "../types";

export function compareCleanItemsBySize(left: CleanItem, right: CleanItem): number {
  return right.size - left.size || left.path.localeCompare(right.path);
}
