import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { buildManifest, extractHighlights, parseSha256Sums } from './generate-version-manifest.mjs'

const VERSION = '0.1.2'
const CDN = 'https://cdn.example.com'
const PREFIX = 'open-science'

// The full set of installer filenames a complete release produces (matches electron-builder.yml
// artifactName templates with the aipoch- prefix).
const INSTALLERS = {
  'mac-arm64': `aipoch-open-science-${VERSION}-mac-arm64.dmg`,
  'mac-x64': `aipoch-open-science-${VERSION}-mac-x64.dmg`,
  'win-x64': `aipoch-open-science-${VERSION}-win-x64-setup.exe`,
  'linux-x64-appimage': `aipoch-open-science-${VERSION}-linux-x64.AppImage`,
  'linux-x64-deb': `aipoch-open-science_${VERSION}_amd64.deb`
}

// One line of SHA256SUMS.txt worth of file: content is hashed by `sha` (or omitted when sha is null).
type FileSpec = { name: string; content: string; sha: string | null }

// Builds a hermetic release directory: writes each given file with deterministic contents and a
// matching SHA256SUMS.txt. Contents/hashes are arbitrary but fixed, so assertions stay stable.
function makeReleaseDir(files: FileSpec[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'version-manifest-'))
  const sumsLines: string[] = []
  for (const { name, content, sha } of files) {
    writeFileSync(join(dir, name), content)
    if (sha !== null) sumsLines.push(`${sha}  ${name}`)
  }
  writeFileSync(join(dir, 'SHA256SUMS.txt'), `${sumsLines.join('\n')}\n`)
  return dir
}

// A canonical entry: 64-hex sha keyed off the platform so each file gets a distinct, checkable hash.
const HEX = (n: string): string => n.repeat(64)
function entry(key: keyof typeof INSTALLERS, extra = 0): FileSpec {
  return { name: INSTALLERS[key], content: 'x'.repeat(10 + extra), sha: HEX(String(extra % 10)) }
}

describe('parseSha256Sums', () => {
  it('parses `<hex>  <filename>` lines and lowercases the hash', () => {
    const map = parseSha256Sums(
      `${'A'.repeat(64)}  file-one.dmg\n${'b'.repeat(64)}  file two.exe\n`
    )
    expect(map['file-one.dmg']).toBe('a'.repeat(64))
    expect(map['file two.exe']).toBe('b'.repeat(64))
  })

  it('tolerates the optional binary-mode `*` marker and ignores junk lines', () => {
    const map = parseSha256Sums(`${'c'.repeat(64)} *app.AppImage\nnot a checksum line\n`)
    expect(map['app.AppImage']).toBe('c'.repeat(64))
    expect(Object.keys(map)).toHaveLength(1)
  })
})

describe('extractHighlights', () => {
  const body = [
    '# Open Science v0.2.0',
    '',
    '> one-line tagline',
    '',
    'Intro paragraph.',
    '',
    '## ✨ Highlights',
    '',
    '- Point one (#1)',
    '- Point two',
    '',
    '## 🚀 New Features',
    '',
    '- Feature A',
    '',
    '## 🔧 Improvements',
    '',
    '- Improvement A',
    '',
    '## 🐛 Bug Fixes',
    '',
    '- Fix A',
    '',
    '## 📦 Install',
    '',
    'Download the build for your platform.',
    '',
    "## What's Changed",
    '',
    '- chore: bump deps'
  ].join('\n')

  it('keeps only the allowlisted sections, in document order', () => {
    const notes = extractHighlights(body)

    expect(notes).toContain('## ✨ Highlights')
    expect(notes).toContain('## 🚀 New Features')
    expect(notes).toContain('## 🔧 Improvements')
    expect(notes).toContain('## 🐛 Bug Fixes')
    // Dropped sections and their content.
    expect(notes).not.toContain('## 📦 Install')
    expect(notes).not.toContain('Download the build')
    expect(notes).not.toContain("What's Changed")
    expect(notes).not.toContain('bump deps')
    // Order preserved.
    expect(notes.indexOf('Highlights')).toBeLessThan(notes.indexOf('Bug Fixes'))
  })

  it('returns an empty string for an empty or blank body', () => {
    expect(extractHighlights('')).toBe('')
    expect(extractHighlights('   \n  \n')).toBe('')
    expect(extractHighlights(undefined)).toBe('')
  })

  it('falls back to the preamble (minus the H1 title) when no allowlisted section exists', () => {
    const plain = '# Title\n\n> tagline\n\nSome intro without standard sections.'
    const notes = extractHighlights(plain)

    expect(notes).not.toContain('# Title')
    expect(notes).toContain('tagline')
    expect(notes).toContain('Some intro without standard sections.')
  })
})

