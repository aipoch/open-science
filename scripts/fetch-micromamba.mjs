#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Downloads a micromamba binary for one conda subdir and writes it to a destination path.
//
//   node scripts/fetch-micromamba.mjs <subdir> <destPath>
//   subdir   one of: osx-arm64 | osx-64 | linux-64 | linux-aarch64 | win-64
//   destPath full path to write the binary to (e.g. resources/bin/mac/arm64/micromamba)
//
// Source is the public micro.mamba.pm API (the same one the documented installer uses), NOT our CDN,
// so the shipped-binary requirement never depends on our own infrastructure. The API returns a
// .tar.bz2 whose binary lives at bin/micromamba (POSIX) or Library/bin/micromamba.exe (Windows); we
// extract to a temp dir with the system `tar` (present on every CI runner — GNU tar on Linux, bsdtar
// on macOS/Windows, all bzip2-capable) and copy the located binary to destPath (chmod +x on POSIX).
//
// The version and the per-subdir SHA256 come from scripts/micromamba-versions.json (MICROMAMBA_VERSION
// may override the version for dev). This binary is signed/notarized with the app, so we PIN the
// version (never `latest`) and VERIFY the downloaded .tar.bz2 against the pinned digest before copying
// anything — a missing pinned digest or a mismatch is fatal, keeping releases reproducible and
// tamper-evident. See that file for how to repin/regenerate the digests.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const SUBDIRS = new Set(['osx-arm64', 'osx-64', 'linux-64', 'linux-aarch64', 'win-64'])

// Pinned version + digests, loaded from the sibling JSON (kept out of code so repinning is a data edit).
const PINNED = JSON.parse(
  readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'micromamba-versions.json'), 'utf8')
)

// Recursively finds the micromamba binary basename under a directory.
const findBinary = (dir, name) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const hit = findBinary(full, name)
      if (hit) return hit
    } else if (entry.name === name) {
      return full
    }
  }
  return undefined
}

// Resolves the effective version, honoring MICROMAMBA_VERSION only when it equals the pinned version.
// The digests in micromamba-versions.json cover PINNED.version alone, so an override to any other
// version would download a different archive that can never match — fail fast with actionable guidance
// instead of a confusing "sha256 mismatch" after the download. `env` defaults to process.env for tests.
const resolveVersion = (env = process.env) => {
  const override = env.MICROMAMBA_VERSION
  if (override && override !== PINNED.version) {
    throw new Error(
      `MICROMAMBA_VERSION=${override} does not match the pinned ${PINNED.version}; ` +
        'update scripts/micromamba-versions.json (version + all 5 sha256 digests) to repin, ' +
        'rather than overriding at runtime'
    )
  }
  return PINNED.version
}

// Throws unless `buffer` (the downloaded .tar.bz2) matches the pinned SHA256 for `subdir`. A missing
// pinned digest is treated as fatal, so an unverifiable subdir can never ship.
const verifyArchiveDigest = (buffer, subdir) => {
  const expected = PINNED.sha256?.[subdir]
  if (!expected) {
    throw new Error(`no pinned sha256 for subdir "${subdir}" in micromamba-versions.json`)
  }
  const actual = createHash('sha256').update(buffer).digest('hex')
  if (actual !== expected) {
    throw new Error(
      `sha256 mismatch for ${subdir}: expected ${expected}, got ${actual} — refusing to use this binary`
    )
  }
}

const main = async () => {
  const [subdir, destPath] = process.argv.slice(2)
  if (!subdir || !destPath) {
    console.error('usage: node scripts/fetch-micromamba.mjs <subdir> <destPath>')
    process.exit(1)
  }
  if (!SUBDIRS.has(subdir)) {
    console.error(`unknown subdir "${subdir}" (expected one of ${[...SUBDIRS].join(', ')})`)
    process.exit(1)
  }
  const binName = subdir === 'win-64' ? 'micromamba.exe' : 'micromamba'
  const version = resolveVersion()
  const url = `https://micro.mamba.pm/api/micromamba/${subdir}/${version}`

  console.log(`[fetch-micromamba] ${subdir} ${version} -> ${destPath}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`)
  const archive = Buffer.from(await res.arrayBuffer())

  // Verify the downloaded archive against the pinned digest BEFORE extracting or copying anything.
  verifyArchiveDigest(archive, subdir)

  const staging = mkdtempSync(join(tmpdir(), 'mm-'))
  const archiveName = 'micromamba.tar.bz2'
  writeFileSync(join(staging, archiveName), archive)
  // Extract with cwd=staging and a RELATIVE archive name (no -C absolute path). On Windows, GNU tar
  // reads a drive-letter path like `C:\Users\...` as a remote `host:path` spec and fails with
  // "Cannot connect to C: resolve failed"; keeping every path relative avoids the colon entirely and
  // still works with bsdtar on macOS (which lacks GNU's --force-local).
  execFileSync('tar', ['-xjf', archiveName], { cwd: staging, stdio: 'ignore' })

  const found = findBinary(staging, binName)
  if (!found) throw new Error(`micromamba binary (${binName}) not found in the downloaded archive`)

  mkdirSync(dirname(destPath), { recursive: true })
  copyFileSync(found, destPath)
  if (binName !== 'micromamba.exe') chmodSync(destPath, 0o755)
  console.log(`[fetch-micromamba] wrote ${destPath}`)
}

export { PINNED, SUBDIRS, resolveVersion, verifyArchiveDigest }

// Run as a CLI only when invoked directly (importing for tests must not trigger a download).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('[fetch-micromamba] failed:', err)
    process.exit(1)
  })
}
