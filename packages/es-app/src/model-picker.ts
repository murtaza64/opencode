export type ModelChoice = { providerID: string; modelID: string }
export type ModelProvider = { id: string; name?: string; models?: Record<string, {
  name?: string
  release_date?: string
  capabilities?: { input?: { image?: boolean } }
}> }

export const modelKey = (model?: ModelChoice | null) => model ? `${model.providerID}\u0000${model.modelID}` : ""

export const modelCatalog = (providers: ModelProvider[], selected?: ModelChoice | null) => {
  const models = providers.flatMap((provider) => Object.entries(provider.models ?? {}).map(([id, model]) => ({
    key: modelKey({ providerID: provider.id, modelID: id }), providerID: provider.id, modelID: id,
    providerName: provider.name || provider.id, name: model.name || id, image: model.capabilities?.input?.image,
    release: model.release_date ?? "", quick: false, unavailable: false,
  })))
  // Preserve an explicit selection even when a refreshed catalog no longer offers it.
  if (selected && !models.some((model) => model.key === modelKey(selected))) models.push({
    ...selected, key: modelKey(selected), providerName: selected.providerID, name: selected.modelID,
    image: undefined, release: "", quick: false, unavailable: true,
  })
  const router = models.filter((model) => model.providerID === "openrouter" && !model.unavailable)
    .filter((model) => !model.modelID.startsWith("~"))
    .sort((a, b) => b.release.localeCompare(a.release) || a.modelID.length - b.modelID.length || b.modelID.localeCompare(a.modelID, undefined, { numeric: true }))
  const quick = new Set([
    router.find((model) => model.modelID === "openrouter/auto")?.key,
    router.find((model) => /(?:^|[-/])sol(?:$|[-:])/.test(model.modelID))?.key,
    router.find((model) => /(?:^|[-/])opus(?:$|[-:])/.test(model.modelID))?.key,
  ])
  return models.map((model) => ({ ...model, quick: quick.has(model.key) }))
    .sort((a, b) => Number(b.key === modelKey(selected)) - Number(a.key === modelKey(selected)) ||
      Number(b.quick) - Number(a.quick) || a.name.localeCompare(b.name, undefined, { numeric: true }) || a.key.localeCompare(b.key))
}

export const modelMatches = (model: { name: string; modelID: string; providerID: string; providerName: string }, query: string) => {
  const text = `${model.name} ${model.modelID} ${model.providerID} ${model.providerName}`.toLowerCase()
  return query.toLowerCase().trim().split(/\s+/).every((word) => text.includes(word))
}
