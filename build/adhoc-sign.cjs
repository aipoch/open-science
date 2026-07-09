/* eslint-disable @typescript-eslint/no-require-imports */

// electron-builder afterPack hook: apply a valid deep ad-hoc signature on macOS.
//
// Without an Apple "Developer ID Application" certificate, electron-builder skips code
// signing entirely. That leaves the bundle with only Electron's linker-level ad-hoc
// signature on the main binary and no sealed resources (`_CodeSignature`), so
// `codesign --verify` reports "code has no resources but signature indicates they must
// be present". On any *downloaded* (quarantined) copy, Gatekeeper reads that broken
// signature and refuses to launch the app with the un-bypassable "… is damaged and
// can't be opened" error — hence "installs but no window appears".
//
// A deep ad-hoc sign (`codesign --sign -`) produces a valid, self-consistent signature.
// The app still has no Developer ID, so a quarantined copy is still blocked by
// Gatekeeper — but now with the *bypassable* "unidentified developer" prompt, so
// recipients can right-click → Open (or run `xattr -dr com.apple.quarantine <app>`).
//
// This hook runs during the pack phase, before electron-builder's own (skipped) signing
// step, so the ad-hoc signature survives into the DMG/zip. If a real signing identity is
// ever configured, electron-builder's signing step overrides this ad-hoc signature.
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

/** @param {import('electron-builder').AfterPackContext} context */
exports.default = async function adhocSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  let appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  if (!fs.existsSync(appPath)) {
    const found = fs.readdirSync(context.appOutDir).find((entry) => entry.endsWith('.app'))
    if (!found) throw new Error(`[adhoc-sign] no .app bundle found in ${context.appOutDir}`)
    appPath = path.join(context.appOutDir, found)
  }

  const entitlements = path.join(__dirname, 'entitlements.mac.plist')

  // --deep signs nested frameworks, helpers and the bundled native `claude` binary.
  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', '--entitlements', entitlements, appPath],
    { stdio: 'inherit' }
  )

  console.log(`[adhoc-sign] deep ad-hoc signed ${path.basename(appPath)}`)
}
