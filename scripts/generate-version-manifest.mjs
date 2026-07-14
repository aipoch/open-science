/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Generate version.json: the single manifest that powers the website's download page and the
// in-app update prompt (sub-project 2). Pure Node ESM, zero network — input is a local directory of
// release installers plus SHA256SUMS.txt, output is the manifest object / a version.json file.
//
// CLI (executed directly), inputs from argv + env:
//   node scripts/generate-version-manifest.mjs [dir] [outputPath]
//     dir         positional or env DIST_DIR   directory holding installers + SHA256SUMS.txt
//                 (default: dist-assets)
//     outputPath  positional or env OUTPUT      where to write version.json (default: <dir>/version.json)
//     VERSION       required  release version without a leading 'v' (e.g. 0.1.2)
//     CDN_BASE_URL  required  public base URL used to build each download url
//     S3_PREFIX     required  path prefix inside the bucket (e.g. open-science)
//     NOTES         optional  release notes (GitHub Release body)
//     RELEASE_DATE  optional  ISO timestamp (GitHub Release published_at)

import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

// Filename -> downloads key. Explicit regex table so an unexpected artifact name fails loudly (as a
// warning) rather than being silently misfiled. deb uses the dpkg convention (underscores + amd64).
const KEY_RULES = [
  { key: 'mac-arm64', pattern: /-mac-arm64\.dmg$/ },
  { key: 'mac-x64', pattern: /-mac-x64\.dmg$/ },
  { key: 'win-x64', pattern: /-win-x64-setup\.exe$/ },
  { key: 'linux-x64-appimage', pattern: /-linux-x64\.AppImage$/ },
  { key: 'linux-x64-deb', pattern: /_amd64\.deb$/ }
]

// Non-installer files that legitimately live in the release dir; skipped without a warning.
const IGNORED = [/\.zip$/, /^SHA256SUMS\.txt$/, /^version\.json$/, /\.ya?ml$/, /\.blockmap$/]

// Parse a `<hex>  <filename>` per-line SHA256SUMS.txt into { filename: hex }. Tolerates 1+ spaces
// and an optional leading '*' binary marker that some sha256sum variants emit.
export function parseSha256Sums(content) {
  const map = {}
  for (const line of content.split('\n')) {
    const match = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/)
    if (match) map[match[2]] = match[1].toLowerCase()
  }
  return map
}

// Match a filename to its downloads key, or null when no rule applies.
function keyForFile(filename) {
  return KEY_RULES.find((rule) => rule.pattern.test(filename))?.key ?? null
}

// Build the version.json manifest object from a directory of installers + SHA256SUMS.txt.
// Pure: reads the filesystem but performs no network I/O. Only keys whose installer actually exists
// (and has a checksum) are emitted; unrecognized files and files missing from SHA256SUMS warn.
export function buildManifest({ dir, version, notes, releaseDate, cdnBase, prefix }) {
  const sums = parseSha256Sums(readFileSync(join(dir, 'SHA256SUMS.txt'), 'utf8'))
  const base = `${cdnBase}/${prefix}/releases/${version}`

  const downloads = {}
  for (const filename of readdirSync(dir)) {
    const key = keyForFile(filename)
    if (!key) {
      // Warn only for genuinely unexpected files, not known non-manifest artifacts (zips, sums, ...).
      if (!IGNORED.some((pattern) => pattern.test(filename))) {
        console.warn(`[version-manifest] unrecognized file, ignoring: ${filename}`)
      }
      continue
    }
    const sha256 = sums[filename]
    if (!sha256) {
      // No verifiable hash -> useless to the in-app integrity check, so drop it rather than emit it.
      console.warn(`[version-manifest] no sha256 in SHA256SUMS.txt, skipping: ${filename}`)
      continue
    }
    downloads[key] = {
      url: `${base}/${filename}`,
      size: statSync(join(dir, filename)).size,
      sha256
    }
  }

  return { version, releaseDate, notes, downloads }
}

// --- Release-notes condensation -----------------------------------------------------------------

// H2 sections kept in the in-app "what's new" notes, matched case-insensitively by heading text with
// emoji/punctuation stripped. Everything else in a release body (install steps, maturity notes,
// acknowledgements, the auto-generated "What's Changed"/contributors) is dropped.
const NOTE_SECTIONS = new Set(['highlights', 'new features', 'improvements', 'bug fixes'])

// Normalize a `## …` heading to its comparable label: drop the leading #'s and any emoji/punctuation,
// collapse whitespace, lowercase. `## 🐛 Bug Fixes` -> `bug fixes`.
function headingLabel(line) {
  return line
    .replace(/^#+\s*/, '')
    .replace(/[^\p{L}\p{N} ]+/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

// Condense a full GitHub release body into concise "what's new" notes: keep only the allowlisted H2
// sections, in document order. Falls back to the preamble (text before the first H2, minus the H1
// title) when no allowlisted section is present, and to '' for an empty body.
export function extractHighlights(body) {
  if (!body || !body.trim()) return ''

  const sections = []
  let current = { label: null, lines: [] } // label null = preamble before the first H2
  for (const line of body.split('\n')) {
    if (/^##\s+/.test(line)) {
      sections.push(current)
      current = { label: headingLabel(line), lines: [line] }
    } else {
      current.lines.push(line)
    }
  }
  sections.push(current)

  const kept = sections
    .filter((section) => section.label && NOTE_SECTIONS.has(section.label))
    .map((section) => section.lines.join('\n').trim())
    .filter(Boolean)
  if (kept.length > 0) return kept.join('\n\n')

  // Fallback: the preamble before the first H2, without the H1 title line.
  return (sections[0]?.lines ?? [])
    .filter((line) => !/^#\s+/.test(line))
    .join('\n')
    .trim()
}

// CLI entry: only runs when the file is executed directly, not when imported by the test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const dir = process.argv[2] || process.env.DIST_DIR || 'dist-assets'
  const outputPath = process.argv[3] || process.env.OUTPUT || join(dir, 'version.json')

  const version = process.env.VERSION
  const cdnBase = process.env.CDN_BASE_URL
  const prefix = process.env.S3_PREFIX
  if (!version || !cdnBase || !prefix) {
    console.error('[version-manifest] VERSION, CDN_BASE_URL and S3_PREFIX are required')
    process.exit(1)
  }

  const manifest = buildManifest({
    dir,
    version,
    notes: extractHighlights(process.env.NOTES ?? ''),
    releaseDate: process.env.RELEASE_DATE ?? '',
    cdnBase,
    prefix
  })

  writeFileSync(outputPath, `${JSON.stringify(manifest, null, 2)}\n`)
  console.log(outputPath)
}
