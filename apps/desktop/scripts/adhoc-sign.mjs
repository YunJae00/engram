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
// 2. AN AD-HOC SIGNATURE. electron-builder skips macOS signing outright when
//    it finds no certificate, which leaves the bundle wearing the signature
//    Electron's own binary shipped with — a seal describing contents we just
//    repacked. macOS treats a BROKEN seal far more harshly than a missing
//    one: the app is refused as "damaged and can't be opened", which reads as
//    a corrupt download and cannot be waved past in the Finder. Ad-hoc costs
//    no certificate and makes the seal honest again; the app stays
//    unidentified, so Gatekeeper still asks, but it asks the ordinary
//    question that has an Open Anyway behind it.
//
// Real self-updates and a silent first launch need a paid Developer ID. This
// is everything available without one.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const ICON_NAME = 'AppIcon'

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
  compileIcon(context, app)
  // --deep so the nested helpers and the unpacked native addons (node-llama-cpp
  // loads its .node files from real paths, outside the asar) are sealed too:
  // on arm64 an unsigned Mach-O cannot be loaded at all.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  // Fail the build rather than ship another bundle whose seal does not hold.
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  console.log(`adhoc-sign: sealed ${app}`)
}
