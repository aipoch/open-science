/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type */

// predev hook (macOS only): rename the dev Electron.app bundle so `npm run dev` shows
// "Open Science (DEV)" in the dock and menu bar. `app.setName()` changes app.name and the per-app
// paths but NOT the macOS dock tooltip in development — that comes from the running bundle's
// Info.plist (which ships as "Electron"). Patching CFBundleName/CFBundleDisplayName fixes it.
//
// The bundle is ad-hoc/linker-signed, so a modified Info.plist invalidates the seal and the kernel
// refuses to launch it on Apple Silicon ("killed: 9"); we re-apply a deep ad-hoc signature.
//
// Idempotent (skips when already renamed) and a no-op off macOS. Reset by an electron reinstall,
// which just re-runs this on the next `npm run dev`.

const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

if (process.platform !== 'darwin') process.exit(0)

const appPath = path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'Electron.app')
const plistPath = path.join(appPath, 'Contents', 'Info.plist')

if (!fs.existsSync(plistPath)) process.exit(0)

const DEV_NAME = 'Open Science (DEV)'
const PLIST_BUDDY = '/usr/libexec/PlistBuddy'

const readKey = (key) => {
  try {
    return execFileSync(PLIST_BUDDY, ['-c', `Print :${key}`, plistPath], { encoding: 'utf8' }).trim()
  } catch {
    return ''
  }
}

// Already renamed — nothing to do (avoids a needless re-sign on every dev start).
if (readKey('CFBundleName') === DEV_NAME) process.exit(0)

const setKey = (key) => {
  try {
    execFileSync(PLIST_BUDDY, ['-c', `Set :${key} ${DEV_NAME}`, plistPath])
  } catch {
    try {
      execFileSync(PLIST_BUDDY, ['-c', `Add :${key} string ${DEV_NAME}`, plistPath])
    } catch {
      // Leave the key as-is if it can neither be set nor added.
    }
  }
}

setKey('CFBundleName')
setKey('CFBundleDisplayName')

// Re-seal so the modified bundle still launches (a broken ad-hoc signature is fatal on arm64).
try {
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', appPath], { stdio: 'ignore' })
} catch {
  // If signing is unavailable the patched bundle may fail to launch; surface a hint but don't block.
  console.warn('[dev-app-branding] could not re-sign Electron.app; dev launch may fail on arm64')
}

console.log(`[dev-app-branding] dev Electron.app renamed to "${DEV_NAME}"`)
