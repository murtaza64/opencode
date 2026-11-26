import { describe, expect, test } from "bun:test"
import { optionParts, parseBriefV1 } from "./brief-v1"

describe("parseBriefV1", () => {
  test("trims the three descent levels to their budgets", () => {
    const brief = parseBriefV1({ thing: `  ${"x".repeat(100)}  `, happened: "h".repeat(160), key: "k".repeat(150), ignored: "not part of v1" })
    expect(brief).toEqual({ thing: "x".repeat(80), happened: "h".repeat(120), key: "k".repeat(120) })
    expect(parseBriefV1({ thing: "  ", action: { verb: "unknown" } })).toBeUndefined()
  })

  test("drops unknown verbs and invalid action fields but preserves valid text", () => {
    expect(parseBriefV1({ thing: "Decision", action: { verb: "message", text: "do it" } })).toEqual({ thing: "Decision" })
    expect(parseBriefV1({ action: { verb: "post", to: { slack: "#pd-bee" }, text: "Question", as: 123 } })).toEqual({ action: { verb: "post", to: { slack: "#pd-bee" }, text: "Question" } })
  })

  test("requires finite metric series of at least two points and matching baseline", () => {
    expect(parseBriefV1({ metric: { series: [1, Number.POSITIVE_INFINITY] }, key: "safe" })).toEqual({ key: "safe" })
    expect(parseBriefV1({ metric: { series: [1] } })).toBeUndefined()
    expect(parseBriefV1({ metric: { series: [1, 2], limit: NaN, baseline: [1], unit: "GB" } })).toEqual({ metric: { series: [1, 2], unit: "GB" } })
    expect(parseBriefV1({ metric: { series: [1, 2], limit: 2, baseline: [1, 1] } })).toEqual({ metric: { series: [1, 2], limit: 2, baseline: [1, 1] } })
  })

  test("keeps an option's figure parts even without a consequence", () => {
    expect(parseBriefV1({ options: { keep: { shows: "series" }, pause: { consequence: "Flattens", shows: ["baseline", 3] }, empty: {} } }))
      .toEqual({ options: { keep: { shows: ["series"] }, pause: { consequence: "Flattens", shows: ["baseline"] } } })
  })
})

describe("figure library", () => {
  test("scope keeps three touches and three nevers, and needs an action and a touch", () => {
    expect(parseBriefV1({ scope: { action: "open 2 draft PRs", touches: ["a", "b", "c", "d"], never: ["deploy", "", "x", "y", "z"] } }))
      .toEqual({ scope: { action: "open 2 draft PRs", touches: ["a", "b", "c"], never: ["deploy", "x", "y"] } })
    expect(parseBriefV1({ scope: { action: "open", touches: [] } })).toBeUndefined()
  })

  test("flow keeps two to five labelled nodes, ids default to the label and unknown states are unknown", () => {
    const nodes = ["a", "b", "c", "d", "e", "f"].map(label => ({ label, state: "ok" }))
    expect(parseBriefV1({ flow: { nodes } })?.flow?.nodes.map(node => node.id)).toEqual(["a", "b", "c", "d", "e"])
    expect(parseBriefV1({ flow: { nodes: [{ id: "clean", label: "11 clean", state: "ok", note: "safe" }, { label: "3 unpushed", state: "weird" }] } }))
      .toEqual({ flow: { nodes: [{ id: "clean", label: "11 clean", state: "ok", note: "safe" }, { id: "3 unpushed", label: "3 unpushed", state: "unknown" }] } })
    expect(parseBriefV1({ flow: { nodes: [{ label: "only" }] } })).toBeUndefined()
  })

  test("secure needs a destination", () => {
    expect(parseBriefV1({ secure: { dest: "Doppler · api-tests", note: "sealed" } })).toEqual({ secure: { dest: "Doppler · api-tests", note: "sealed" } })
    expect(parseBriefV1({ secure: { note: "no destination" } })).toBeUndefined()
  })
})

describe("optionParts", () => {
  test("the option that takes a secret owns the sealed field; the recommendation owns a scope", () => {
    expect(optionParts({ secure: { dest: "Doppler" } }, [{ id: "save", input: { kind: "secret" } }, { id: "dry" }], "dry")).toEqual({ save: ["secure"], dry: [] })
    expect(optionParts({ scope: { action: "open", touches: ["CI"] } }, [{ id: "publish" }, { id: "hold" }], "publish")).toEqual({ publish: ["scope"], hold: [] })
  })

  const options = [{ id: "draft" }, { id: "hold" }]

  test("the recommended option is the drawn action unless the brief maps parts", () => {
    expect(optionParts({ action: { verb: "post" } }, options, "draft")).toEqual({ draft: ["action"], hold: [] })
    expect(optionParts({ action: { verb: "post" }, options: { hold: { shows: ["action"] } } }, options, "draft")).toEqual({ draft: ["action"], hold: ["action"] })
  })

  test("metric lines belong to an option only when the brief says so", () => {
    const metric = { series: [1, 2], baseline: [1, 1] }
    expect(optionParts({ metric }, options, "draft")).toEqual({ draft: [], hold: [] })
    expect(optionParts({ metric, options: { draft: { shows: ["baseline"] }, hold: { shows: ["series"] } } }, options, "draft")).toEqual({ draft: ["baseline"], hold: ["series"] })
  })

  test("a grant's once and always options are both the drawn action", () => {
    expect(optionParts({ action: { verb: "grant" } }, [{ id: "once" }, { id: "always" }, { id: "no" }], "once")).toEqual({ once: ["action"], always: ["action"], no: [] })
  })
})
