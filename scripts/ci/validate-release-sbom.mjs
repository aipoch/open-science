/* eslint-disable @typescript-eslint/explicit-function-return-type */

import { createHash } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { basename, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const requiredPackages = [
  { id: 'prisma-client', label: 'packaged Prisma client', name: '@prisma/client' },
  { id: 'sharp', label: 'unpacked native dependency', name: 'sharp' },
  { id: 'zod', label: 'representative app.asar dependency', name: 'zod' }
]

const normalizeName = (value) => value.toLowerCase().replace(/[^a-z0-9]/g, '')

async function sha256(path) {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk)
  return hash.digest('hex')
}

export async function validateReleaseSbom({ artifactPath, sbomPath, tag }) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`Expected a stable vMAJOR.MINOR.PATCH tag, received ${tag}`)
  }

  const version = tag.slice(1)
  const artifact = basename(artifactPath)
  if (!artifact.endsWith('-mac-arm64.zip') || !artifact.includes(`-${version}-`)) {
    throw new Error(`Artifact ${artifact} does not match stable release ${tag}`)
  }

  const document = JSON.parse(await readFile(sbomPath, 'utf8'))
  if (!/^SPDX-2\./.test(document.spdxVersion ?? '')) {
    throw new Error(`Expected an SPDX 2.x document, received ${document.spdxVersion ?? 'unknown'}`)
  }
  if (document.dataLicense !== 'CC0-1.0' || !document.documentNamespace) {
    throw new Error('SPDX document metadata is incomplete')
  }
  if (!Array.isArray(document.packages)) throw new Error('SPDX document has no packages array')

  const packages = document.packages.filter(
    (entry) => entry && typeof entry.name === 'string' && entry.name.length > 0
  )
  const packageNames = new Set(packages.map(({ name }) => name.toLowerCase()))
  const appPackage = packages.find(({ name }) => normalizeName(name) === 'openscience')
  const checks = [
    {
      id: 'application',
      label: 'packaged application identity and version',
      expected: `Open-Science ${version}`,
      matched: appPackage ? `${appPackage.name} ${appPackage.versionInfo ?? '(no version)'}` : null,
      ok: appPackage?.versionInfo === version
    },
    ...requiredPackages.map(({ id, label, name }) => ({
      id,
      label,
      expected: name,
      matched: packageNames.has(name) ? name : null,
      ok: packageNames.has(name)
    }))
  ]

  return {
    schemaVersion: 1,
    releaseTag: tag,
    releaseVersion: version,
    artifact,
    artifactSha256: await sha256(artifactPath),
    spdxVersion: document.spdxVersion,
    packageCount: packages.length,
    checks,
    complete: checks.every(({ ok }) => ok)
  }
}

export function formatCoverageMarkdown(result) {
  const rows = result.checks.map(
    ({ expected, label, matched, ok }) =>
      `| ${ok ? '✅' : '❌'} | ${label} | \`${expected}\` | ${matched ? `\`${matched}\`` : '—'} |`
  )
  return [
    '## Release SBOM PoC',
    '',
    `- Release: \`${result.releaseTag}\``,
    `- Final archive: \`${result.artifact}\``,
    `- Archive SHA-256: \`${result.artifactSha256}\``,
    `- SPDX packages: ${result.packageCount}`,
    '',
    '| Result | Coverage boundary | Expected | Matched |',
    '| --- | --- | --- | --- |',
    ...rows,
    '',
    result.complete
      ? '**PoC result:** representative final-package coverage is complete.'
      : '**PoC result:** representative final-package coverage is incomplete.',
    '',
    result.complete
      ? 'This evidence is still advisory until the publication design is approved.'
      : 'Custom SBOM composition is required before publication or attestation.',
    '',
    'This advisory PoC does not fail the release, publish a release asset, or create an attestation.'
  ].join('\n')
}

function parseArguments(argv) {
  const values = {}
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]
    const value = argv[index + 1]
    if (!key?.startsWith('--') || !value) throw new Error(`Invalid argument: ${key ?? '(missing)'}`)
    values[key.slice(2)] = value
  }
  for (const key of ['artifact', 'output', 'sbom', 'tag']) {
    if (!values[key]) throw new Error(`Missing --${key}`)
  }
  return values
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv)
  const result = await validateReleaseSbom({
    artifactPath: options.artifact,
    sbomPath: options.sbom,
    tag: options.tag
  })
  await writeFile(options.output, `${JSON.stringify(result, null, 2)}\n`)
  process.stdout.write(`${formatCoverageMarkdown(result)}\n`)
  return 0
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main()
    .then((exitCode) => {
      process.exitCode = exitCode
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.message : error)
      process.exitCode = 1
    })
}
