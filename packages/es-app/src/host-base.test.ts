import { expect, test } from "bun:test"
import { hostBase, hostDashboard } from "./host-base"

test("this page's own host reads through /oc and /es", () => {
  for (const host of [undefined, "", "local", "laptop"]) expect(hostBase(host, "laptop")).toBe("/oc")
  expect(hostDashboard("laptop", "laptop")).toBe("/es")
})

test("another Work host reads through the Local listener's /hosts/<id> routes", () => {
  expect(hostBase("mini", "laptop")).toBe("/hosts/mini/oc")
  expect(hostDashboard("mini", "laptop")).toBe("/hosts/mini/es")
  // On the Mini's own desktop, the laptop is the other host.
  expect(hostBase("laptop", "mini")).toBe("/hosts/laptop/oc")
})

test("an id that is not a host id never becomes a path", () => {
  for (const host of ["../oc", "Mini", "mini/x", "1mini", "a".repeat(40)]) expect(hostBase(host, "laptop")).toBeUndefined()
  expect(hostDashboard("../es", "laptop")).toBeUndefined()
})
