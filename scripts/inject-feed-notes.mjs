/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Inject the condensed release notes into each electron-updater feed's `releaseNotes` field.
//
// Why: already-installed clients (v0.3.0/v0.3.1) read update notes ONLY from the feed's
// `releaseNotes` — the in-app fix that also reads version.json only helps builds that ship it. So the
// feed is the sole channel that reaches the existing installed base. electron-builder never writes
// `releaseNotes` into the feed, hence the empty "What's new" and the GitHub-link fallback.
//
// Safety: each feed is parsed with js-yaml, the field is set on the object, and the result is
// re-serialized by js-yaml — we never hand-write YAML, so malformed output is impossible, and the
// re-parse guard throws before anything is written/uploaded. Re-running is idempotent (the field is
// overwritten, not appended). The notes source is the freshly built version.json, so the feed notes
// stay identical to what the website/manifest shows.
//
// CLI: node scripts/inject-feed-notes.mjs <version.json> <feed.yml> [feed.yml...]

import { readFileSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

import yaml from 'js-yaml'

// Set releaseNotes on one feed's YAML text and return the re-serialized text. Throws when the feed
// isn't a YAML mapping or when the produced YAML fails to re-parse.
export function injectNotesIntoFeed(feedText, notes) {
  const doc = yaml.load(feedText)
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
    throw new Error('feed is not a YAML mapping')
  }
  doc.releaseNotes = notes
  // lineWidth: -1 disables line wrapping so long scalars (sha512, urls) stay on one line.
  const out = yaml.dump(doc, { lineWidth: -1 })
  yaml.load(out) // re-parse guard: fail loudly before any write/upload rather than ship broken YAML
  return out
}

// Read the condensed notes from a version.json manifest; '' when absent.
export function notesFromManifest(manifestText) {
  return String(JSON.parse(manifestText).notes ?? '').trim()
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [manifestPath, ...feeds] = process.argv.slice(2)
  if (!manifestPath || feeds.length === 0) {
    console.error('usage: inject-feed-notes.mjs <version.json> <feed.yml...>')
    process.exit(1)
  }

  const notes = notesFromManifest(readFileSync(manifestPath, 'utf8'))
  if (!notes) {
    console.log('inject-feed-notes: manifest has no notes, leaving feeds unchanged')
    process.exit(0)
  }

  for (const feed of feeds) {
    writeFileSync(feed, injectNotesIntoFeed(readFileSync(feed, 'utf8'), notes))
    console.log(`inject-feed-notes: wrote releaseNotes into ${feed}`)
  }
}
