import { expect, test } from "bun:test"
import { allowGlassesMedia, allowGlassesMediaCheck, glassesPage, pickGlassesDevice } from "./glasses-policy"

const origin = "http://127.0.0.1:47121"
const glasses = `${origin}/glasses`

test("microphone is allowed for audio from the Glasses main frame", () => {
  expect(allowGlassesMedia("media", { isMainFrame: true, requestingUrl: glasses, mediaTypes: ["audio"] }, origin)).toBe(true)
})

test("microphone is refused on other routes of the same origin", () => {
  expect(allowGlassesMedia("media", { isMainFrame: true, requestingUrl: `${origin}/desk`, mediaTypes: ["audio"] }, origin)).toBe(false)
  expect(allowGlassesMedia("media", { isMainFrame: true, requestingUrl: `${origin}/glasses/x`, mediaTypes: ["audio"] }, origin)).toBe(false)
})

test("microphone is refused for subframes, other origins, video and empty media types", () => {
  expect(allowGlassesMedia("media", { isMainFrame: false, requestingUrl: glasses, mediaTypes: ["audio"] }, origin)).toBe(false)
  expect(allowGlassesMedia("media", { isMainFrame: true, requestingUrl: "http://127.0.0.1:9/glasses", mediaTypes: ["audio"] }, origin)).toBe(false)
  expect(allowGlassesMedia("media", { isMainFrame: true, requestingUrl: glasses, mediaTypes: ["audio", "video"] }, origin)).toBe(false)
  expect(allowGlassesMedia("media", { isMainFrame: true, requestingUrl: glasses, mediaTypes: [] }, origin)).toBe(false)
  expect(allowGlassesMedia("media", { isMainFrame: true, requestingUrl: glasses }, origin)).toBe(false)
  expect(allowGlassesMedia("geolocation", { isMainFrame: true, requestingUrl: glasses, mediaTypes: ["audio"] }, origin)).toBe(false)
})

test("permission checks follow the same frame, route and media rules", () => {
  expect(allowGlassesMediaCheck("media", { isMainFrame: true, requestingUrl: glasses, mediaType: "audio" }, origin)).toBe(true)
  expect(allowGlassesMediaCheck("media", { isMainFrame: false, requestingUrl: glasses, mediaType: "audio" }, origin)).toBe(false)
  expect(allowGlassesMediaCheck("media", { isMainFrame: true, requestingUrl: `${origin}/map`, mediaType: "audio" }, origin)).toBe(false)
  expect(allowGlassesMediaCheck("media", { isMainFrame: true, requestingUrl: glasses, mediaType: "video" }, origin)).toBe(false)
})

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