describe('buildManifest', () => {
  let dir: string | undefined
  afterEach(() => dir && rmSync(dir, { recursive: true, force: true }))

  it('maps every installer to its key with url, size and sha256', () => {
    const files = Object.keys(INSTALLERS).map((key, i) => entry(key, i + 1))
    dir = makeReleaseDir(files)

    const manifest = buildManifest({
      dir,
      version: VERSION,
      notes: 'Release notes here',
      releaseDate: '2026-07-12T00:00:00Z',
      cdnBase: CDN,
      prefix: PREFIX
    })

    // version / notes / releaseDate pass through untouched.
    expect(manifest.version).toBe(VERSION)
    expect(manifest.notes).toBe('Release notes here')
    expect(manifest.releaseDate).toBe('2026-07-12T00:00:00Z')

    // All five platform keys present.
    expect(Object.keys(manifest.downloads).sort()).toEqual(Object.keys(INSTALLERS).sort())

    // url construction: <cdn>/<prefix>/releases/<version>/<filename>.
    expect(manifest.downloads['win-x64'].url).toBe(
      `${CDN}/${PREFIX}/releases/${VERSION}/${INSTALLERS['win-x64']}`
    )
    // deb keeps the underscore/amd64 convention in its url.
    expect(manifest.downloads['linux-x64-deb'].url).toBe(
      `${CDN}/${PREFIX}/releases/${VERSION}/aipoch-open-science_${VERSION}_amd64.deb`
    )

    // sha256 comes from SHA256SUMS.txt (entry #2 -> content length 12, sha of '2').
    const deb = files.find((f) => f.name === INSTALLERS['linux-x64-deb'])
    expect(manifest.downloads['linux-x64-deb'].sha256).toBe(deb.sha)
    expect(manifest.downloads['linux-x64-deb'].size).toBe(deb.content.length)
  })

  it('omits a platform whose installer is missing', () => {
    dir = makeReleaseDir([entry('mac-arm64', 1), entry('win-x64', 2)])

    const manifest = buildManifest({
      dir,
      version: VERSION,
      notes: '',
      releaseDate: '',
      cdnBase: CDN,
      prefix: PREFIX
    })

    expect(Object.keys(manifest.downloads).sort()).toEqual(['mac-arm64', 'win-x64'])
    expect(manifest.downloads['mac-x64']).toBeUndefined()
    expect(manifest.downloads['linux-x64-deb']).toBeUndefined()
  })

  it('warns and skips an installer missing from SHA256SUMS', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    dir = makeReleaseDir([entry('mac-arm64', 1), { ...entry('mac-x64', 2), sha: null }])

    const manifest = buildManifest({
      dir,
      version: VERSION,
      notes: '',
      releaseDate: '',
      cdnBase: CDN,
      prefix: PREFIX
    })

    expect(manifest.downloads['mac-arm64']).toBeDefined()
    expect(manifest.downloads['mac-x64']).toBeUndefined()
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('no sha256'))
    warn.mockRestore()
  })

  it('warns on an unrecognized file but stays silent for zips and checksums', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    dir = makeReleaseDir([
      entry('mac-arm64', 1),
      { name: 'aipoch-open-science-0.1.2-mac-arm64.zip', content: 'zip', sha: HEX('9') },
      { name: 'mystery-artifact.bin', content: 'bin', sha: HEX('8') }
    ])

    const manifest = buildManifest({
      dir,
      version: VERSION,
      notes: '',
      releaseDate: '',
      cdnBase: CDN,
      prefix: PREFIX
    })

    // zip is mirrored to S3 but is not a manifest key.
    expect(manifest.downloads['mac-arm64']).toBeDefined()
    expect(Object.keys(manifest.downloads)).toEqual(['mac-arm64'])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('mystery-artifact.bin'))
    warn.mockRestore()
  })
})
