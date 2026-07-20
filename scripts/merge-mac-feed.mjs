/* eslint-disable @typescript-eslint/explicit-function-return-type */
// Merge the two per-arch macOS update feeds (arm64-mac.yml + x64-mac.yml) into a single
// latest-mac.yml that lists both arch zips. This is the feed the installed app actually polls: its
// app-update.yml ships the default `latest` channel, so on macOS electron-updater fetches
// `latest-mac.yml`, then MacUpdater.filterFilesForArch picks the entry whose url contains `arm64`
// (arm64 + Rosetta) or the other one (Intel x64). Emitting one combined feed avoids the arm64/x64
// runners colliding on the same filename, without the per-arch `${arch}-mac.yml` channel scheme that
// left field apps polling a filename the pipeline never published.
//
// Usage: node scripts/merge-mac-feed.mjs [dir]   (dir defaults to cwd)
// No-ops (exit 0) unless BOTH per-arch feeds are present, so a partial/non-mac run is harmless.
import { readFileSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const dir = process.argv[2] ?? '.'
const archFeeds = ['arm64-mac.yml', 'x64-mac.yml'].map((name) => join(dir, name))

if (!archFeeds.every(existsSync)) {
  console.log('merge-mac-feed: both per-arch feeds not present, skipping')
  process.exit(0)
}

// The per-arch feeds are machine-generated with a fixed shape (see notarize-mac.yml), so a targeted
// parse is enough and avoids a YAML dependency. Each feed lists exactly one file, so after `files:`
// the first sha512/size belong to that entry.
const parse = (file) => {
  const text = readFileSync(file, 'utf8')
  const version = text.match(/^version:\s*(.+)$/m)?.[1].trim()
  const filesBlock = text.slice(text.indexOf('files:'))
  const url = filesBlock.match(/-\s*url:\s*(.+)/)?.[1].trim()
  const sha512 = filesBlock.match(/sha512:\s*(.+)/)?.[1].trim()
  const size = filesBlock.match(/size:\s*(\d+)/)?.[1]
  const releaseDate = text.match(/^releaseDate:\s*(.+)$/m)?.[1].trim()
  if (!version || !url || !sha512 || !size) {
    console.error(`::error::could not parse mac feed ${file}`)
    process.exit(1)
  }
  return { version, url, sha512, size, releaseDate }
}

const entries = archFeeds.map(parse)
const version = entries[0].version
// Newest of the two timestamps, so the combined feed's date reflects the last-stapled arch.
const releaseDate = entries
  .map((e) => e.releaseDate?.replace(/^["']|["']$/g, ''))
  .filter(Boolean)
  .sort()
  .pop()

const filesYaml = entries
  .map((e) => `  - url: ${e.url}\n    sha512: ${e.sha512}\n    size: ${e.size}`)
  .join('\n')

// Top-level path/sha512 are legacy single-file fields; MacUpdater downloads from files[] after arch
// filtering, so point them at the first entry for backward-compat.
const yml =
  `version: ${version}\n` +
  `files:\n${filesYaml}\n` +
  `path: ${entries[0].url}\n` +
  `sha512: ${entries[0].sha512}\n` +
  `releaseDate: ${JSON.stringify(releaseDate ?? new Date().toISOString())}\n`

writeFileSync(join(dir, 'latest-mac.yml'), yml)
process.stdout.write(yml)
