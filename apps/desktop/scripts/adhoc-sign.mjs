// electron-builder skips macOS signing outright when it finds no certificate
// (macPackager: "skipped macOS code signing"), which leaves the bundle wearing
// the signature Electron's own binary shipped with — a seal that no longer
// matches the contents we just repacked into it. macOS treats a BROKEN
// signature far more harshly than a missing one: the app is refused as
// "damaged and can't be opened", which reads as a corrupt download and cannot
// be waved past in the Finder.
//
// An ad-hoc signature costs nothing and no certificate, and makes the seal
// honest again. The app is still unidentified — Gatekeeper still asks — but it
// asks the ordinary question that right-click → Open answers, instead of
// refusing outright. Real self-updates and a silent first launch need a paid
// Developer ID; this is everything available without one.
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'

export default async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  // --deep so the nested helpers and the unpacked native addons (node-llama-cpp
  // loads its .node files from real paths, outside the asar) are sealed too:
  // on arm64 an unsigned Mach-O cannot be loaded at all.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' })
  // Fail the build rather than ship another bundle whose seal does not hold.
  execFileSync('codesign', ['--verify', '--deep', '--strict', app], { stdio: 'inherit' })
  console.log(`adhoc-sign: sealed ${app}`)
}
