import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { run, setup } from '../build-common.mjs'

const { SRC, OUT } = setup({
  importMetaUrl: import.meta.url,
  srcDirName: 'windows-src',
})

const hostArchitecture = process.arch === 'x64' || process.arch === 'arm64' ? process.arch : undefined
const architecture = process.argv[2] ?? hostArchitecture
if (architecture !== 'x64' && architecture !== 'arm64') {
  throw new Error('Usage: node vendor/windows/build.mjs [x64|arm64]')
}

const target = architecture === 'x64' ? 'x86_64-pc-windows-msvc' : 'aarch64-pc-windows-msvc'
const cargoCommand =
  process.platform === 'win32'
    ? ['cargo', 'build']
    : [process.env.NOTEBOOK_CARGO_XWIN_BIN ?? 'cargo-xwin', 'build']
run([
  ...cargoCommand,
  '--locked',
  '--release',
  '--target',
  target,
  '--manifest-path',
  join(SRC, 'Cargo.toml'),
])

const built = join(SRC, 'target', target, 'release', 'notebook-appcontainer-host.exe')
if (!existsSync(built)) {
  console.error('Notebook Windows AppContainer host build: expected output not found at ' + built)
  process.exit(1)
}

const outputDirectory = join(OUT, architecture)
mkdirSync(outputDirectory, { recursive: true })
const dest = join(outputDirectory, 'notebook-appcontainer-host.exe')
copyFileSync(built, dest)
console.log('built ' + dest)
