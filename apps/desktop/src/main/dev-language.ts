import { readFileSync, realpathSync, statSync } from 'node:fs'
import { dirname, isAbsolute, relative, resolve } from 'node:path'
import ts from 'typescript'
import type { DevLanguageResult } from '../shared/developers.js'

export function devLanguage(root: string, path: string, text: string, position: number, kind: 'check' | 'complete' | 'definition'): DevLanguageResult {
  if (!/\.[cm]?[jt]sx?$/i.test(path) || text.length > 500_000 || !Number.isInteger(position) || position < 0 || position > text.length) throw new Error('Language tools support JavaScript and TypeScript files up to 500 KB.')
  const cwd = realpathSync(root), target = realpathSync(resolve(cwd, path)), libraries = dirname(ts.getDefaultLibFilePath({}))
  const inside = (base: string, file: string) => { const tail = relative(base, file); return !isAbsolute(tail) && tail !== '..' && !tail.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) }
  const safe = (file: string) => {
    try {
      const actual = realpathSync(file)
      if (!inside(cwd, actual) && !inside(libraries, actual)) return false
      if (/(^|[\\/])(?:\.git|\.env[^\\/]*|\.ssh|\.aws|\.claude|\.codex|credentials[^\\/]*)([\\/]|$)/i.test(relative(cwd, actual))) return false
      return statSync(actual).size <= 1_000_000
    } catch { return false }
  }
  if (!inside(cwd, target) || !safe(target)) throw new Error('Choose a source file inside this workspace.')
  let loaded = 0
  const read = (file: string): string | undefined => {
    if (!safe(file) || ++loaded > 1000) return undefined
    try { return readFileSync(file, 'utf8') } catch { return undefined }
  }
  const configPath = ['tsconfig.json', 'jsconfig.json'].map(name => resolve(cwd, name)).find(safe)
  const config = configPath ? ts.readConfigFile(configPath, read) : undefined
  const parsed = config && !config.error ? ts.parseJsonConfigFileContent(config.config, { useCaseSensitiveFileNames: ts.sys.useCaseSensitiveFileNames, readDirectory: () => [], fileExists: safe, readFile: read }, cwd) : undefined
  const options: ts.CompilerOptions = { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, allowJs: true, checkJs: true, ...parsed?.options, noEmit: true, plugins: [] }
  const host: ts.LanguageServiceHost = {
    getCompilationSettings: () => options, getScriptFileNames: () => [target], getScriptVersion: () => '1',
    getScriptSnapshot: file => { const content = resolve(file) === target ? text : read(file); return content === undefined ? undefined : ts.ScriptSnapshot.fromString(content) },
    getCurrentDirectory: () => cwd, getDefaultLibFileName: value => ts.getDefaultLibFilePath(value), fileExists: safe, readFile: read,
  }
  const service = ts.createLanguageService(host)
  try {
    if (kind === 'complete') return { completions: (service.getCompletionsAtPosition(target, position, { includeCompletionsForModuleExports: false })?.entries ?? []).slice(0, 100).map(entry => ({ name: entry.name, kind: entry.kind })) }
    if (kind === 'definition') return { definitions: (service.getDefinitionAtPosition(target, position) ?? []).filter(entry => inside(cwd, entry.fileName) && safe(entry.fileName)).map(entry => {
      const source = service.getProgram()?.getSourceFile(entry.fileName), at = source?.getLineAndCharacterOfPosition(entry.textSpan.start)
      return { path: relative(cwd, entry.fileName).replaceAll('\\', '/'), line: (at?.line ?? 0) + 1 }
    }).slice(0, 20) }
    return { diagnostics: [...service.getSyntacticDiagnostics(target), ...service.getSemanticDiagnostics(target)].slice(0, 100).map(value => ({ line: (value.file?.getLineAndCharacterOfPosition(value.start ?? 0).line ?? 0) + 1, message: ts.flattenDiagnosticMessageText(value.messageText, '\n'), error: value.category === ts.DiagnosticCategory.Error })) }
  } finally { service.dispose() }
}
