import { PermissionV1 } from "@opencode-ai/core/v1/permission"
import { afterAll, describe, expect, test } from "bun:test"
import fs from "fs"
import os from "os"
import path from "path"
import { Cause, Effect, Exit, Fiber, Layer } from "effect"
import { CrossSpawnSpawner } from "@opencode-ai/core/cross-spawn-spawner"
import { AppNodeBuilder } from "@opencode-ai/core/effect/app-node-builder"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { EventV2Bridge } from "../../src/event-v2-bridge"
import { Permission } from "../../src/permission"
import { InstanceBootstrap } from "../../src/project/bootstrap"
import { InstanceStore } from "../../src/project/instance-store"
import { SessionID } from "../../src/session/schema"
import { TestInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// A decoy home: the real home, config and editspaces are never touched.
const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "edit-path-")))
afterAll(() => fs.rmSync(home, { recursive: true, force: true }))
const at = (...parts: string[]) => path.join(home, ...parts)
const editspace = at("opencode", ".editspace")
const lane = path.join(editspace, "lanes", "lane-a")
const worktree = path.join(lane, "repos", "owner", "repo")
fs.mkdirSync(path.join(worktree, "packages"), { recursive: true })
fs.writeFileSync(path.join(lane, "LANE.md"), "# Lane\n")
fs.mkdirSync(at("repos", "owner", "repo"), { recursive: true })
fs.writeFileSync(at("repos", "owner", "repo", "cached.ts"), "")
fs.mkdirSync(at("elsewhere"), { recursive: true })
fs.mkdirSync(at("editspaces"), { recursive: true })
// The compatibility alias, an alias into the read-only cache, and an in-worktree link into the cache.
fs.symlinkSync(editspace, at("editspaces", "opencode"))
fs.symlinkSync(at("repos"), at("editspaces", "trap"))
fs.symlinkSync(at("repos", "owner", "repo"), path.join(worktree, "linked"))
const aliasWorktree = at("editspaces", "opencode", "lanes", "lane-a", "repos", "owner", "repo")

// Mirrors the personal config: ask by default, allow editspaces, deny the read-only repo cache.
const rules = Permission.fromConfig({
  edit: { "*": "ask", [`${home}/editspaces/*`]: "allow", [`${editspace}/*`]: "allow", [`${home}/repos/*`]: "deny" },
})

// What the edit tools ask with, evaluated the way Permission.ask evaluates it.
const decide = (root: string, file: string) => {
  const relative = path.relative(root, file)
  return Permission.evaluateEdit(relative, Permission.editTargets(root, relative), rules).action
}

describe("edit permission matches absolute rules against the edited file", () => {
  test("own lane LANE.md is allowed from the canonical and the alias worktree", () => {
    expect(decide(worktree, path.join(lane, "LANE.md"))).toBe("allow")
    expect(decide(aliasWorktree, at("editspaces", "opencode", "lanes", "lane-a", "LANE.md"))).toBe("allow")
  })

  test("a new file in the worktree, under directories that do not exist yet, is allowed", () => {
    expect(decide(worktree, path.join(worktree, "packages", "x.ts"))).toBe("allow")
    expect(decide(worktree, path.join(worktree, "new", "dir", "x.ts"))).toBe("allow")
  })

  test("the read-only repo cache is denied directly, through .. segments and through any symlink", () => {
    expect(decide(worktree, at("repos", "owner", "repo", "cached.ts"))).toBe("deny")
    expect(decide(worktree, path.join(worktree, "..", "..", "..", "..", "..", "..", "..", "repos", "owner", "repo", "x.ts"))).toBe("deny")
    expect(decide(worktree, at("editspaces", "trap", "owner", "repo", "cached.ts"))).toBe("deny")
    // The lexical path is inside an allowed editspace; only the resolved parent reveals the cache.
    expect(decide(worktree, path.join(worktree, "linked", "cached.ts"))).toBe("deny")
    expect(decide(worktree, path.join(worktree, "linked", "missing", "new.ts"))).toBe("deny")
  })

  test("a path matching no specific rule asks", () => {
    expect(decide(worktree, at("elsewhere", "x.ts"))).toBe("ask")
    expect(decide(worktree, "/etc/hosts")).toBe("ask")
  })

  test("a symlink that only lexically matches an allow rule does not allow", () => {
    // Allowed by name, resolving to a tree with no rule: ask, never allow.
    fs.symlinkSync(at("elsewhere"), path.join(editspace, "outward"))
    expect(decide(worktree, path.join(editspace, "outward", "x.ts"))).toBe("ask")
  })

  test("relative rule patterns still match the worktree-relative path", () => {
    const relativeRules = Permission.fromConfig({ edit: { "*": "ask", "src/*": "allow", "src/secret/*": "deny" } })
    const decideRelative = (file: string) =>
      Permission.evaluateEdit(file, Permission.editTargets(worktree, file), relativeRules).action
    expect(decideRelative("src/a.ts")).toBe("allow")
    expect(decideRelative("src/secret/key.ts")).toBe("deny")
    expect(decideRelative("lib/a.ts")).toBe("ask")
  })

  test("last matching rule still wins within each form", () => {
    const ordered = Permission.fromConfig({ edit: { [`${editspace}/*`]: "allow", "*": "ask" } })
    const relative = path.relative(worktree, path.join(lane, "LANE.md"))
    expect(Permission.evaluateEdit(relative, Permission.editTargets(worktree, relative), ordered).action).toBe("ask")
  })
})

