/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { readdirSync, existsSync, writeFileSync, statSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { artifactHash, validateArtifactName } from './release-artifact-validation.mjs'
import { dump } from 'js-yaml'

export const macArtifact = (name) => {
  const match = /^aipoch-open-science-(.+)-mac-(arm64|x64)(-runtime)?\.(dmg|zip)$/.exec(
    basename(name)
  )
  if (!match || (match[3] && match[4] !== 'zip'))
    throw new Error(`Invalid macOS artifact name: ${name}`)
  return {
    version: match[1],
    arch: match[2],
    kind: match[4] === 'dmg' ? 'dmg' : match[3] ? 'runtime' : 'ordinary'
  }
}
export const selectMacArtifacts = (directory, arch) => {
  if (!['arm64', 'x64'].includes(arch)) throw new Error('Invalid macOS architecture')
  const names = readdirSync(directory).filter(
    (name) => name.includes(`-mac-${arch}`) && /\.(zip|dmg)$/.test(name)
  )
  const result = {}
  for (const name of names) {
    const artifact = macArtifact(name)
    if (artifact.arch !== arch || result[artifact.kind])
      throw new Error('Ambiguous macOS artifact set')
    result[artifact.kind] = join(directory, name)
    if (result.version && result.version !== artifact.version)
      throw new Error('Mixed macOS artifact versions')
    result.version = artifact.version
  }
  if (!result.dmg || !result.ordinary || !result.runtime)
    throw new Error('Expected one ordinary DMG, ordinary ZIP and runtime ZIP')
  return result
}
// Old published releases remain readable for backfills. Once a runtime ZIP exists, the ordinary
// ZIP is a launcher and must never become an electron-updater payload.
export const selectMacFeedEntry = (feed, directory, arch) => {
  const runtimeSuffix = `-mac-${arch}-runtime.zip`
  const runtime = feed.files.filter((file) => file.url.endsWith(runtimeSuffix))
  const runtimePresent = readdirSync(directory).some((name) => name.endsWith(runtimeSuffix))
  if (runtime.length || runtimePresent) {
    if (runtime.length !== 1 || feed.files.some((file) => file.url.endsWith(`-mac-${arch}.zip`)))
      throw new Error(
        'Mac update feed must select only the runtime ZIP, never the ordinary launcher ZIP'
      )
    return runtime[0]
  }
  const legacy = feed.files.filter((file) => file.url.endsWith(`-mac-${arch}.zip`))
  if (legacy.length !== 1) throw new Error(`Expected one mac-${arch} runtime update artifact`)
  return legacy[0]
}
export const regenerateMacFeed = (directory, arch) => {
  const artifacts = selectMacArtifacts(directory, arch)
  const runtime = artifacts.runtime
  const name = basename(runtime)
  validateArtifactName(name, artifacts.version)
  const file = {
    url: name,
    sha512: artifactHash(runtime, 'sha512', 'base64'),
    size: statSync(runtime).size
  }
  if (!file.size) throw new Error('Runtime update ZIP is empty')
  const source = dump(
    {
      version: artifacts.version,
      files: [file],
      path: name,
      sha512: file.sha512,
      releaseDate: new Date().toISOString()
    },
    { lineWidth: -1 }
  )
  writeFileSync(join(directory, `${arch}-mac.yml`), source)
  return source
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, directory = 'mac', arch] = process.argv.slice(2)
  if (mode === 'check') console.log(JSON.stringify(selectMacArtifacts(directory, arch)))
  else if (mode === 'feed') {
    if (existsSync(join(directory, 'latest-mac.yml')))
      throw new Error('Remove the stale build feed before regenerating stapled metadata')
    process.stdout.write(regenerateMacFeed(directory, arch))
  } else throw new Error('Usage: mac-artifact-contract.mjs check|feed <directory> arm64|x64')
}
