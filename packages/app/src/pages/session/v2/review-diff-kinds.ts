import type { SnapshotFileDiff, VcsFileDiff } from "@opencode-ai/sdk/v2"
import type { FileDiffInfo } from "@opencode-ai/client/promise"
import type { Kind } from "@/components/file-tree-v2"
import { normalizeFileTreeV2Path } from "@/components/file-tree-v2-model"

export type RenderDiff = FileDiffInfo | (SnapshotFileDiff & { file: string }) | VcsFileDiff

export function normalizePath(p: string) {
  return normalizeFileTreeV2Path(p)
}

export function filterRenderableDiff(value: FileDiffInfo | SnapshotFileDiff | VcsFileDiff): value is RenderDiff {
  return typeof value.file === "string"
}

export function reviewDiffNeedsLoad(diff: RenderDiff) {
  if (diff.additions === 0 && diff.deletions === 0) return false
  return !diff.patch || !/^@@ /m.test(diff.patch)
}

/**
 * The rebuilt patch for a turn-summary row whose patch Core omitted inline (`patchOmitted`), taken from
 * `GET /session/:sessionID/diff?messageID=`. A rebuilt diff with other status or counts describes a different turn
 * range, so the row stays omitted rather than showing a patch that does not match its counts.
 */
export function turnReviewDiff(source: RenderDiff, rebuilt: readonly SnapshotFileDiff[]): RenderDiff | undefined {
  if (!("patchOmitted" in source) || source.patchOmitted !== true) return
  const hit = rebuilt.find((diff) => diff.file === source.file)
  if (!hit?.patch || hit.patchOmitted) return
  if (hit.additions !== source.additions || hit.deletions !== source.deletions || hit.status !== source.status) return
  const { patchOmitted: _, ...metadata } = source
  return { ...metadata, patch: hit.patch }
}

export function reviewRootDirectory(root: string) {
  return root === "/" || /^[A-Za-z]:[/\\]?$/.test(root) ? root : root.replace(/[/\\]+$/, "")
}

export function reviewDiffDirectory(root: string, file: string) {
  const path = normalizePath(file)
  const index = path.lastIndexOf("/")
  const separator = root.includes("\\") ? "\\" : "/"
  const base = reviewRootDirectory(root)
  if (index < 0) return base
  return `${base.endsWith(separator) ? base : base + separator}${path.slice(0, index).replaceAll("/", separator)}`
}

export function reviewDiffKinds(diffs: RenderDiff[]) {
  const merge = (a: Kind | undefined, b: Kind) => {
    if (!a) return b
    if (a === b) return a
    return "mix" as const
  }

  const out = new Map<string, Kind>()
  for (const diff of diffs) {
    const file = normalizePath(diff.file)
    const kind = diff.status === "added" ? "add" : diff.status === "deleted" ? "del" : "mix"

    out.set(file, kind)

    const parts = file.split("/")
    parts.slice(0, -1).forEach((_, idx) => {
      const dir = parts.slice(0, idx + 1).join("/")
      if (!dir) return
      out.set(dir, merge(out.get(dir), kind))
    })
  }
  return out
}

export function filterReviewFiles(files: string[], query: string) {
  const value = query.trim().toLowerCase()
  if (!value) return files
  return files.filter((file) => file.toLowerCase().includes(value))
}
