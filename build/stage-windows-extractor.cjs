/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder CommonJS hook. */
const { createHash } = require('node:crypto')
const fs = require('node:fs/promises')
const path = require('node:path')
const { getBinFromCustomLoc } = require('app-builder-lib/out/binDownload')

// Official, unmodified standalone executables. Verify the extracted cache as well as the
// download: cached tools are mutable, and signing must never bless an unverified input.
const version = '26.04'
const url = 'https://github.com/ip7z/7zip/releases/download/26.04/7z2604-extra.7z'
const archiveDigest = 'dc4b11d3399db18b063630137145f5585d8f7ac847bf3639bd1185d7d1f7cee0'
const binaries = {
  ia32: ['7za.exe', 'abd632a86f2a3be878311a50dde3d560bc719664550d8b6a411888fbe89c3629'],
  x64: ['x64/7za.exe', '15d4c788c148e3677e2fc1c4a01f191fb6669eba4f6acf8a465f0f1a6f1e1260'],
  arm64: ['arm64/7za.exe', '88aea89faa900ea6c5f3723d5b62924328f079ae5ddcbca32248a08aeceea230']
}
const licenseDigest = '39d2187b942cc88818dd959e53c6b7dddd152097a42061467c4d56050168d646'

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type
async function verifiedFile(file, digest) {
  const stat = await fs.lstat(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error(`Invalid extractor input: ${file}`)
  const bytes = await fs.readFile(file)
  if (createHash('sha256').update(bytes).digest('hex') !== digest)
    throw new Error(`Extractor checksum mismatch: ${file}`)
  return bytes
}

// Runs in the existing afterSign hook, before NSIS compression. The extractor is embedded
// only in the installer, not installed as an application runtime or background updater.
module.exports = async (context) => {
  const arch = require('builder-util').Arch[context.arch]
  const binary = binaries[arch]
  if (context.electronPlatformName !== 'win32' || !binary)
    throw new Error(`Unsupported Windows extractor target: ${arch}`)
  const cache = await getBinFromCustomLoc('open-science-7zip', version, url, archiveDigest)
  const executable = await verifiedFile(path.join(cache, binary[0]), binary[1])
  const license = await verifiedFile(path.join(cache, 'License.txt'), licenseDigest)
  const directory = path.join(context.packager.projectDir, 'out/windows-installer', arch)
  await fs.mkdir(directory, { recursive: true })
  const tool = path.join(directory, '7za.exe')
  await fs.writeFile(tool, executable)
  // Use the same configured signing identity as the installer. Unsigned development builds
  // retain electron-builder's normal behavior; never mutate the shared downloaded binary.
  await context.packager.signIf(tool)
  const helper = path.join(directory, 'windows-install-publication.dll')
  require('./compile-windows-install-publication.cjs')(
    path.join(__dirname, 'windows-install-publication.cs'),
    helper
  )
  await context.packager.signIf(helper)
  await fs.writeFile(path.join(directory, '7zip-LICENSE.txt'), license)
  const resources = path.join(context.appOutDir, 'resources')
  await fs.mkdir(resources, { recursive: true })
  await fs.writeFile(path.join(resources, '7zip-LICENSE.txt'), license)
  await fs.writeFile(
    path.join(resources, '7zip-NOTICE.txt'),
    `7-Zip Extra ${version}, Copyright (C) 1999-2026 Igor Pavlov.\n` +
      `Used by the Windows installer. License: 7zip-LICENSE.txt.\n` +
      `Unmodified upstream binaries and source: https://github.com/ip7z/7zip/tree/${version}\n`
  )
}
