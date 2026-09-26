/* eslint-disable @typescript-eslint/no-require-imports */

// Run after electron-builder edits and signs the main EXE and unpacked helpers, but before
// NSIS packages the app. Only supplement missing PE signatures for Microsoft Store EXE/MSI
// submissions; never re-sign the main EXE, an already-signed helper, or a vendor-signed binary.
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
exports.default = async function signWindows(context) {
  if (context.electronPlatformName !== 'win32') return
  if (!context.packager.platformSpecificBuildOptions.azureSignOptions) return
  for (const file of bundledPeFiles(context.appOutDir)) {
    if (!isUnsignedPe(file)) continue
    await context.packager.signIf(file)
    console.log(`[windows-sign] signed bundled PE: ${path.relative(context.appOutDir, file)}`)
  }
}
