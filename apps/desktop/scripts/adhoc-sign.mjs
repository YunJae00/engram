// Ad-hoc signing invalidates TCC grants on each build; a self-signed certificate fixes the requirement.
// A Developer ID can later use the same identity-signing path (update the pinned requirement too).
// Two things the macOS bundle needs after electron-builder has assembled it,
// in this order — both edit the bundle, so the seal goes on last.
//
// 1. A COMPILED ICON. A bundle carrying only the legacy CFBundleIconFile and
//    an .icns reads to macOS as an app that never adopted the modern icon
//    pipeline, and recent releases composite such icons onto a default light
//    tile — a white frame around the artwork that redrawing the PNG cannot
//    remove, because it is not in the PNG. Every well-behaved app ships an
//    asset catalog named by CFBundleIconName instead; actool builds ours.
//
// 2. A VALID SIGNATURE. electron-builder skips macOS signing outright when
//    it finds no certificate, which leaves the bundle wearing the signature
//    Electron's own binary shipped with — a seal describing contents we just
//    repacked. macOS treats a BROKEN seal far more harshly than a missing
//    one: the app is refused as "damaged and can't be opened", which reads as
//    a corrupt download and cannot be waved past in the Finder. Ad-hoc costs
//    no certificate and makes the seal honest again; the app stays
//    unidentified, so Gatekeeper still asks, but it asks the ordinary
//    question that has an Open Anyway behind it.
//
// Release builds use the stable certificate; local builds without an identity stay ad-hoc.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ICON_NAME = 'AppIcon'

// electron-builder's Arch enum, by number — the hook receives the number.
const ARCH_NAMES = { 0: 'ia32', 1: 'x64', 2: 'armv7l', 3: 'arm64', 4: 'universal' }

// The files list ships BOTH chips' engine runtimes, because electron-builder
// strips the ${arch} macro out of files globs instead of expanding it — a
// per-arch pattern there silently matches nothing. So the arch choice is
// made here instead: drop the other chip's runtimes from the unpacked tree
// before the bundle is sealed, and each disk image keeps only its own.
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

function compileIcon(context, app) {
  const xcassets = join(context.packager.info.projectDir, 'build', 'Engram.xcassets')
  if (!existsSync(xcassets)) {
    console.warn('adhoc-sign: no Engram.xcassets — run scripts/gen-icon.mjs; icon stays legacy-only')
    return
  }
  // actool ships with Xcode, not with the command line tools alone. A machine
  // without it still gets a working build, just the legacy icon — never a
  // failed one, because this is polish and the CI runner is what ships.
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
  // The catalog is inert until the bundle names the icon inside it.
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
  // Resource executables are not reliably covered by --deep: sign the AX helper first.
  const helper = join(app, 'Contents', 'Resources', 'bin', 'desktop', 'EngramDesktop')
  signMacTarget(helper, 'dev.engram.desktop')
  signMacTarget(app, 'dev.engram.app', true)
  if (process.env.ENGRAM_MAC_SIGN_IDENTITY) assertCertificateRequirement(helper)
  console.log(`adhoc-sign: sealed ${app}`)
}

const CERTIFICATE_REQUIREMENT = 'certificate leaf = H"d07aaaf365c495145f4e6cbac17d0fb72f140dc4"'

export function assertCertificateRequirement(target) {
  const output = execFileSync('codesign', ['-d', '-r-', target], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
  // The requirement itself is on stdout; display diagnostics are on stderr.
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
