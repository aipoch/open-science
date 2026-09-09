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
// An entirely non-mac directory may be skipped. Any partial mac publication fails closed.
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { dump, load } from 'js-yaml'
import { validateUpdateFeed } from './release-artifact-validation.mjs'

const dir = process.argv[2] ?? '.'
const names = ['arm64-mac.yml', 'x64-mac.yml']
if (!names.every((name) => existsSync(join(dir, name)))) {
  if (readdirSync(dir).some((name) => /-mac(?:-|\.)/.test(name))) {
    throw new Error('Both macOS architecture feeds are required')
  }
  console.log('merge-mac-feed: no macOS artifacts, skipping')
  process.exit(0)
}
const feeds = names.map((name) => load(readFileSync(join(dir, name), 'utf8')))
const version = feeds[0].version
const files = feeds.map((feed, index) => {
  validateUpdateFeed(feed, dir, version, process.argv.includes('--metadata-only'))
  const suffix = index === 0 ? '-mac-arm64.zip' : '-mac-x64.zip'
  const entries = feed.files.filter((file) => file.url.endsWith(suffix))
  if (entries.length !== 1) throw new Error(`Expected one ${suffix} update artifact`)
  return entries[0]
})
const releaseDate = feeds
  .map((feed) => feed.releaseDate)
  .filter(Boolean)
  .map(String)
  .sort()
  .pop()
const yml = dump(
  {
    version,
    files,
    path: files[0].url,
    sha512: files[0].sha512,
    releaseDate: releaseDate ?? new Date().toISOString()
  },
  { lineWidth: -1 }
)
writeFileSync(join(dir, 'latest-mac.yml'), yml)
process.stdout.write(yml)
