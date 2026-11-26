import { expect, test } from "bun:test"
import { glassesPage, pickDecision, pickGlassesDevice } from "./glasses-policy"

const origin = "http://127.0.0.1:47121"
const glasses = `${origin}/glasses`

test("glasses page matches only the exact route on this origin", () => {
  expect(glassesPage(`${glasses}?x=1`, origin)).toBe(true)
  expect(glassesPage(`${origin}/`, origin)).toBe(false)
  expect(glassesPage(undefined, origin)).toBe(false)
})

test("device pick returns the requested temple or nothing", () => {
  const devices = [{ deviceId: "l", deviceName: "Even G2_32_L_2A98F5" }, { deviceId: "r", deviceName: "Even G2_32_R_488558" }]
  expect(pickGlassesDevice("R", devices)).toBe("r")
  expect(pickGlassesDevice("L", devices)).toBe("l")
  expect(pickGlassesDevice("R", [devices[0]])).toBeUndefined()
  expect(pickGlassesDevice("", devices)).toBeUndefined()
})

const temples = [{ deviceId: "l", deviceName: "Even G2_32_L_2A98F5" }, { deviceId: "r", deviceName: "Even G2_32_R_488558" }]

test("a pick right after a same-document route change to /glasses is allowed", () => {
  // contents.getURL() still reports the previous route; the page itself is already on /glasses.
  expect(pickDecision({ contentsURL: `${origin}/session/ses_1`, pageHref: glasses, side: "R", devices: temples, origin })).toEqual({ kind: "pick", deviceId: "r" })
})

test("a pick is refused when the page is not on /glasses or the origin is foreign", () => {
  expect(pickDecision({ contentsURL: glasses, pageHref: `${origin}/desk`, side: "R", devices: temples, origin }).kind).toBe("refuse")
  expect(pickDecision({ contentsURL: "http://127.0.0.1:9/glasses", pageHref: glasses, side: "R", devices: temples, origin }).kind).toBe("refuse")
  expect(pickDecision({ contentsURL: glasses, pageHref: "http://127.0.0.1:9/glasses", side: "R", devices: temples, origin }).kind).toBe("refuse")
  expect(pickDecision({ contentsURL: glasses, pageHref: undefined, side: "R", devices: temples, origin }).kind).toBe("refuse")
})

test("a pick waits while the requested temple has not been discovered", () => {
  expect(pickDecision({ contentsURL: glasses, pageHref: glasses, side: "L", devices: [temples[1]!], origin }).kind).toBe("wait")
  expect(pickDecision({ contentsURL: glasses, pageHref: glasses, side: "", devices: temples, origin }).kind).toBe("wait")
})
