// Stapling changes the ZIP bytes. Derive the feed and external blockmap from the same final file.
import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildBlockMap } from 'app-builder-lib/out/targets/blockmap/blockmap.js'
import { dump } from 'js-yaml'

const [dir, arch] = process.argv.slice(2)
if (!['arm64', 'x64'].includes(arch)) throw new Error('Expected macOS architecture')
const zips = readdirSync(dir).filter((name) => name.endsWith(`-mac-${arch}.zip`))
if (zips.length !== 1) throw new Error(`Expected one mac-${arch} ZIP, found ${zips.length}`)
const [url] = zips
const version = /^aipoch-open-science-(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)-mac-/.exec(url)?.[1]
if (!version) throw new Error(`Unexpected macOS ZIP name: ${url}`)
const zip = join(dir, url)
const { sha512, size } = await buildBlockMap(zip, 'gzip', `${zip}.blockmap`)
const feed = {
  version,
  files: [{ url, sha512, size }],
  path: url,
  sha512,
  releaseDate: new Date().toISOString()
}
writeFileSync(join(dir, `${arch}-mac.yml`), dump(feed, { lineWidth: -1 }))
