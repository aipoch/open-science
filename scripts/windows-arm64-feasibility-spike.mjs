import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('..', import.meta.url))
const read = (relativePath) => readFileSync(join(root, relativePath), 'utf8')

export function collectFindings() {
  const builder = read('electron-builder.yml')
  const lockfile = read('package-lock.json')
  const micromamba = read('scripts/micromamba-versions.json')
  const prismaSchema = read('prisma/schema.prisma')
  const sandboxBuild = read('packages/notebook-network-sandbox/vendor/windows/build.mjs')
  const runtimePaths = read('src/main/notebook/runtime-paths.ts')
  const staging = read('scripts/stage-default-envs.mjs')

  return [
    {
      id: 'electron-builder',
      status:
        builder.includes('artifactName: aipoch-${name}-${version}-win-${arch}') &&
        builder.includes('packages/notebook-network-sandbox/vendor/windows/${arch}') &&
        builder.includes('nsis:'),
      detail: 'NSIS and Windows resources already use the electron-builder architecture token.'
    },
    {
      id: 'native-node-packages',
      status:
        lockfile.includes('@img/sharp-win32-arm64') &&
        lockfile.includes('@napi-rs/canvas-win32-arm64-msvc') &&
        lockfile.includes('@esbuild/win32-arm64'),
      detail: 'The lockfile contains ARM64 optional packages for Sharp, canvas, and esbuild.'
    },
    {
      id: 'appcontainer-host',
      status:
        sandboxBuild.includes('aarch64-pc-windows-msvc') &&
        sandboxBuild.includes("architecture !== 'x64' && architecture !== 'arm64'"),
      detail: 'The host build script has an ARM64 target triple and architecture selector.'
    },
    {
      id: 'micromamba-arm64-binary',
      status:
        micromamba.includes('"win-arm64"') &&
        micromamba.includes('9990c8bacfa1019efcc58096d4d1aabbfc83b5760a782351b4bb7d5ef2578f28') &&
        micromamba.includes('62d82b63e7bcbd592882a35d0787f0a2b7051086323dd3fc4c758d42417b1323'),
      detail: 'The official win-arm64 micromamba archive and executable are now pinned locally.'
    },
    {
      id: 'notebook-python-runtime-platform',
      status:
        runtimePaths.includes("platform === 'win32' && arch === 'arm64'") &&
        staging.includes("process.platform === 'win32' && process.arch === 'arm64'"),
      blocking: true,
      detail:
        'The application runtime CDN mapping and offline pack staging still have no win-arm64 path.'
    },
    {
      id: 'notebook-r-runtime',
      status: false,
      blocking: true,
      detail: 'No pinned win-arm64 R runtime and package closure is present in the repository.'
    },
    {
      id: 'prisma-engine',
      status: prismaSchema.includes('windows-arm64'),
      blocking: true,
      detail: 'No Windows ARM64 Prisma binary target or generated ARM64 query engine is present.'
    },
    {
      id: 'native-arm64-validation',
      status: false,
      blocking: true,
      detail: 'A Windows ARM64 device or VM run is required before claiming support.'
    }
  ]
}

const isDirectExecution = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isDirectExecution) {
  const findings = collectFindings()
  if (process.argv.includes('--json')) {
    console.log(
      JSON.stringify({ supported: findings.every((finding) => finding.status), findings }, null, 2)
    )
  } else {
    for (const finding of findings) {
      console.log(
        `${finding.status ? 'PASS' : finding.blocking ? 'BLOCKED' : 'PENDING'} ${finding.id}: ${finding.detail}`
      )
    }
  }
}