describe("an Always approval never lifts a configured edit deny", () => {
  // What one "Always" reply on any edit prompt appends: edit asks with always ["*"].
  const approved = [{ permission: "edit", pattern: "*", action: "allow" as const }]
  const decideApproved = (file: string) => {
    const relative = path.relative(worktree, file)
    return Permission.editDecision(relative, Permission.editTargets(worktree, relative), rules, approved).action
  }

  test("the repo cache stays denied directly and through an alias", () => {
    expect(decideApproved(at("repos", "owner", "repo", "cached.ts"))).toBe("deny")
    expect(decideApproved(at("editspaces", "trap", "owner", "repo", "cached.ts"))).toBe("deny")
    expect(decideApproved(path.join(worktree, "linked", "cached.ts"))).toBe("deny")
    expect(decideApproved(path.join(worktree, "linked", "missing", "new.ts"))).toBe("deny")
  })

  test("an explicit deny outside home stays denied", () => {
    const withEtc = [...rules, ...Permission.fromConfig({ edit: { "/etc/*": "deny" } })]
    const relative = path.relative(worktree, "/etc/hosts")
    expect(Permission.editDecision(relative, Permission.editTargets(worktree, relative), withEtc, approved).action).toBe("deny")
  })

  test("configured allows stay allowed", () => {
    expect(decideApproved(path.join(lane, "LANE.md"))).toBe("allow")
  })

  test("an ask is still raised to allow", () => {
    expect(decideApproved(at("elsewhere", "x.ts"))).toBe("allow")
    expect(decideApproved("/etc/hosts")).toBe("allow")
  })
})

const it = testEffect(
  AppNodeBuilder.build(LayerNode.group([Permission.node, EventV2Bridge.node, CrossSpawnSpawner.node, InstanceStore.node]), [
    [InstanceStore.bootstrapNode, Layer.succeed(InstanceBootstrap.Service, InstanceBootstrap.Service.of({ run: Effect.void }))],
  ]),
)

const askEdit = (patterns: string[], ruleset: PermissionV1.Ruleset) =>
  Effect.gen(function* () {
    const permission = yield* Permission.Service
    return yield* permission
      .ask({ sessionID: SessionID.make("session_test"), permission: "edit", patterns, metadata: {}, always: ["*"], ruleset })
      .pipe(Effect.timeout("500 millis"), Effect.exit)
  })

it.instance(
  "Permission.ask applies absolute edit rules to the instance worktree's files",
  () =>
    Effect.gen(function* () {
      const instance = yield* TestInstance
      const ruleset = Permission.fromConfig({
        edit: { "*": "ask", [`${instance.directory}/*`]: "allow", [`${instance.directory}/vendor/*`]: "deny" },
      })
      expect(Exit.isSuccess(yield* askEdit(["src/a.ts"], ruleset))).toBe(true)
      const denied = yield* askEdit(["src/a.ts", "vendor/lib.ts"], ruleset)
      expect(Exit.isFailure(denied) && Cause.squash(denied.cause)).toBeInstanceOf(PermissionV1.DeniedError)

      // Reply Always to an edit prompt outside the allowed tree, then retry the denied file.
      const permission = yield* Permission.Service
      const outside = yield* permission
        .ask({ sessionID: SessionID.make("session_test"), permission: "edit", patterns: ["../outside.ts"], metadata: {}, always: ["*"], ruleset })
        .pipe(Effect.forkChild)
      const pending = yield* Effect.gen(function* () {
        while (true) {
          const items = yield* permission.list()
          if (items.length) return items[0]!
          yield* Effect.sleep("10 millis")
        }
      }).pipe(Effect.timeout("1 second"))
      yield* permission.reply({ requestID: pending.id, reply: "always" })
      yield* Fiber.join(outside)
      const still = yield* askEdit(["vendor/lib.ts"], ruleset)
      expect(Exit.isFailure(still) && Cause.squash(still.cause)).toBeInstanceOf(PermissionV1.DeniedError)
      // A move asks for source and destination; a denied destination denies the move.
      const move = yield* askEdit(["src/a.ts", "vendor/new/moved.ts"], ruleset)
      expect(Exit.isFailure(move) && Cause.squash(move.cause)).toBeInstanceOf(PermissionV1.DeniedError)
      expect(Exit.isSuccess(yield* askEdit(["../elsewhere.ts"], ruleset))).toBe(true)
    }),
  { git: true },
)
