const names = (item, scenario) =>
  (item.scenarios ?? []).includes(scenario) ||
  (item.criteria ?? []).some((c) => c.id === scenario || c.cmd.split(/\s+/).includes(scenario))

export function culprits(failedScenarios, mergedItems) {
  return mergedItems
    .filter((item) => failedScenarios.some((scenario) => names(item, scenario)))
    .map((item) => item.id)
}

export function revertPlan(mergedItems, knownCulprits) {
  const reversed = [...mergedItems].reverse()
  const known = reversed.filter((item) => knownCulprits.includes(item.id))
  const rest = reversed.filter((item) => !knownCulprits.includes(item.id))
  return [...known, ...rest].map(({ id, mergeSha }) => ({ id, mergeSha }))
}
