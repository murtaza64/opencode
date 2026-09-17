export const resolveProjectName = (
  session: { project?: { name?: string; worktree: string } | null; directory: string; projectID: string },
  editspaces: readonly { name: string; root: string }[],
) => {
  if (session.project?.name) return session.project.name
  const worktree = session.project?.worktree.replace(/\/+$/, "")
  // Registration must match the sidecar itself, not merely a containing directory.
  const owner = worktree?.endsWith("/.editspace")
    ? editspaces.find((entry) => entry.root.replace(/\/+$/, "") === worktree)
    : undefined
  return (
    owner?.name ||
    worktree?.split("/").filter(Boolean).at(-1) ||
    session.directory.split("/").filter(Boolean).at(-1) ||
    session.projectID
  )
}
