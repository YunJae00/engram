import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const ICON_NAME = 'AppIcon'

const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }

function pruneOtherChip(context, app) {
  const arch = ARCH_NAMES[context.arch]
  if (arch !== 'x64' && arch !== 'arm64') return
  const other = arch === 'x64' ? 'arm64' : 'x64'
  const modules = join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules')
  for (const dir of [
    join(modules, '@anthropic-ai', `claude-agent-sdk-darwin-${other}`),
    join(modules, '@openai', `codex-darwin-${other}`),
  ]) {
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
      console.log(`adhoc-sign: pruned ${other} runtime ${dir}`)
    }
  }
  const own = join(modules, '@openai', `codex-darwin-${arch}`)
  if (!existsSync(own)) throw new Error(`adhoc-sign: missing ${arch} Codex runtime in the bundle`)
}

function which(tool) {
  try {
    return execFileSync('xcrun', ['--find', tool], { encoding: 'utf8' }).trim()
  } catch {
    return null
  }
}

export function writeFullIcns(appiconset, out, work) {
  const iconset = join(work, 'AppIcon.iconset')
  cpSync(appiconset, iconset, { recursive: true, filter: (file) => !file.endsWith('.json') })
  execFileSync('iconutil', ['--convert', 'icns', '--output', out, iconset], { stdio: 'pipe' })
}

function compileIcon(context, app) {
  const xcassets = join(context.packager.info.projectDir, 'build', 'Engram.xcassets')
  if (!existsSync(xcassets)) {
    console.warn('adhoc-sign: no Engram.xcassets — run scripts/gen-icon.mjs; icon stays legacy-only')
    return
  }
  if (!which('actool')) {
    console.warn('adhoc-sign: actool unavailable — icon stays legacy-only')
    return
  }
  const partial = join(mkdtempSync(join(tmpdir(), 'engram-icon-')), 'icon.plist')
  execFileSync(
    'xcrun',
    [
      'actool',
      '--compile',
      join(app, 'Contents', 'Resources'),
      '--app-icon',
      ICON_NAME,
      '--minimum-deployment-target',
      '11.0',
      '--platform',
      'macosx',
      '--output-partial-info-plist',
      partial,
      xcassets,
    ],
    { stdio: 'pipe' },
  )
  writeFullIcns(join(xcassets, `${ICON_NAME}.appiconset`), join(app, 'Contents', 'Resources', `${ICON_NAME}.icns`), dirname(partial))
  execFileSync('plutil', ['-replace', 'CFBundleIconName', '-string', ICON_NAME, join(app, 'Contents', 'Info.plist')], {
    stdio: 'pipe',
  })
  console.log(`adhoc-sign: compiled ${ICON_NAME} into Assets.car`)
}

export default async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  pruneOtherChip(context, app)
  compileIcon(context, app)
  const helper = join(app, 'Contents', 'Resources', 'bin', 'desktop', 'EngramDesktop')
  signMacTarget(helper, 'dev.engram.desktop')
  signMacTarget(app, 'dev.engram.app', true)
  if (process.env.ENGRAM_MAC_SIGN_IDENTITY) assertCertificateRequirement(helper)
  console.log(`adhoc-sign: sealed ${app}`)
}

const CERTIFICATE_REQUIREMENT = 'certificate leaf = H"d07aaaf365c495145f4e6cbac17d0fb72f140dc4"'

function assertCertificateRequirement(target) {
  const output = execFileSync('codesign', ['-d', '-r-', target], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  console.log(output.trim())
  if (!output.includes(CERTIFICATE_REQUIREMENT))
    throw new Error(`Stable signing requirement missing for ${target}`)
}

export function signMacTarget(target, identifier, deep = false) {
  const identity = process.env.ENGRAM_MAC_SIGN_IDENTITY
  const keychain = process.env.ENGRAM_MAC_SIGN_KEYCHAIN
  execFileSync('codesign', [
    '--force', ...(deep ? ['--deep'] : []), '--sign', identity || '-',
    ...(identity && keychain ? ['--keychain', keychain] : []), '--identifier', identifier,
    ...(identity ? ['--requirements', `=designated => identifier "${identifier}" and ${CERTIFICATE_REQUIREMENT}`] : []),
    target,
  ], { stdio: 'inherit' })
  execFileSync('codesign', ['--verify', ...(deep ? ['--deep'] : []), '--strict', target], { stdio: 'inherit' })
  if (identity) assertCertificateRequirement(target)
}
