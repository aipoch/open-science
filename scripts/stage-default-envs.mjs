#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */

// Builds the packaged default-environment resources for offline first-run:
//   resources/default-envs/default-python.lock   (@EXPLICIT explicit lock)
//   resources/default-envs/default-r.lock
//   resources/default-envs/pkgs/*.conda|*.tar.bz2 (referenced package tarballs)
//
// Ports scripts/stage-default-envs.sh: solve each default env with micromamba, normalize the
// `list --explicit --md5` output into a valid @EXPLICIT lock, and collect the referenced tarballs.
// Tarballs are inert data (not mach-O) and ship as extraResources / CDN assets — no per-file signing.
// Requires micromamba on PATH or MICROMAMBA_BIN; if absent it prints guidance and exits 0 (non-fatal),
// so non-packaging builds still succeed. CDN upload of the produced bundle is out of scope here — the
// website-distribution pipeline (2026-07-12 design) publishes resources/default-envs/** to the CDN.
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url))
const OUT = join(SCRIPT_DIR, '..', 'resources', 'default-envs')
const PKGS = join(OUT, 'pkgs')
const CHANNEL = 'conda-forge'

// Keep in sync with DEFAULT_PYTHON_SPEC / DEFAULT_R_SPEC in src/main/notebook/provisioner.ts (spec §4).
// Duplicated here (rather than imported) so this script has no dependency on the built app; a guard
// test (stage-default-envs.test.ts) fails CI if these drift from provisioner.ts's specs.
export const PY_PKGS = [
  'python=3.12',
  'numpy',
  'pandas',
  'scipy',
  'matplotlib-base',
  'nomkl',
  'plotly',
  'openpyxl'
]
export const R_PKGS = ['r-base', 'r-jsonlite', 'r-ggplot2', 'r-dplyr', 'r-openxlsx']

// Normalizes raw `micromamba list --explicit --md5` output into a valid @EXPLICIT lock (spec §2.5).
// Mirrors src/main/notebook/micromamba.ts::normalizeExplicitLock.
export const normalizeExplicitLock = (rawListExplicit) =>
  [
    '@EXPLICIT',
    ...rawListExplicit
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^https?:\/\//.test(l))
  ].join('\n') + '\n'

// The tarball filenames referenced by an @EXPLICIT lock (basename of each package URL).
export const packageFilesFromLock = (lockText) =>
  lockText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\//.test(l))
    .map((l) => {
      const url = l.split('#')[0]
      return url.slice(url.lastIndexOf('/') + 1)
    })

// The { url, file } entries referenced by an @EXPLICIT lock — url is the full download URL (md5
// stripped), file its basename. Used to fetch tarballs straight from the lock when not in a cache.
export const packageEntriesFromLock = (lockText) =>
  lockText
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /^https?:\/\//.test(l))
    .map((l) => {
      const url = l.split('#')[0]
      return { url, file: url.slice(url.lastIndexOf('/') + 1) }
    })

// Downloads a URL to destPath (public conda-forge archives; content-addressed, so deterministic).
const download = async (url, destPath) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error(`download failed ${res.status}: ${url}`)
  writeFileSync(destPath, Buffer.from(await res.arrayBuffer()))
}

// Solves one default env for the target platform via a micromamba `create --dry-run --json`, builds an
// @EXPLICIT lock from the solved package set (url#md5 per package), and downloads each referenced
// tarball into resources/default-envs/pkgs (skipping ones a previous env already fetched). Solving
// (not a full create) with an explicit --platform lets a single host stage ANY platform's bundle —
// e.g. osx-64 solved on an Apple-silicon runner — so staging needs no native runner per platform and
// never links/executes foreign-arch binaries.
const stageEnv = async (mm, stagingRoot, name, pkgs, platform) => {
  console.log(`[stage-default-envs] solving ${name} (${platform || 'native'}): ${pkgs.join(' ')}`)
  const platformArgs = platform ? ['--platform', platform] : []
  const raw = execFileSync(
    mm,
    [
      'create',
      '--dry-run',
      '--json',
      '--prefix',
      join(stagingRoot, name),
      '-y',
      '-c',
      CHANNEL,
      ...platformArgs,
      ...pkgs
    ],
    { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 }
  )
  const solved = JSON.parse(raw)
  const fetched = (solved.actions && solved.actions.FETCH) || []
  if (fetched.length === 0) throw new Error(`solve produced no packages for ${name}`)
  const lock = '@EXPLICIT\n' + fetched.map((p) => `${p.url}#${p.md5}`).join('\n') + '\n'
  writeFileSync(join(OUT, `${name}.lock`), lock)
  for (const { url, file } of packageEntriesFromLock(lock)) {
    const dest = join(PKGS, file)
    if (existsSync(dest)) continue
    try {
      await download(url, dest)
    } catch (err) {
      console.warn(`[stage-default-envs] WARN: could not obtain tarball ${file}: ${err.message}`)
    }
  }
}

const main = async () => {
  const mm = process.env.MICROMAMBA_BIN ?? ''
  if (!mm || !existsSync(mm)) {
    console.log(
      '[stage-default-envs] MICROMAMBA_BIN not set/found — skipping default-env staging. ' +
        'Install micromamba and set MICROMAMBA_BIN to its path to produce resources/default-envs.'
    )
    return
  }
  // Target conda subdir to solve for (e.g. osx-64 on an arm64 runner). Empty = the host's native subdir.
  const platform = process.env.OS_STAGE_PLATFORM ?? ''
  // A rerun must not carry obsolete tarballs from an older package spec into the new bundle.
  rmSync(OUT, { recursive: true, force: true })
  mkdirSync(PKGS, { recursive: true })
  const stagingRoot = mkdtempSync(join(tmpdir(), 'os-stage-'))
  await stageEnv(mm, stagingRoot, 'default-python', PY_PKGS, platform)
  await stageEnv(mm, stagingRoot, 'default-r', R_PKGS, platform)
  console.log('[stage-default-envs] staged locks + tarballs into resources/default-envs')
}

// CLI entry: only runs when the file is executed directly, not when imported by the test (mirrors
// scripts/generate-version-manifest.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('[stage-default-envs] failed:', err)
    process.exit(1)
  })
}
