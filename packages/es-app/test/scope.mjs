// The Agents tab's project scope chip (replaces the old top-bar select): open it and choose a project, or "__all__".
// From another tab it switches to Agents, chooses, and returns to that tab.
export const selectScope = async (page, value) => {
  const tabs = page.locator("nav.sidebar [role=tablist] [role=tab]")
  const previous = await tabs.count() ? await page.locator("nav.sidebar [role=tab][aria-selected=true]").getAttribute("id") : null
  if (previous && previous !== "nav-tab-agents") await page.locator("#nav-tab-agents").click()
  const menu = page.locator(".scope-menu").first()
  if (!(await menu.evaluate((element) => element.open))) await menu.locator("summary").click()
  await menu.locator(".scope-list button").filter({ hasText: value === "__all__" ? /^All projects$/ : new RegExp(`^${value}$`) }).click()
  if (previous && previous !== "nav-tab-agents") await page.locator(`#${previous}`).click()
}
