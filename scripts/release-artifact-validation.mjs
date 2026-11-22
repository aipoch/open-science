/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { createHash } from 'node:crypto'
import { closeSync, openSync, readSync, statSync } from 'node:fs'
import { gunzipSync } from 'node:zlib'
import { join } from 'node:path'

// Release installers can exceed a gigabyte. Keep hashing bounded without changing the synchronous
// manifest API used by the CLI and its consumers.
export function artifactHash(file, algorithm, encoding = 'hex') {
  const fd = openSync(file, 'r')
  try {
    const hash = createHash(algorithm)
    const buffer = Buffer.alloc(1024 * 1024)
    let length
    while ((length = readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      hash.update(buffer.subarray(0, length))
    }
    return hash.digest(encoding)
  } finally {
    closeSync(fd)
  }
}

export function validateArtifactName(name, version, allowLegacyNames = false) {
  if (
    typeof name !== 'string' ||
    /[/\\\r\n]/.test(name) ||
    !(
      name.startsWith(`aipoch-open-science-${version}-`) ||
      name.startsWith(`aipoch-open-science_${version}_`) ||
      (allowLegacyNames &&
        (name.startsWith(`open-science-${version}-`) ||
          name.startsWith(`open-science_${version}_`)))
    )
  ) {
    throw new Error(`Artifact name does not match release ${version}: ${name}`)
  }
}

export function validateUpdateFeed(
  feed,
  dir,
  version,
  metadataOnly = false,
  allowLegacyNames = false
) {
  if (feed?.version !== version || !Array.isArray(feed.files) || feed.files.length === 0) {
    throw new Error(`Invalid update feed for release ${version}`)
  }
  const seen = new Set()
  for (const file of feed.files) {
    validateArtifactName(file.url, version, allowLegacyNames)
    if (seen.has(file.url)) throw new Error(`Duplicate feed artifact: ${file.url}`)
    seen.add(file.url)
    const stat = statSync(join(dir, file.url))
    if (
      !stat.isFile() ||
      !Number.isSafeInteger(file.size) ||
      file.size <= 0 ||
      file.size !== stat.size
    ) {
      throw new Error(`Feed artifact size mismatch: ${file.url}`)
    }
    if (typeof file.sha512 !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(file.sha512)) {
      throw new Error(`Invalid feed SHA512: ${file.url}`)
    }
    if (!metadataOnly && artifactHash(join(dir, file.url), 'sha512', 'base64') !== file.sha512) {
      throw new Error(`Feed artifact SHA512 mismatch: ${file.url}`)
    }
  }
  if (feed.path !== undefined || feed.sha512 !== undefined) {
    const legacy = feed.files.find((file) => file.url === feed.path)
    if (!legacy || legacy.sha512 !== feed.sha512)
      throw new Error('Legacy feed fields disagree with files')
  }
  return feed
}

// electron-builder's external ZIP blockmap describes a single file starting at offset zero.
export function validateMacBlockmap(bytes, label, zipSize) {
  try {
    const map = JSON.parse(gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }))
    const [file] = map.files
    if (
      map.version === '2' &&
      map.files.length === 1 &&
      file.name === 'file' &&
      file.offset === 0 &&
      Array.isArray(file.sizes) &&
      file.sizes.length > 0 &&
      file.sizes.every((size) => Number.isSafeInteger(size) && size > 0) &&
      Array.isArray(file.checksums) &&
      file.sizes.length === file.checksums.length &&
      file.checksums.every((value) => typeof value === 'string' && value.length > 0) &&
      (zipSize === undefined || file.sizes.reduce((total, size) => total + size, 0) === zipSize)
    )
      return
  } catch (cause) {
    throw new Error(`Invalid macOS ZIP blockmap: ${label}`, { cause })
  }
  throw new Error(`Invalid macOS ZIP blockmap: ${label}`)
}
