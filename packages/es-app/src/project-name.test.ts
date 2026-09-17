import { expect, test } from "bun:test"
import { resolveProjectName } from "./project-name"

test("registered sidecar uses its owning editspace name", () => {
  expect(
    resolveProjectName(
      {
        projectID: "project",
        directory: "/work/editor/.editspace/lanes/ui",
        project: { worktree: "/work/editor/.editspace" },
      },
      [{ name: "editor", root: "/work/editor/.editspace" }],
    ),
  ).toBe("editor")
})

test("another registered sidecar uses metadata rather than a hardcoded repository name", () => {
  expect(
    resolveProjectName(
      {
        projectID: "project",
        directory: "/work/notes/.editspace/lanes/ui",
        project: { worktree: "/work/notes/.editspace/" },
      },
      [{ name: "personal-notes", root: "/work/notes/.editspace/" }],
    ),
  ).toBe("personal-notes")
})

test("explicit project names take precedence over registered sidecars", () => {
  expect(
    resolveProjectName(
      {
        projectID: "project",
        directory: "/work/editor/.editspace",
        project: { name: "Custom project", worktree: "/work/editor/.editspace" },
      },
      [{ name: "editor", root: "/work/editor/.editspace" }],
    ),
  ).toBe("Custom project")
})

test("ordinary repositories keep their repository basename", () => {
  expect(
    resolveProjectName(
      { projectID: "project", directory: "/work/service/subdir", project: { worktree: "/work/service" } },
      [{ name: "deployment-work", root: "/work/service" }],
    ),
  ).toBe("service")
})

test("unregistered metadata-looking directories are not renamed", () => {
  expect(
    resolveProjectName(
      {
        projectID: "project",
        directory: "/work/unknown/.editspace",
        project: { worktree: "/work/unknown/.editspace" },
      },
      [{ name: "editor", root: "/work/editor/.editspace" }],
    ),
  ).toBe(".editspace")
})

test("containing registrations do not claim a nested sidecar", () => {
  expect(
    resolveProjectName(
      { projectID: "project", directory: "/work/editor/.editspace", project: { worktree: "/work/editor/.editspace" } },
      [{ name: "editor", root: "/work/editor" }],
    ),
  ).toBe(".editspace")
})

test("sessions without project metadata retain the directory fallback", () => {
  expect(resolveProjectName({ projectID: "project", directory: "/work/service" }, [])).toBe("service")
})
