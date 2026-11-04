const workstreams = {
  workbench: { name: "Workbench", glyph: "⚒", colourVar: "--teal" },
  eks: { name: "EKS", glyph: "⎈", colourVar: "--blue" },
  diff: { name: "Diff Streams", glyph: "≋", colourVar: "--mauve" },
  editspace: { name: "Editspace", glyph: "◧", colourVar: "--peach" },
  android: { name: "Android", glyph: "▯", colourVar: "--green" },
  dj: { name: "DJ", glyph: "♫", colourVar: "--yellow" },
}

export const workstreamFor = (editspace: string, lane?: string | null) => {
  const name = editspace.toLowerCase()
  const worker = lane?.toLowerCase() ?? ""
  if (name === "workbench-upgrade") return workstreams.workbench
  if (name === "project-directions" && worker.startsWith("eks-")) return workstreams.eks
  if (name === "diff-stream" || name === "diff-streams") return workstreams.diff
  if (name === "opencode" || name === "dotfiles") return workstreams.editspace
  if (name.startsWith("android-") || worker.startsWith("android-")) return workstreams.android
  if (name.startsWith("dj-") || worker.startsWith("dj-")) return workstreams.dj
  return { name: editspace, glyph: "◇", colourVar: "--blue" }
}
