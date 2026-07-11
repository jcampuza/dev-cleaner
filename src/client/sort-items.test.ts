import { expect, test } from "bun:test";
import type { CleanItem } from "../types";
import { compareCleanItemsBySize } from "./sort-items";

const item = (path: string, size: number): CleanItem => ({
  id: path,
  categoryId: "node",
  categoryName: "Node",
  label: path,
  detail: path,
  path,
  size,
  kind: "directory",
  risk: "low",
  selectedByDefault: false,
  reason: "fixture",
  tags: [],
});

test("sorts cleanable items by descending size with a stable path tiebreaker", () => {
  const sorted = [item("/z", 10), item("/b", 40), item("/a", 40)].sort(compareCleanItemsBySize);
  expect(sorted.map((entry) => entry.path)).toEqual(["/a", "/b", "/z"]);
});
