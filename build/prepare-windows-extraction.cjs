/* eslint-disable @typescript-eslint/no-require-imports, @typescript-eslint/explicit-function-return-type -- Node build script. */
const assert = require('node:assert/strict')
const { execFileSync } = require('node:child_process')
const fs = require('node:fs')
const path = require('node:path')

function parseEntries(listing) {
  const entries = listing
    .replace(/^[\r\n]+|[\r\n]+$/g, '')
    .split(/\r?\n\r?\n/)
    .filter(Boolean)
    .map((block) => {
      const pairs = block.split(/\r?\n/).map((line) => {
        const separator = line.indexOf(' = ')
        if (separator < 0) throw new Error('Invalid archive listing line')
        return [line.slice(0, separator), line.slice(separator + 3)]
      })
      if (new Set(pairs.map(([key]) => key)).size !== pairs.length)
        throw new Error('Duplicate archive listing field')
      const fields = Object.fromEntries(pairs)
      const name = fields.Path?.replaceAll('\\', '/')
      if (
        !name ||
        [...name].some((character) => character.charCodeAt(0) < 32) ||
        /[:"*?<>|]/.test(name) ||
        name
          .split('/')
          .some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part)) ||
        fields['Symbolic Link'] ||
        fields['Hard Link']
      )
        throw new Error(`Unsupported archive path: ${name}`)
      if (fields.Attributes === undefined) throw new Error(`Missing archive attributes: ${name}`)
      const directory = fields.Attributes.startsWith('D')
      const bytes = directory ? 0 : Number(fields.Size)
      if (!Number.isSafeInteger(bytes) || bytes < 0)
        throw new Error(`Invalid archive size: ${name}`)
      return { path: name, directory, bytes }
    })
  const names = new Set()
  for (const entry of entries) {
    const key = entry.path.toLowerCase()
    if (names.has(key)) throw new Error(`Duplicate archive path: ${entry.path}`)
    names.add(key)
  }
  return entries
}

function partitionFiles(files) {
  const groups = new Map()
  for (const file of [...files].sort((a, b) => a.path.localeCompare(b.path, 'en'))) {
    const pkg = file.path.match(/^resources\/backend\/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1]
    const key = pkg
      ? `resources/backend/node_modules/${pkg}`
      : file.path.startsWith('resources/backend/')
        ? 'resources/backend/[other]'
        : '[shell]'
    if (!groups.has(key)) groups.set(key, [])
    groups.get(key).push(file)
  }
  const bins = [
    { score: 0, files: [] },
    { score: 0, files: [] }
  ]
  for (const group of [...groups.values()].sort((a, b) => b.length - a.length)) {
    const bin = bins[0].score <= bins[1].score ? bins[0] : bins[1]
    bin.files.push(...group.map((file) => file.path))
    bin.score += group.length + group.reduce((sum, file) => sum + file.bytes, 0) / 2e6
  }
  return bins.map((bin) => bin.files)
}

function prepareExtraction(archive, destination, extractor) {
  const list = (args = []) =>
    parseEntries(
      execFileSync(extractor, ['l', '-slt', '-ba', '-sccUTF-8', '-spd', archive, ...args], {
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 64 * 1024 * 1024
      })
    )
  const entries = list(),
    files = entries.filter((entry) => !entry.directory)
  if (!files.length) throw new Error('Application archive has no files')
  const directories = entries.filter((entry) => entry.directory).map((entry) => entry.path)
  const partitions = partitionFiles(files)
  assert.deepEqual(partitions.flat().sort(), files.map((entry) => entry.path).sort())
  fs.mkdirSync(destination, { recursive: true })
  const writeList = (name, names) => {
    const file = path.join(destination, name)
    fs.writeFileSync(file, names.length ? names.join('\n') + '\n' : '')
    return file
  }
  const allFiles = writeList(
    'all-files.txt',
    files.map((entry) => entry.path)
  )
  const allDirectories = writeList('all-directories.txt', directories)
  // Validate the selectors with the same archive, including empty directories. A build
  // failure must stop NSIS compilation rather than embed a stale or incomplete manifest.
  const selected = list(['-i@' + allDirectories, '-x@' + allFiles])
  assert.ok(selected.every((entry) => entry.directory))
  assert.deepEqual(selected.map((entry) => entry.path).sort(), [...directories].sort())
  for (const [index, names] of partitions.entries()) {
    const file = writeList(`files-2-${index}.txt`, names)
    if (names.length)
      assert.deepEqual(
        list(['-i@' + file])
          .filter((entry) => !entry.directory)
          .map((entry) => entry.path)
          .sort(),
        [...names].sort()
      )
  }
  return {
    files: files.length,
    directories: directories.length,
    partitions: partitions.map((names) => names.length)
  }
}

module.exports = { parseEntries, partitionFiles, prepareExtraction }
if (require.main === module) {
  if (process.argv.length !== 4)
    throw new Error('Usage: prepare-windows-extraction.cjs <archive> <list-directory>')
  require('app-builder-lib/out/toolsets/7zip')
    .getPath7za()
    .then((extractor) => {
      console.log(
        '[windows-extraction]',
        prepareExtraction(path.resolve(process.argv[2]), path.resolve(process.argv[3]), extractor)
      )
    })
    .catch((error) => {
      console.error(error)
      process.exitCode = 1
    })
}
