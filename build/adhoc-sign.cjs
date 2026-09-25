/* eslint-disable @typescript-eslint/no-require-imports */

// electron-builder afterPack hook: sign loose resources before the outer application.
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
const { Buffer } = require('node:buffer')
const fs = require('node:fs')
const path = require('node:path')

// NSIS includes loose native DLLs and Node addons. electron-builder signs EXEs, but does not
// discover every PE in extraResources or sign .dll/.node files by default. Store submissions
// require every installed PE to be signed. Preserve signatures already supplied by a vendor.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function isUnsignedPe(file) {
  const fd = fs.openSync(file, 'r')
  try {
    const dos = Buffer.alloc(64)
    if (
      fs.readSync(fd, dos, 0, dos.length, 0) !== dos.length ||
      dos.toString('ascii', 0, 2) !== 'MZ'
    )
      return false
    const peOffset = dos.readUInt32LE(0x3c)
    const header = Buffer.alloc(256)
    if (fs.readSync(fd, header, 0, header.length, peOffset) !== header.length) return false
    if (header.toString('ascii', 0, 4) !== 'PE\0\0') return false
    const optional = 24
    const magic = header.readUInt16LE(optional)
    if (magic !== 0x10b && magic !== 0x20b) return false
    const directories = optional + (magic === 0x20b ? 112 : 96)
    const certificate = directories + 4 * 8
    return header.readUInt32LE(certificate) === 0 || header.readUInt32LE(certificate + 4) === 0
  } finally {
    fs.closeSync(fd)
  }
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
function* bundledPeFiles(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) yield* bundledPeFiles(file)
    else if (entry.isFile() && /\.(exe|dll|node)$/i.test(entry.name)) yield file
  }
}

/** @param {import('electron-builder').AfterPackContext} context */
exports.default = async function adhocSign(context) {
  if (context.electronPlatformName === 'win32') {
    if (!context.packager.platformSpecificBuildOptions.azureSignOptions) return
    for (const file of bundledPeFiles(context.appOutDir)) {
      if (!isUnsignedPe(file)) continue
      await context.packager.signIf(file)
      console.log(`[windows-sign] signed bundled PE: ${path.relative(context.appOutDir, file)}`)
    }
    return
  }
  if (context.electronPlatformName !== 'darwin') return

  let appPath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  if (!fs.existsSync(appPath)) {
    const found = fs.readdirSync(context.appOutDir).find((entry) => entry.endsWith('.app'))
    if (!found) throw new Error(`[adhoc-sign] no .app bundle found in ${context.appOutDir}`)
    appPath = path.join(context.appOutDir, found)
  }

  const entitlements = path.join(__dirname, 'entitlements.mac.plist')

  // Sign the bundled micromamba mach-O first (nested code must be signed before the outer bundle).
  // It ships at Contents/Resources/micromamba via electron-builder extraResources; --deep below
  // does not reach into loose files under Resources, so it needs its own explicit signing pass.
  const micromambaPath = path.join(appPath, 'Contents', 'Resources', 'micromamba')
  if (fs.existsSync(micromambaPath)) {
    execFileSync(
      'codesign',
      [
        '--force',
        '--options',
        'runtime',
        '--sign',
        '-',
        '--entitlements',
        entitlements,
        micromambaPath
      ],
      { stdio: 'inherit' }
    )
    console.log('[adhoc-sign] signed bundled micromamba')
  }

  // Loose executables in Resources are not covered by --deep's nested-code discovery.
  const credentialHelperDirectory = path.join(
    appPath,
    'Contents',
    'Resources',
    'app.asar.unpacked',
    'node_modules',
    '@aipoch',
    'credential-identity-probe-native',
    'build',
    'Release'
  )
  for (const name of ['credential_identity_probe', 'credential_key_validator']) {
    const executable = path.join(credentialHelperDirectory, name)
    if (fs.existsSync(executable)) {
      execFileSync('codesign', ['--force', '--options', 'runtime', '--sign', '-', executable], {
        stdio: 'inherit'
      })
    }
  }

  // --deep signs nested frameworks, helpers and the bundled native `claude` binary.
  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', '--entitlements', entitlements, appPath],
    { stdio: 'inherit' }
  )

  console.log(`[adhoc-sign] deep ad-hoc signed ${path.basename(appPath)}`)
}
