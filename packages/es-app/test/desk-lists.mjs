// The Front desk's lists after NAV-01/02: open items are rows in the sidebar's Needs you band; answered and older
// items, memory and sources are in the main pane's overview, shown when nothing is open.
export const needsYou = (page) => page.locator("nav.sidebar").getByRole("region", { name: "Needs you" })
export const needsRow = (page, title) => needsYou(page).locator(".nav-decision").filter({ hasText: title })
export const needsCount = (page) => needsYou(page).locator(".nav-heading-count")
export const overviewRegion = (page) => page.getByRole("region", { name: "Decisions and inbox" })
/** The overview, closing whatever is open first. */
export const overview = async (page) => {
  const close = page.locator(".desk-evidence-head, .desk-surface .desk-evidence-head").getByRole("button", { name: /^Close/ }).first()
  if (await close.isVisible().catch(() => false)) await close.click()
  return overviewRegion(page)
}
export const notices = (page) => page.locator(".desk-notices")
