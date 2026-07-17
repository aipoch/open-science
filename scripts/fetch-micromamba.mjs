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
// Pin a release by setting MICROMAMBA_VERSION (defaults to `latest`).
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

const SUBDIRS = new Set(['osx-arm64', 'osx-64', 'linux-64', 'linux-aarch64', 'win-64'])

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
  const version = process.env.MICROMAMBA_VERSION ?? 'latest'
  const url = `https://micro.mamba.pm/api/micromamba/${subdir}/${version}`

  console.log(`[fetch-micromamba] ${subdir} ${version} -> ${destPath}`)
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`)

  const staging = mkdtempSync(join(tmpdir(), 'mm-'))
  const archiveName = 'micromamba.tar.bz2'
  writeFileSync(join(staging, archiveName), Buffer.from(await res.arrayBuffer()))
  // Extract with cwd=staging and a RELATIVE archive name (no -C absolute path). On Windows, GNU tar
  // reads a drive-letter path like `C:\Users\...` as a remote `host:path` spec and fails with
  // "Cannot connect to C: resolve failed"; keeping every path relative avoids the colon entirely and
  // still works with bsdtar on macOS (which lacks GNU's --force-local).
  execFileSync('tar', ['-xjf', archiveName], { cwd: staging, stdio: 'inherit' })

  const found = findBinary(staging, binName)
  if (!found) throw new Error(`micromamba binary (${binName}) not found in the downloaded archive`)

  mkdirSync(dirname(destPath), { recursive: true })
  copyFileSync(found, destPath)
  if (binName !== 'micromamba.exe') chmodSync(destPath, 0o755)
  console.log(`[fetch-micromamba] wrote ${destPath}`)
}

main().catch((err) => {
  console.error('[fetch-micromamba] failed:', err)
  process.exit(1)
})
