export interface AppNames { name: string; aliases?: string[] }
const normalize = (value: string): string => value.trim().normalize('NFKC').toLowerCase()
const names = (app: AppNames): string[] => [app.name, ...(app.aliases ?? []).filter(value => typeof value === 'string')].map(normalize).filter(Boolean)
export function appNameMatch(app: AppNames, query: string, exact = false): boolean {
  const wanted = normalize(query)
  return !!wanted && names(app).some(name => exact ? name === wanted : name.includes(wanted))
}
export function similarApps<T extends AppNames>(apps: T[], query: string): T[] {
  const wanted = normalize(query)
  const score = (app: T): number => Math.max(0, ...names(app).map(name => {
    if (name === wanted) return 2
    if (name.includes(wanted) || wanted.includes(name)) return 1
    const letters = new Set(name)
    return [...new Set(wanted)].filter(letter => letters.has(letter)).length / Math.max(1, new Set(wanted + name).size)
  }))
  return [...apps].sort((a, b) => score(b) - score(a)).slice(0, 3)
}
