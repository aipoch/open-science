import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdir, readdir, appendFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { verifyRuntimeSignatures } from './verify-runtime-signatures.mjs'

const root = resolve(import.meta.dirname, '..')
const artifacts = join(root, 'out/runtime-desktop')
const destination = join(root, 'out/runtime-extracted')
await mkdir(destination, { recursive: true })
const extension = { darwin: '.zip', linux: '.deb', win32: '-setup.exe' }[process.platform]
const files = (await readdir(artifacts)).filter((file) => file.endsWith(extension))
assert.equal(files.length, 1, `Expected one desktop ${extension}`)
const archive = join(artifacts, files[0])
let source
if (process.platform === 'darwin') {
  execFileSync('ditto', ['-x', '-k', archive, destination], { stdio: 'inherit' })
  const apps = (await readdir(destination)).filter((file) => file.endsWith('.app'))
  assert.equal(apps.length, 1)
  source = join(destination, apps[0], 'Contents/Resources/backend')
} else if (process.platform === 'linux') {
  execFileSync('dpkg-deb', ['--extract', archive, destination], { stdio: 'inherit' })
  source = join(destination, 'opt/Open-Science/resources/backend')
} else {
  execFileSync(
    'pwsh',
    [
      '-NoProfile',
      '-Command',
      `
    $ErrorActionPreference = 'Stop'
    $process = Start-Process -FilePath $env:RUNTIME_INSTALLER -ArgumentList @('/S', "/D=$env:RUNTIME_DESTINATION") -Wait -PassThru
    if ($process.ExitCode -ne 0) { throw "Installer failed: $($process.ExitCode)" }
  `
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, RUNTIME_INSTALLER: archive, RUNTIME_DESTINATION: destination }
    }
  )
  source = join(destination, 'resources/backend')
}
const nodeSource = join(dirname(source), 'node-runtime')
await verifyRuntimeSignatures(source)
await verifyRuntimeSignatures(nodeSource)
await appendFile(
  process.env.GITHUB_ENV,
  `OPEN_SCIENCE_RUNTIME_SOURCE=${source}\nOPEN_SCIENCE_NODE_SOURCE=${nodeSource}\nOPEN_SCIENCE_RUNTIME_VERIFY_SIGNATURES=1\n`
)
