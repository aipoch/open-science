/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  runtimeTargets,
  runtimePackageName,
  currentRuntimeTarget
} from '../packages/open-science/runtime-package.mjs'

export function releaseManifests(cli, standalone, target) {
  if (!runtimeTargets.some((item) => item.id === target.id))
    throw new Error('Unsupported npm target')
  if (!/^\d+\.\d+\.\d+$/.test(standalone.version))
    throw new Error('A stable release version is required')
  if (standalone.os?.[0] !== target.os || standalone.cpu?.[0] !== target.cpu)
    throw new Error('Standalone artifact does not match the native target')
  const main = {
    ...cli,
    version: standalone.version,
    engines: standalone.engines,
    optionalDependencies: Object.fromEntries(
      runtimeTargets.map((item) => [runtimePackageName(item), standalone.version])
    )
  }
  const native = { ...standalone, name: runtimePackageName(target) }
  delete native.bin
  delete native.exports
  delete native.optionalDependencies
  if (target.libc) native.libc = [target.libc]
  return { main, native }
}

export async function stageNpmRelease(root, source = join(root, 'out/standalone')) {
  const stage = join(root, 'out/npm-release')
  const cli = JSON.parse(await readFile(join(root, 'packages/open-science/package.json'), 'utf8'))
  const standalone = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  const version = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')).version
  if (standalone.version !== version) throw new Error('Stale standalone build version')
  const target = currentRuntimeTarget()
  const manifests = releaseManifests(cli, standalone, target)
  await rm(stage, { recursive: true, force: true })
  await mkdir(join(stage, 'main'), { recursive: true })
  for (const file of await readdir(join(root, 'packages/open-science'))) {
    if (file.includes('.test.')) continue
    if (/\.(mjs|d\.ts|d\.mts)$/.test(file) || ['LICENSE', 'README.md', 'CLI.md'].includes(file))
      await cp(join(root, 'packages/open-science', file), join(stage, 'main', file))
  }
  await cp(source, join(stage, target.id), { recursive: true })
  for (const [folder, manifest] of [
    ['main', manifests.main],
    [target.id, manifests.native]
  ])
    await writeFile(join(stage, folder, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`Staged npm entry and ${target.id} packages at ${version}`)
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  await stageNpmRelease(resolve(import.meta.dirname, '..'), process.env.OPEN_SCIENCE_RUNTIME_SOURCE)
