import type { ToolPart } from "@opencode-ai/sdk/v2"

export type EditFile = { path: string; additions?: number; deletions?: number }
export type EditSummary = { files: EditFile[]; additions?: number; deletions?: number }

const EDIT_TOOLS = new Set(["edit", "write", "patch", "apply_patch"])
export const isEditTool = (tool: string) => EDIT_TOOLS.has(tool)

/**
 * What an edit call changed, from the tool's own completed metadata: edit reports `filediff`, apply_patch reports
 * `files[]`. Line counts appear only when the tool reported them for a completed call; a running, failed or
 * metadata-less call names its files (from the input) without counts, never zeros.
 */
export const editSummary = (part: ToolPart): EditSummary | undefined => {
  if (!isEditTool(part.tool)) return
  const state = part.state
  const done = state.status === "completed"
  const metadata = done ? state.metadata ?? {} : {}
  const reported = Array.isArray(metadata.files) ? metadata.files.flatMap(reportedFile) : []
  const single = done && metadata.filediff && typeof metadata.filediff === "object" ? reportedFile(metadata.filediff) : []
  const files = reported.length ? reported : single.length ? single : requestedFiles(state.input)
  if (!files.length) return
  const counted = files.every((file) => file.additions !== undefined && file.deletions !== undefined)
  return counted
    ? { files, additions: files.reduce((sum, file) => sum + file.additions!, 0), deletions: files.reduce((sum, file) => sum + file.deletions!, 0) }
    : { files: files.map((file) => ({ path: file.path })) }
}

const count = (value: unknown) => typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined

const reportedFile = (value: unknown): EditFile[] => {
  if (!value || typeof value !== "object") return []
  const record = value as Record<string, unknown>
  const path = [record.relativePath, record.movePath, record.filePath, record.file].find((item): item is string => typeof item === "string" && !!item)
  if (!path) return []
  const additions = count(record.additions)
  const deletions = count(record.deletions)
  return [additions !== undefined && deletions !== undefined ? { path, additions, deletions } : { path }]
}

// The input names the target before any result exists (edit/write filePath; apply_patch file headers).
const requestedFiles = (input: Record<string, unknown> | undefined): EditFile[] => {
  if (typeof input?.filePath === "string" && input.filePath) return [{ path: input.filePath }]
  const text = [input?.patchText, input?.patch].find((item): item is string => typeof item === "string")
  if (!text) return []
  const paths = [...text.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1]!.trim())
  return [...new Set(paths)].map((path) => ({ path }))
}

export const fileName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path
