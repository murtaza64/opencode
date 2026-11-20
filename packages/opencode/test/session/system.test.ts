import { describe, expect, test } from "bun:test"
import { LayerNode } from "@opencode-ai/core/effect/layer-node"
import { Effect, Layer } from "effect"
import type { Agent } from "../../src/agent/agent"
import { NamedError } from "@opencode-ai/core/util/error"
import { Skill } from "../../src/skill"
import { Permission } from "../../src/permission"
import type { Provider } from "../../src/provider/provider"
import { SystemPrompt } from "../../src/session/system"
import { MCP } from "../../src/mcp"
import { testEffect } from "../lib/effect"

const skills: Skill.Info[] = [
  {
    name: "zeta-skill",
    description: "Zeta skill.",
    location: "/tmp/zeta-skill/SKILL.md",
    content: "# zeta-skill",
  },
  {
    name: "alpha-skill",
    description: "Alpha skill.",
    location: "/tmp/alpha-skill/SKILL.md",
    content: "# alpha-skill",
  },
  {
    name: "middle-skill",
    description: "Middle skill.",
    location: "/tmp/middle-skill/SKILL.md",
    content: "# middle-skill",
  },
  {
    name: "manual-skill",
    location: "/tmp/manual-skill/SKILL.md",
    content: "# manual-skill",
  },
]

const build: Agent.Info = {
  name: "build",
  mode: "primary",
  permission: Permission.fromConfig({ "*": "allow" }),
  options: {},
}

const it = testEffect(
  LayerNode.compile(SystemPrompt.node, [
    [
      MCP.node,
      Layer.mock(MCP.Service, {
        instructions: () =>
          Effect.succeed([
            {
              name: "guide-server",
              instructions: "Use lookup before mutate.",
              tools: [],
            },
            {
              name: "tool-server",
              instructions: "Prefer search before update.",
              tools: ["tool-server_search", "tool-server_update"],
            },
          ]),
      }),
    ],
    [
      Skill.node,
      Layer.succeed(
        Skill.Service,
        Skill.Service.of({
          get: (name) => Effect.succeed(skills.find((skill) => skill.name === name)),
          require: (name) => {
            const info = skills.find((skill) => skill.name === name)
            if (info) return Effect.succeed(info)
            return Effect.fail(new Skill.NotFoundError({ name, available: skills.map((skill) => skill.name) }))
          },
          all: () => Effect.succeed(skills),
          dirs: () => Effect.succeed([]),
          // The "limited" agent is denied zeta-skill; the "none" agent every skill.
          available: (agent) =>
            Effect.succeed(
              agent?.name === "none"
                ? []
                : agent?.name === "limited"
                  ? skills.filter((skill) => skill.name !== "zeta-skill")
                  : skills,
            ),
        }),
      ),
    ],
  ]),
)

describe("session.system", () => {
  test("selects the Meta prompt for Muse Spark model IDs", () => {
    for (const id of ["meta/muse-spark-preview", "muse-spark-1.1", "muse-spark-1.2"]) {
      const prompt = SystemPrompt.provider({ api: { id } } as Provider.Model)[0]
      expect(prompt).toContain("powered by Muse Spark,")
      expect(prompt).toContain("using Meta Muse Spark.")
      expect(prompt).not.toContain("{{MODEL_NAME}}")
    }
  })

  test("selects the Meta prompt for Muse Glimmer model IDs", () => {
    for (const id of ["meta/muse-glimmer", "meta/muse-glimmer-30b", "muse-glimmer-30b"]) {
      const prompt = SystemPrompt.provider({ api: { id } } as Provider.Model)[0]
      expect(prompt).toContain("powered by Muse Glimmer,")
      expect(prompt).toContain("using Meta Muse Glimmer.")
      expect(prompt).not.toContain("{{MODEL_NAME}}")
    }
  })

  test("selects the Kimi prompt for official provider model IDs", () => {
    for (const providerID of ["kimi-for-coding", "moonshotai", "moonshotai-cn"]) {
      const prompt = SystemPrompt.provider({ providerID, api: { id: "k3" } } as Provider.Model)[0]
      expect(prompt).toContain("# Prompt and Tool Use")
    }
  })

  it.effect("skills output is sorted by name and stable across calls", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const first = yield* prompt.skills(build)
      const second = yield* prompt.skills(build)
      const output = first ?? (yield* Effect.fail(new NamedError.Unknown({ message: "missing skills output" })))

      expect(first).toBe(second)

      const alpha = output.indexOf("- **alpha-skill**:")
      const middle = output.indexOf("- **middle-skill**:")
      const zeta = output.indexOf("- **zeta-skill**:")

      expect(alpha).toBeGreaterThan(-1)
      expect(middle).toBeGreaterThan(alpha)
      expect(zeta).toBeGreaterThan(middle)
      expect(output).not.toContain("manual-skill")
      // Compact list: names and descriptions only, no SKILL.md locations.
      expect(output).not.toContain("<location>")
      expect(output).not.toContain("/tmp/alpha-skill/SKILL.md")
    }),
  )

  it.effect("denied skills are listed by name only, without descriptions", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const all = yield* prompt.skills(build)
      expect(all).not.toContain("not enabled for this agent")
      const output = (yield* prompt.skills({ ...build, name: "limited" })) ?? ""
      expect(output).not.toContain("- **zeta-skill**")
      expect(output).not.toContain("Zeta skill.")
      expect(yield* prompt.skills({ ...build, name: "none" })).toBeUndefined()
      expect(output.split("\n").at(-1)).toBe(
        "Installed but not enabled for this agent (cannot be loaded; the human can enable one in config permission.skill): zeta-skill",
      )
    }),
  )

  it.effect("MCP output includes connected server instructions", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build)

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          '  <server name="tool-server">',
          "    Prefer search before update.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )

  it.effect("MCP output omits servers when all advertised tools are denied", () =>
    Effect.gen(function* () {
      const prompt = yield* SystemPrompt.Service
      const output = yield* prompt.mcp(build, Permission.fromConfig({ "tool-server_*": "deny" }))

      expect(output).toBe(
        [
          "<mcp_instructions>",
          '  <server name="guide-server">',
          "    Use lookup before mutate.",
          "  </server>",
          "</mcp_instructions>",
        ].join("\n"),
      )
    }),
  )
})
