/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { lstat, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync } from 'node:child_process'
import { createPackArchive } from './pack-archive.mjs'
import { runtimeArchiveUrl, runtimeCdnBaseUrl } from './windows-runtime-cdn.mjs'

const sha256 = async (path) => {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function inventoryRuntimeFiles(root) {
  const files = {}
  const visit = async (directory, relative = '') => {
    const info = await lstat(directory)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error('Runtime contains a linked directory.')
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name, 'en')
    )) {
      const path = relative ? `${relative}/${entry.name}` : entry.name
      const absolute = join(directory, entry.name)
      if (entry.isDirectory()) await visit(absolute, path)
      else if (entry.isFile()) files[path] = await sha256(absolute)
      else throw new Error(`Runtime contains an unsupported entry: ${path}`)
    }
  }
  await visit(root)
  return files
}

export async function stageWindowsNotebookComponents(root, output) {
  if (process.platform !== 'win32') throw new Error('Stage and verify signatures on Windows.')
  runtimeCdnBaseUrl()
  const marker = JSON.parse(
    (await readFile(join(root, 'build.json'), 'utf8')).replace(/^\uFEFF/, '')
  )
  const source = JSON.parse(
    await readFile(
      new URL(
        '../packages/notebook-network-sandbox/vendor/windows-runtime/sources.json',
        import.meta.url
      ),
      'utf8'
    )
  )
  const repairs = [
    'libuv-f46e4246b5277fe1c5888b88b24d8b78020dd4f8',
    'node-appcontainer-package-scope-v1',
    'powershell-appcontainer-v1',
    'powershell-source-archive-metadata-v1',
    'npm-appcontainer-shared-prefix-v1'
  ]
  if (
    marker.node !== source.node.version ||
    marker.powershell !== source.powershell.version ||
    marker.powershellSourceCommit !== source.powershell.commit ||
    !Array.isArray(marker.patches) ||
    !repairs.every((repair) => marker.patches.includes(repair))
  ) {
    throw new Error('Runtime sources or required repairs do not match this checkout.')
  }
  const verify = `
    $ErrorActionPreference = 'Stop'
    $env:PSModulePath = Join-Path $PSHOME 'Modules'
    Import-Module (Join-Path $PSHOME 'Modules/Microsoft.PowerShell.Security/Microsoft.PowerShell.Security.psd1') -ErrorAction Stop
    function Test-PortableExecutable([string]$path) {
      $stream = [IO.File]::OpenRead($path)
      try {
        if ($stream.Length -lt 64) { return $false }
        $reader = [IO.BinaryReader]::new($stream)
        if ($reader.ReadUInt16() -ne 0x5a4d) { return $false }
        $stream.Position = 0x3c
        $offset = $reader.ReadUInt32()
        if ($offset -gt $stream.Length - 4) { return $false }
        $stream.Position = $offset
        return $reader.ReadUInt32() -eq 0x4550
      } finally { $stream.Dispose() }
    }
    $files = Get-ChildItem -LiteralPath $env:OPEN_SCIENCE_STAGE_RUNTIME -File -Recurse |
      Where-Object { Test-PortableExecutable $_.FullName }
    if ($files.Count -eq 0) { throw 'No runtime binaries found.' }
    foreach ($file in $files) {
      $signature = Get-AuthenticodeSignature -LiteralPath $file.FullName
      if ($signature.Status -ne 'Valid' -or !$signature.TimeStamperCertificate) {
        throw ('Runtime signature/timestamp verification failed: ' + $file.Name)
      }
    }
    Write-Output ('Verified signed runtime files: ' + $files.Count)
  `
  const powershell = join(
    process.env.SystemRoot ?? 'C:\\Windows',
    'System32/WindowsPowerShell/v1.0/powershell.exe'
  )
  execFileSync(
    powershell,
    [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      Buffer.from(verify, 'utf16le').toString('base64')
    ],
    {
      env: { ...process.env, OPEN_SCIENCE_STAGE_RUNTIME: resolve(root) },
      windowsHide: true,
      stdio: 'inherit',
      timeout: 300_000
    }
  )
  await mkdir(output, { recursive: true })
  const releases = []
  for (const component of ['node', 'powershell']) {
    const directory = join(root, component)
    const files = await inventoryRuntimeFiles(directory)
    const filename = `${component}.tar.zst`
    const archivePath = join(output, filename)
    await createPackArchive(directory, archivePath)
    const digest = await sha256(archivePath)
    releases.push({
      component,
      version: marker[component],
      architecture: 'x64',
      source: 'patched',
      archive: {
        url: runtimeArchiveUrl(component, 'x64', digest),
        sha256: digest,
        size: (await stat(archivePath)).size
      },
      files
    })
    console.log(`${component}: ${releases.at(-1).archive.size} bytes, sha256 ${digest}`)
  }
  await writeFile(
    join(output, 'catalog.json'),
    JSON.stringify({ schema: 1, releases }, null, 2) + '\n'
  )
  console.log('Candidate catalog and archives prepared. Nothing has been published.')
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [root, output] = process.argv.slice(2)
  if (!root || !output)
    throw new Error('Usage: stage-windows-notebook-components.mjs <signed-runtime-root> <output>')
  await stageWindowsNotebookComponents(resolve(root), resolve(output))
}
