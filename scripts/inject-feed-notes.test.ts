import yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

import { injectNotesIntoFeed, notesFromManifest } from './inject-feed-notes.mjs'

// A representative electron-updater mac feed (matches the shape merge-mac-feed.mjs emits).
const FEED = `version: 0.3.1
files:
  - url: releases/0.3.1/open-science-0.3.1-mac-arm64.zip
    sha512: YTCyMaLpgWFVX/rZz7fDWsEM2EO4glaXmwVHWw3SJi3eUe3vHky28/8pijGLaf+dVXQLBY8daT9hhOIOvTDpqg==
    size: 176317136
path: releases/0.3.1/open-science-0.3.1-mac-arm64.zip
sha512: YTCyMaLpgWFVX/rZz7fDWsEM2EO4glaXmwVHWw3SJi3eUe3vHky28/8pijGLaf+dVXQLBY8daT9hhOIOvTDpqg==
releaseDate: "2026-07-17T09:15:41.876Z"
`

const NOTES =
  '## ✨ Highlights\n\n- **Download your files.** New in this build. (#158)\n- Colons: and `code`, "quotes", trailing spaces   \n'

describe('injectNotesIntoFeed', () => {
  it('sets releaseNotes while preserving version, files, and integrity fields', () => {
    const out = injectNotesIntoFeed(FEED, NOTES)
    const doc = yaml.load(out) as Record<string, unknown>
    expect(doc.releaseNotes).toBe(NOTES)
    expect(doc.version).toBe('0.3.1')
    expect(doc.path).toBe('releases/0.3.1/open-science-0.3.1-mac-arm64.zip')
    const files = doc.files as Array<{ url: string; sha512: string; size: number }>
    expect(files).toHaveLength(1)
    expect(files[0].size).toBe(176317136)
    expect(files[0].sha512).toBe(
      'YTCyMaLpgWFVX/rZz7fDWsEM2EO4glaXmwVHWw3SJi3eUe3vHky28/8pijGLaf+dVXQLBY8daT9hhOIOvTDpqg=='
    )
  })

  it('always produces valid, re-parseable YAML for notes with special characters', () => {
    const out = injectNotesIntoFeed(FEED, NOTES)
    expect(() => yaml.load(out)).not.toThrow()
  })

  it('is idempotent — re-injecting the same notes yields the same output', () => {
    const once = injectNotesIntoFeed(FEED, NOTES)
    const twice = injectNotesIntoFeed(once, NOTES)
    expect(twice).toBe(once)
  })

  it('throws on a feed that is not a YAML mapping', () => {
    expect(() => injectNotesIntoFeed('- just\n- a\n- list\n', NOTES)).toThrow(/mapping/)
  })
})

describe('notesFromManifest', () => {
  it('reads and trims the notes field', () => {
    expect(notesFromManifest('{"notes":"  hi there  "}')).toBe('hi there')
  })

  it('returns empty string when notes are absent', () => {
    expect(notesFromManifest('{"version":"0.3.1"}')).toBe('')
  })
})
