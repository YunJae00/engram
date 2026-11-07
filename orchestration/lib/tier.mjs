// Integration runs one of two tiers. `quick` (default) is the routine gate: typecheck,
// lint, the whole unit suite, a desktop build and the batch's own scenarios (~5-10 min
// locally). `full` adds every affected Electron e2e spec through `npm run verify`
// (about an hour on the Linux host when the batch reaches most specs); use it weekly or
// for a large or risky batch.
export const TIERS = ['quick', 'full']
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

// Quick runs every scenario the batch's items name plus the release smoke set; full keeps
// boot plus the smoke set, since its e2e specs already cover the changed surfaces.
export function tierScenarios(tier, itemScenarios, mergedCount) {
  const smoke = mergedCount ? SMOKE : []
  const named = tier === 'full' ? itemScenarios.filter((name) => SMOKE.includes(name)) : itemScenarios
  return [...new Set(['boot', ...named, ...smoke])]
}

// The e2e selector diffs against ENGRAM_CHECK_BASE (origin/main when unset), which on a
// long-lived next selects nearly every spec. Full integration diffs against the commit
// before the batch's first merge instead: the parent of the merge with the fewest ancestors.
export function integrationBase(counts, fallback) {
  const known = counts.filter((c) => c.sha && Number.isFinite(c.count))
  if (!known.length) return fallback
  return `${known.reduce((a, b) => (b.count < a.count ? b : a)).sha}^`
}

// Only the full tier's e2e selection needs the batch base. The quick tier runs the whole
// unit suite, and a leaked ENGRAM_CHECK_BASE reaches tests that spawn the selector in
// their own fixture repo (packages/core/test/e2e-runners.test.ts), where that SHA does
// not exist and every spec is selected.
export function integrationEnv(tier, base) {
  return tier === 'full' && base ? { ENGRAM_CHECK_BASE: base } : {}
}
