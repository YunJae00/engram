const TIERS = ['quick', 'full']
const SMOKE = ['note-open', 'cosmos', 'ui-activity-status']

export function integrationTier(roles, args = []) {
  if (args.includes('--full')) return 'full'
  if (args.includes('--quick')) return 'quick'
  const tier = roles?.integration?.tier ?? 'quick'
  if (!TIERS.includes(tier)) throw new Error(`roles.md integration.tier must be one of ${TIERS.join(', ')}, got ${tier}`)
  return tier
}

export function integrationCommands(tier) {
  return tier === 'full'
    ? [['npm', ['run', 'verify']]]
    : [['npm', ['run', 'check:quick']], ['pnpm', ['run', 'test']], ['pnpm', ['--filter', 'desktop', 'build']]]
}

export function tierScenarios(tier, itemScenarios, mergedCount) {
  const smoke = mergedCount ? SMOKE : []
  const named = tier === 'full' ? itemScenarios.filter((name) => SMOKE.includes(name)) : itemScenarios
  return [...new Set(['boot', ...named, ...smoke])]
}

export function integrationBase(counts, fallback) {
  const known = counts.filter((c) => c.sha && Number.isFinite(c.count))
  if (!known.length) return fallback
  return `${known.reduce((a, b) => (b.count < a.count ? b : a)).sha}^`
}

export function integrationEnv(tier, base) {
  return tier === 'full' && base ? { ENGRAM_CHECK_BASE: base } : {}
}
