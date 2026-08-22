/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { readFile, readdir, writeFile } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

import blockmap from 'app-builder-lib/out/targets/blockmap/blockmap.js'
import { dump, load } from 'js-yaml'

const { buildBlockMap } = blockmap
const WINDOWS_INSTALLER = /-win-x64-setup\.exe$/

const argumentValue = (argv, name) => {
  const index = argv.indexOf(name)
  return index === -1 ? undefined : argv[index + 1]
}

const refreshWindowsReleaseMetadata = async ({ artifactDirectory }) => {
  const directory = resolve(artifactDirectory)
  const names = await readdir(directory)
  const installers = names.filter((name) => WINDOWS_INSTALLER.test(name))
  if (installers.length !== 1) {
    throw new Error(
      `Expected exactly one Windows setup EXE in ${directory}; found ${installers.length}.`
    )
  }

  const installerName = installers[0]
  const installerPath = join(directory, installerName)
  const blockmapPath = `${installerPath}.blockmap`
  const feedPath = join(directory, 'latest.yml')
  const feed = load(await readFile(feedPath, 'utf8'))
  if (!feed || typeof feed !== 'object' || !Array.isArray(feed.files)) {
    throw new Error('latest.yml does not contain a files list.')
  }

  const matchingFiles = feed.files.filter(
    (file) => file && typeof file === 'object' && basename(file.url ?? '') === installerName
  )
  if (matchingFiles.length !== 1 || basename(feed.path ?? '') !== installerName) {
    throw new Error(`latest.yml does not identify exactly one ${installerName} release file.`)
  }

  const updateInfo = await buildBlockMap(installerPath, 'gzip', blockmapPath)
  matchingFiles[0].sha512 = updateInfo.sha512
  matchingFiles[0].size = updateInfo.size
  feed.sha512 = updateInfo.sha512
  await writeFile(feedPath, dump(feed, { lineWidth: -1, noRefs: true }), 'utf8')

  return {
    installerName,
    size: updateInfo.size,
    sha512: updateInfo.sha512
  }
}

const main = async () => {
  const artifactDirectory = argumentValue(process.argv.slice(2), '--artifact-dir')
  if (!artifactDirectory) throw new Error('Usage: --artifact-dir <path>')
  const result = await refreshWindowsReleaseMetadata({ artifactDirectory })
  console.log(`Refreshed ${result.installerName}: size=${result.size}, sha512=${result.sha512}`)
}

const invokedAsScript =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(resolve(process.argv[1])).href
if (invokedAsScript) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}

export { refreshWindowsReleaseMetadata }
