import { expect, test } from "bun:test"
import { BRIDGE_SOURCE, NS, VERSION, injectBridge, isBridgeMessage } from "./index.js"
import pkg from "../package.json"

// A window with just enough surface for the controller to install and announce itself.
const fakeWindow = (meta) => {
  const posted = []
  const listeners = []
  const win = {
    parent: { postMessage: (message) => posted.push(message) },
    addEventListener: (type) => listeners.push(type),
    requestAnimationFrame: () => 1,
    matchMedia: () => ({ matches: false }),
    MutationObserver: class { observe() {} },
    document: { readyState: "complete", documentElement: {}, querySelector: (selector) => selector.includes("es-comments-anchors") && meta ? { getAttribute: () => meta } : null },
  }
  return { win, posted, listeners }
}

test("the serialized frame script runs on its own and announces the page policy", () => {
  const { win, posted, listeners } = fakeWindow("declared")
  // Function() sees only globals: any reference to this module's scope would throw here.
  new Function("window", BRIDGE_SOURCE)(win)
  expect(posted).toEqual([{ ns: NS, type: "ready", policy: "declared", version: 1, features: ["point", "locate"] }])
  expect(listeners).toEqual(expect.arrayContaining(["message", "click", "keydown", "pointermove", "scroll"]))
})

test("the frame script stays inert outside a frame and installs once", () => {
  const top = fakeWindow()
  top.win.parent = top.win
  new Function("window", BRIDGE_SOURCE)(top.win)
  expect(top.listeners).toEqual([])
  const framed = fakeWindow()
  new Function("window", BRIDGE_SOURCE)(framed.win)
  new Function("window", BRIDGE_SOURCE)(framed.win)
  expect(framed.posted).toHaveLength(1)
})

test("an unknown page policy reads as open", () => {
  const { win, posted } = fakeWindow("everything")
  new Function("window", BRIDGE_SOURCE)(win)
  expect(posted[0].policy).toBe("open")
})

test("the bridge is inlined first in head, else after html or doctype, once", () => {
  const tag = `<script data-es-comments>${BRIDGE_SOURCE}</script>`
  expect(injectBridge("<!doctype html><html><head><title>x</title></head></html>")).toBe(`<!doctype html><html><head>${tag}<title>x</title></head></html>`)
  expect(injectBridge("<!doctype html><html lang=en><body>x</body></html>")).toBe(`<!doctype html><html lang=en>${tag}<body>x</body></html>`)
  expect(injectBridge("<!DOCTYPE html><p>x</p>")).toBe(`<!DOCTYPE html>${tag}<p>x</p>`)
  expect(injectBridge("<p>x</p>")).toBe(`${tag}<p>x</p>`)
})

test("only this frame's namespaced messages count as bridge messages", () => {
  const frame = {}
  expect(isBridgeMessage({ source: frame, data: { ns: NS, type: "picked" } }, frame)).toBe(true)
  expect(isBridgeMessage({ source: {}, data: { ns: NS, type: "picked" } }, frame)).toBe(false)
  expect(isBridgeMessage({ source: frame, data: { ns: "other", type: "picked" } }, frame)).toBe(false)
  expect(isBridgeMessage({ source: frame, data: { ns: NS, type: "picked" } }, undefined)).toBe(false)
})

test("VERSION matches the package version", () => {
  expect(VERSION).toBe(pkg.version)
})
