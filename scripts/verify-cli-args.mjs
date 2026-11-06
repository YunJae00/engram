import { isAbsolute, resolve } from 'node:path'

export function parseArgs(argv, repo, cwd) {
  const at = argv.indexOf('--root')
  const rootValue = at === -1 ? null : argv[at + 1]
  if (at !== -1 && (!rootValue || rootValue.startsWith('--'))) throw new Error('--root needs a directory')
  const rest = argv.filter((_, i) => at === -1 || (i !== at && i !== at + 1))
  return {
    name: rest.find((a) => !a.startsWith('--')) ?? '',
    root: rootValue ? (isAbsolute(rootValue) ? rootValue : resolve(cwd, rootValue)) : repo,
    build: rest.includes('--build'),
    list: rest.includes('--list'),
  }
}
