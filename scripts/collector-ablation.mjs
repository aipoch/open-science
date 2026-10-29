import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const substitutions = {
  'no-doi-index-backfill': [
    {
      file: 'src/main/database/migration-service.ts',
      from: 'await backfillLiteratureDoiIdentity(transaction)',
      to: 'void 0'
    }
  ],
  'no-doi-index-staging': [
    {
      file: 'src/main/database/migrations/0053-literature-doi-identity.ts',
      from: 'for (const temporary of [true, false])',
      to: 'for (const temporary of [false])'
    }
  ],
  'no-doi-staging-key-proof': [
    {
      file: 'src/main/database/migrations/0053-literature-doi-identity.ts',
      from: 'if (!collision.length) break',
      to: 'if (true) break'
    }
  ],
  'no-ascii-doi-key': [
    {
      file: 'packages/literature-citations/src/doi.ts',
      from: 'normalizeLiteratureDoiValueV1(value).replace(/[A-Z]/g, (letter) => letter.toLowerCase())',
      to: 'normalizeLiteratureDoiValueV1(value).toLowerCase()'
    }
  ],
  'no-doi-nfkc-boundary': [
    {
      file: 'packages/literature-library/src/identity.ts',
      from: "if (scheme === 'doi') return normalizeLiteratureIdentifierKey('doi', rawValue)",
      to: "if (scheme === 'doi') return normalizeLiteratureIdentifierKey('doi', normalizeSpace(rawValue))"
    }
  ],
  'no-doi-search-boundary': [
    {
      file: 'src/main/literature/catalog.ts',
      from: 'const identifiers = searchIdentifiers(text)',
      to: 'const identifiers = searchIdentifiers(normalizeSpace(text))'
    }
  ],
  'no-doi-path-encoding': [
    {
      file: 'packages/literature-citations/src/contracts.ts',
      from: 'encodeURIComponent(parts[2])',
      to: "parts[2].split('/').map(encodeURIComponent).join('/')"
    }
  ],
  'no-dot-only-rejection': [
    {
      file: 'packages/literature-citations/src/contracts.ts',
      from: "if (!parts || parts[2] === '.' || parts[2] === '..') return undefined",
      to: 'if (!parts) return undefined'
    }
  ],
  'no-doi-suffix-preservation': [
    {
      file: 'packages/literature-citations/src/doi.ts',
      from: 'if (path === undefined) return candidate',
      to: "if (path === undefined) return candidate.replace(/Copyright(?:\\s.*)?$/iu, '').replace(/[.,;:)}\\]]+$/gu, '').trim()"
    }
  ],
  'no-doi-url-decoding': [
    {
      file: 'packages/literature-citations/src/doi.ts',
      from: 'return decodeURIComponent(path)',
      to: 'return path'
    }
  ],
  'decode-bare-doi': [
    {
      file: 'packages/literature-citations/src/doi.ts',
      from: 'if (path === undefined) return candidate',
      to: 'if (path === undefined) return decodeURIComponent(candidate)'
    }
  ],
  'no-pdf-explicit-doi': [
    {
      file: 'src/renderer/src/pages/literature/imports/literature-pdf-metadata.ts',
      from: 'const embeddedDoi = [info.DOI, custom.DOI]',
      to: 'const embeddedDoi = [undefined]'
    }
  ],
  'no-pdf-text-cleanup': [
    {
      file: 'src/renderer/src/pages/literature/imports/literature-pdf-metadata.ts',
      from: "    .replace(/Copyright(?:\\s.*)?$/iu, '')",
      to: ''
    }
  ],
  'no-unpaywall-doi-links': [
    {
      file: 'packages/literature-discovery/src/full-text-sources.ts',
      from: "entry.url_for_landing_page || createLiteratureIdentifierUrl('doi', doi)",
      to: 'entry.url_for_landing_page || `https://doi.org/${doi}`'
    }
  ],
  'no-openalex-doi-links': [
    {
      file: 'packages/literature-discovery/src/full-text-finder.ts',
      from: "const doiUrl = doi ? createLiteratureIdentifierUrl('doi', doi) : undefined",
      to: 'const doiUrl = doi ? `https://doi.org/${doi}` : undefined'
    }
  ],
  'no-collection-collision-check': [
    {
      file: 'src/main/literature/collector.ts',
      from: 'owner !== undefined && owner !== sourceKeys[index]',
      to: 'false'
    }
  ],
  'no-collection-canonicalization': [
    {
      file: 'src/main/literature/collector.ts',
      from: 'path.slice(0, index + 1).map(normalizeLiteratureSearchTextV1)',
      to: 'path.slice(0, index + 1)'
    }
  ],
  'no-publisher-place': [
    {
      file: 'src/main/literature/collector.ts',
      from: 'publisherPlace: text(data.place)',
      to: 'place: text(data.place)'
    }
  ],
  'no-publisher-aliases': [
    {
      file: 'src/main/literature/collector.ts',
      from: "text(type === 'thesis' ? data.university : type === 'report' ? data.institution : '')",
      to: "''"
    }
  ],
  'no-patent-date': [
    {
      file: 'src/main/literature/collector.ts',
      from: "type === 'patent' ? text(data.issueDate) : ''",
      to: "''"
    }
  ],
  'no-patent-role': [
    {
      file: 'src/main/literature/collector.ts',
      from: "type === 'patent' && role === 'inventor' ? 'author' : role",
      to: 'role'
    }
  ],
  'no-access-date': [
    {
      file: 'src/main/literature/collector.ts',
      from: 'Number.isFinite(accessedAt) && accessedAt >= 0',
      to: 'false'
    }
  ],
  'no-access-date-validation': [
    {
      file: 'src/main/literature/collector.ts',
      from: '? Date.parse(accessDate)\n          : NaN',
      to: '? Date.parse(accessDate)\n          : Date.parse(accessDate)'
    }
  ],
  'no-completed-pdfs': [
    {
      file: 'src/main/literature/collector.ts',
      from: 'if (committed.completedPdfs.has(pdfIdentity)) continue',
      to: 'if (false) continue'
    }
  ],
  'no-pdf-revision': [
    {
      file: 'src/main/literature/pdf-attachment.ts',
      from: 'request.expectedMetadataRevision === undefined',
      to: 'true'
    }
  ],
  'no-final-revisions': [
    {
      file: 'src/main/literature/catalog.ts',
      from: 'const revision = revisions.get(id)',
      to: 'const revision = 0'
    }
  ],
  'no-date-coherence': [
    {
      file: 'packages/literature-library/src/duplicate-metadata.ts',
      from: 'dateYear !== fields.issuedYear',
      to: 'false'
    }
  ],
  'no-report-timeout-check': [
    { file: 'scripts/collector-ablation.mjs', from: ['!timedOut', ' &&'].join(''), to: 'true &&' }
  ],
  'late-snapshot-replacement': [
    {
      file: 'src/main/literature/collector.ts',
      from: 'if (replacedId) this.snapshots.delete(replacedId)',
      to: 'void 0'
    },
    {
      file: 'src/main/literature/collector.ts',
      from: 'const snapshotId = randomUUID()',
      to: 'if (replacedId) this.snapshots.delete(replacedId)\n    const snapshotId = randomUUID()'
    }
  ],
  'comment-control': [
    {
      file: 'src/main/literature/collector.ts',
      from: '// Never accept a URL, filesystem path, or redirect target from the renderer.',
      to: '// Control: no behavioral change.\n// Never accept a URL, filesystem path, or redirect target from the renderer.'
    }
  ],
  'no-report-suite-check': [
    {
      file: 'scripts/collector-ablation.mjs',
      from: ['!suite.message?', '.trim()'].join(''),
      to: 'true'
    }
  ],
  'no-report-unhandled-check': [
    {
      file: 'scripts/collector-ablation.mjs',
      from: ['/Unhandled Errors?|Unhandled Rejection|Uncaught Exception/i.', 'test('].join(''),
      to: ['false && /Unhandled Errors?|Unhandled Rejection|Uncaught Exception/i.', 'test('].join(
        ''
      )
    }
  ],
  'no-published-pdf-size': [
    {
      file: 'src/main/literature/pdf-attachment.ts',
      from: 'request.maxBytes !== undefined && content.sizeBytes > BigInt(request.maxBytes)',
      to: 'false'
    }
  ],
  'no-published-pdf-header': [
    {
      file: 'src/main/literature/pdf-attachment.ts',
      from: 'await assertPdfHeader(content.path)',
      to: 'void 0'
    }
  ],
  'no-pdf-parsing': [
    {
      file: 'src/main/literature/pdf-attachment.ts',
      from: 'content.sizeBytes <= BigInt(MAX_AUTO_EXTRACT_PDF_BYTES)',
      to: 'false'
    }
  ],
  'no-pdf-cleanup': [
    {
      file: 'src/main/literature/pdf-attachment.ts',
      from: 'if (publishedId && !attached)',
      to: 'if (false)'
    }
  ],
  'no-tag-normalization': [
    {
      file: 'src/main/tags/tag-write.ts',
      from: "input.normalize('NFKC').trim()",
      to: 'input.trim()'
    }
  ],
  'no-tag-append-order': [
    {
      file: 'src/main/tags/tag-write.ts',
      from: 'sortOrder: (last?.sortOrder ?? 0) + 1',
      to: 'sortOrder: 0'
    }
  ],
  'no-tag-reuse': [
    {
      file: 'src/main/tags/tag-write.ts',
      from: '(await client.tag.findUnique({ where: { nameKey } })) ??',
      to: 'undefined ??'
    }
  ],
  'no-frozen-preview': [
    {
      file: 'src/main/literature/collector.ts',
      from: 'const snapshot = this.snapshots.get(request.snapshotId)',
      to: 'const fresh = await this.preview(); const snapshot = this.snapshots.get(fresh.snapshotId!)'
    }
  ],
  'no-pdf-isolation': [
    {
      file: 'src/main/literature/collector.ts',
      from: "result.failures.push({\n                key,\n                message: error instanceof Error ? error.message : 'PDF copy failed.'\n              })",
      to: 'throw error'
    }
  ],
  'no-transaction': [
    {
      file: 'src/main/literature/catalog.ts',
      from: 'if (!this.onChanged && !this.smart) return client.$transaction(operation, transactionOptions)',
      to: 'if (!this.onChanged && !this.smart) return operation(client as unknown as Prisma.TransactionClient)'
    },
    {
      file: 'src/main/literature/catalog.ts',
      from: 'const committed = await client.$transaction(async (transaction) => {',
      to: 'const committed = await (async (transaction: Prisma.TransactionClient) => {'
    },
    {
      file: 'src/main/literature/catalog.ts',
      from: '    }, transactionOptions)\n    if (committed.changed)',
      to: '    })(client as unknown as Prisma.TransactionClient)\n    if (committed.changed)'
    }
  ],
  'no-identifier-consistency': [
    {
      file: 'packages/literature-library/src/identity.ts',
      from: 'if (targets.length > 1 || contradictory || disagrees)',
      to: 'if (targets.length > 1 || contradictory)'
    }
  ],
  'no-metadata-review': [
    {
      file: 'src/main/literature/catalog.ts',
      from: 'const metadataChanged = matches.some(',
      to: 'const metadataChanged = false && matches.some('
    }
  ],
  'no-revision-invalidation': [
    {
      file: 'src/main/literature/collector.ts',
      from: 'if (replacedId) this.snapshots.delete(replacedId)',
      to: 'void 0'
    }
  ],
  'no-all-source-owners': [
    {
      file: 'src/main/literature/catalog.ts',
      from: 'const owners = sourceRecords.flatMap(',
      to: 'const owners = sourceRecords.slice(0, 1).flatMap('
    }
  ],
  'no-collector-policy': [
    {
      file: 'src/main/literature/catalog.ts',
      from: 'const policy = modes[inputIndex]',
      to: "const policy = 'reuse'"
    }
  ],
  'no-review-metadata-revision': [
    { file: 'src/main/literature/catalog.ts', from: 'record.metadataRevision,', to: 'undefined,' }
  ],
  'no-reviewed-target-check': [
    {
      file: 'src/main/literature/catalog.ts',
      from: 'if (reviewed) {',
      to: 'if (false && reviewed) {'
    }
  ],
  'no-metadata-receipt': [
    {
      file: 'src/main/literature/collector.ts',
      from: 'const committed = snapshot.committed ?? {',
      to: 'const committed = undefined ?? {'
    }
  ],
  'no-preview-classification': [
    {
      file: 'src/main/literature/catalog.ts',
      from: 'return result\n      },\n      { timeout: 60_000 }',
      to: "return result.map((entry) => ({ ...entry, status: 'new' as const, reason: 'new' as const }))\n      },\n      { timeout: 60_000 }"
    }
  ],
  'no-source-identity': [
    {
      file: 'src/main/literature/catalog.ts',
      from: 'const resolution = importIdentity(\n    identities,\n    item,\n    prior?.itemId ?? sourceTarget,\n    owners.map(({ itemId }) => itemId)\n  )',
      to: 'const resolution = importIdentity(identities, item)'
    }
  ],
  'no-library-version': [
    {
      file: 'src/main/literature/collector.ts',
      from: 'version !== undefined && version !== nextVersion',
      to: 'false'
    }
  ],
  'no-pdf-integrity': [
    {
      file: 'src/main/literature/pdf-attachment.ts',
      from: "if ((await options.content.verify(content.id)).state !== 'available')",
      to: 'if (false)'
    }
  ]
}
export const variants = [
  'baseline',
  'comment-control',
  'no-doi-index-backfill',
  'no-doi-index-staging',
  'no-doi-staging-key-proof',
  'no-ascii-doi-key',
  'no-doi-nfkc-boundary',
  'no-doi-search-boundary',
  'no-doi-path-encoding',
  'no-dot-only-rejection',
  'no-doi-suffix-preservation',
  'no-doi-url-decoding',
  'decode-bare-doi',
  'no-pdf-explicit-doi',
  'no-pdf-text-cleanup',
  'no-unpaywall-doi-links',
  'no-openalex-doi-links',
  'no-collection-collision-check',
  'no-collection-canonicalization',
  'no-report-suite-check',
  'no-report-unhandled-check',
  'no-report-timeout-check',
  'no-transaction',
  'no-source-identity',
  'no-preview-classification',
  'no-reviewed-target-check',
  'no-metadata-receipt',
  'no-metadata-review',
  'no-revision-invalidation',
  'late-snapshot-replacement',
  'no-date-coherence',
  'no-publisher-place',
  'no-publisher-aliases',
  'no-patent-date',
  'no-patent-role',
  'no-access-date',
  'no-access-date-validation',
  'no-completed-pdfs',
  'no-pdf-revision',
  'no-final-revisions',
  'no-all-source-owners',
  'no-collector-policy',
  'no-review-metadata-revision',
  'no-identifier-consistency',
  'no-library-version',
  'no-pdf-integrity',
  'no-frozen-preview',
  'no-pdf-isolation',
  'no-published-pdf-size',
  'no-published-pdf-header',
  'no-pdf-parsing',
  'no-pdf-cleanup',
  'no-tag-normalization',
  'no-tag-append-order',
  'no-tag-reuse'
]
// A mutant is detected only by its specified behavioral counterexample.
export const witnesses = {
  'no-doi-index-backfill': 'rebuilds DOI keys from retained Unicode raw values',
  'no-doi-index-staging': 'moves DOI keys without transient collisions',
  'no-doi-staging-key-proof': 'moves DOI keys without transient collisions',
  'no-ascii-doi-key': 'keeps distinct Unicode DOI keys distinct',
  'no-doi-nfkc-boundary': 'Unicode width remains distinct',
  'no-doi-search-boundary': 'searches DOI Unicode width',
  'no-doi-path-encoding': 'preserves opaque path segments after navigating',
  'no-dot-only-rejection': 'preserves a pure dot DOI suffix',
  'no-doi-suffix-preservation': 'preserves the opaque DOI suffix',
  'no-doi-url-decoding': 'the Crossref encoded resolver URL',
  'decode-bare-doi': 'a raw literal percent sequence',
  'no-pdf-explicit-doi': 'preserves an explicit embedded DOI before scanning other text',
  'no-pdf-text-cleanup': 'does not include adjacent copyright text',
  'no-unpaywall-doi-links': 'decodes resolver DOI identity once while retaining opaque suffixes',
  'no-openalex-doi-links': 'encodes opaque DOI suffixes in OpenAlex filters',
  'no-collection-collision-check': 'rejects colliding Zotero collection paths: same name',
  'no-collection-canonicalization': 'rejects colliding Zotero collection paths: NFKC',
  'no-publisher-place': 'maps Zotero publisher aliases',
  'no-publisher-aliases': 'maps Zotero publisher aliases',
  'no-patent-date': 'preserves patent issue dates',
  'no-patent-role': 'preserves patent issue dates',
  'no-access-date': 'maps the Zotero access date',
  'no-access-date-validation': '2024-02-30T12:00:00Z',
  'no-completed-pdfs': 'only failed PDFs',
  'no-pdf-revision': 'rejects an outdated PDF target edited during',
  'no-final-revisions': 'returns final revisions',
  'no-report-timeout-check': 'rejects an infrastructure timeout',
  'late-snapshot-replacement': 'revised snapshot at capacity',
  'no-date-coherence': 'preserves local citation year',
  'no-metadata-review': 'requires review for authors differences',
  'no-revision-invalidation': 'revises only frozen metadata while preserving source',
  'no-all-source-owners': 'checks every DOI-less source owner',
  'no-collector-policy': 'keeps a separate copy of a corrected conflicting source',
  'no-review-metadata-revision': 'rejects a changed local revision after review',
  'no-reviewed-target-check':
    'requires renewed review when a previously safe reuse is moved to Trash',
  'no-metadata-receipt': 'retries a repaired PDF without repeating the successful metadata write',
  'no-preview-classification': 'previews collector identities without writes',
  'no-report-suite-check': 'rejects a witness mixed with a suite diagnostic',
  'no-report-unhandled-check': 'rejects a witness mixed with an unhandled exception',
  'no-transaction': 'records when any source is invalid (notifications: true)',
  'no-source-identity': 'collects source identity, tags and nested collections',
  'no-identifier-consistency':
    'rejects Zotero source reuse when an unseen DOI contradicts its item',
  'no-library-version': 'rejects library changes, unknown keys',
  'no-pdf-integrity': 'keeps references and cleans unattached content after PDF verify failure',
  'no-frozen-preview': 'commits the reviewed metadata even if Zotero changes',
  'no-pdf-isolation': 'keeps saved references and reports unsafe PDF locations',
  'no-published-pdf-size': 'rejects published PDF size changes after source preflight',
  'no-published-pdf-header': 'rejects published PDF header changes after source preflight',
  'no-pdf-parsing': 'keeps references and cleans unattached content after PDF parse failure',
  'no-pdf-cleanup': 'keeps references and cleans unattached content after PDF parse failure',
  'no-tag-normalization': 'shares manual tag identity and global ordering',
  'no-tag-append-order': 'shares manual tag identity and global ordering',
  'no-tag-reuse': 'shares manual tag identity and global ordering'
}
export const sources = [
  '.nvmrc',
  'package.json',
  'package-lock.json',
  'src/main/literature/collector.ts',
  'src/main/literature/catalog.ts',
  'packages/literature-library/src/identity.ts',
  'packages/literature-library/src/duplicate-metadata.ts',
  'packages/literature-library/src/index.ts',
  'packages/literature-library/src/item.ts',
  'packages/literature-library/src/contracts.ts',
  'packages/literature-library/src/importer.ts',
  'packages/literature-library/package.json',
  'packages/literature-library/vitest.config.ts',
  'packages/literature-citations/src/contracts.ts',
  'packages/literature-citations/src/doi.ts',
  'packages/literature-citations/src/csl.ts',
  'packages/literature-citations/package.json',
  'packages/literature-citations/vitest.config.ts',
  'packages/literature-discovery/src/identifiers.ts',
  'packages/literature-discovery/src/full-text-sources.ts',
  'packages/literature-discovery/src/full-text-finder.ts',
  'packages/literature-discovery/package.json',
  'packages/literature-discovery/vitest.config.ts',
  'src/shared/literature.ts',
  'src/main/database/migrations/0053-literature-doi-identity.ts',
  'src/main/database/migration-service.ts',
  'src/renderer/src/pages/literature/duplicates/literature-merge.ts',
  'src/shared/literature-collector.ts',
  'src/shared/literature-search-text.ts',
  'src/renderer/src/pages/literature/imports/literature-pdf-metadata.ts',
  'src/main/literature/pdf-attachment.ts',
  'src/main/literature/pdf-importer.ts',
  'src/main/tags/tag-write.ts',
  'vitest.config.ts'
]
export const testFiles = [
  'src/main/database/literature-doi-identity-migration.test.ts',
  'src/renderer/src/pages/literature/duplicates/literature-merge.test.ts',
  'packages/literature-citations/test/contracts.test.ts',
  'src/renderer/src/pages/literature/imports/literature-pdf-metadata.test.ts',
  'packages/literature-discovery/test/full-text-sources.test.ts',
  'packages/literature-discovery/test/full-text-finder.test.ts',
  'scripts/collector-ablation.test.ts',
  'src/main/literature/collector.test.ts',
  'src/main/literature/collector-identity.test.ts',
  'packages/literature-library/test/duplicate-metadata.test.ts',
  'src/shared/literature-collector.test.ts',
  'src/main/literature/catalog.test.ts',
  'src/main/literature/pdf-importer.test.ts',
  'src/main/literature/pdf-attachment-reliability.test.ts'
]

// Fail before starting a process if a moved mechanism is unhashed or its exact edit has drifted.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Native JavaScript experiment validator.
export function validateAblationInputs(readSource = (file) => readFileSync(file, 'utf8')) {
  const evidence = new Set([
    ...sources,
    ...testFiles,
    'scripts/collector-ablation.mjs',
    'test/experiments/collector-ablation.config.ts'
  ])
  for (const file of evidence) readSource(file)
  const mutants = variants.filter((variant) => !['baseline', 'comment-control'].includes(variant))
  if (mutants.length !== 53 || new Set(variants).size !== variants.length)
    throw new Error('Ablation variant inventory changed; review the experiment definition.')
  if (
    JSON.stringify(Object.keys(substitutions).sort()) !==
      JSON.stringify(variants.filter((name) => name !== 'baseline').sort()) ||
    JSON.stringify(Object.keys(witnesses).sort()) !== JSON.stringify([...mutants].sort())
  )
    throw new Error('Ablation edits and named witnesses do not match the variant inventory.')
  for (const variant of variants.filter((name) => name !== 'baseline')) {
    if (!substitutions[variant]?.length || (variant !== 'comment-control' && !witnesses[variant]))
      throw new Error(`Missing ablation definition: ${variant}`)
    const transformed = new Map()
    for (const { file, from, to } of substitutions[variant]) {
      if (!evidence.has(file)) throw new Error(`Unhashed ablation source: ${variant}: ${file}`)
      const code = transformed.get(file) ?? readSource(file)
      if (code.split(from).length !== 2)
        throw new Error(`Ablation anchor drift: ${variant}: ${file}`)
      transformed.set(file, code.replace(from, to))
    }
  }
  return mutants.length
}

// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Native JavaScript experiment validator.
export function missingAblationWitnesses(executed, required = Object.values(witnesses)) {
  return required.filter((witness) => !executed.some((name) => name.includes(witness)))
}

// Inspect evidence independently of process execution so malformed reports can be falsified.
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Native JavaScript CLI; the report shape is checked at runtime.
export function inspectAblationReport({
  data,
  result,
  expectedTests = [],
  expectedFiles = [],
  witness
}) {
  const suites = Array.isArray(data?.testResults) ? data.testResults : []
  const assertions = suites.flatMap((suite) =>
    Array.isArray(suite.assertionResults) ? suite.assertionResults : []
  )
  const failures = assertions
    .filter((test) => test.status === 'failed')
    .map((test) => test.fullName)
  const executed = assertions
    .filter((test) => ['passed', 'failed'].includes(test.status))
    .map((test) => test.fullName)
    .sort()
  const expected = expectedTests
  const cleanSuites =
    suites.length > 0 &&
    suites.every(
      (suite) =>
        Array.isArray(suite.assertionResults) &&
        !suite.message?.trim() &&
        (suite.status === 'passed' ||
          (suite.status === 'failed' &&
            suite.assertionResults.some(
              (test) => test.status === 'failed' && test.failureMessages?.length > 0
            )))
    )
  const unhandled = /Unhandled Errors?|Unhandled Rejection|Uncaught Exception/i.test(
    result.stderr ?? ''
  )
  const timedOut = assertions.some((test) =>
    test.failureMessages?.some((message) => /(?:Test|Hook) timed out in \d+ms/i.test(message))
  )
  const filesMatch =
    JSON.stringify(suites.map((suite) => resolve(suite.name)).sort()) ===
    JSON.stringify(expectedFiles.map((file) => resolve(file)).sort())
  const valid = Boolean(
    !result.error &&
    !result.signal &&
    cleanSuites &&
    filesMatch &&
    !unhandled &&
    !timedOut &&
    !data?.unhandledErrors?.length &&
    executed.length > 0 &&
    (expected.length === 0 || JSON.stringify(executed) === JSON.stringify(expected)) &&
    (witness
      ? result.status === 1 &&
        data.success === false &&
        failures.some((name) => name.includes(witness))
      : result.status === 0 && data.success === true && failures.length === 0)
  )
  return { valid, failures, executed }
}
// eslint-disable-next-line @typescript-eslint/explicit-function-return-type -- Native JavaScript CLI entry point.
function main() {
  const requiredNodeMajor = readFileSync('.nvmrc', 'utf8').trim().replace(/^v/, '')
  if (process.versions.node.split('.')[0] !== requiredNodeMajor)
    throw new Error(`Ablation requires the repository Node ${requiredNodeMajor} toolchain.`)
  validateAblationInputs()
  const evidenceFiles = [
    ...sources,
    ...testFiles,
    'scripts/collector-ablation.mjs',
    'test/experiments/collector-ablation.config.ts'
  ]
  const evidenceHashes = Object.fromEntries(
    evidenceFiles.map((file) => [
      file,
      createHash('sha256').update(readFileSync(file)).digest('hex')
    ])
  )
  let baselineTests = []
  const reportDirectory = resolve('node_modules/.cache/collector-ablation')
  mkdirSync(reportDirectory, { recursive: true })
  const rows = []
  const summary = resolve(reportDirectory, 'summary.json')
  rmSync(summary, { force: true })
  for (const variant of variants) {
    const isControl = variant === 'baseline' || variant === 'comment-control'
    const report = resolve(reportDirectory, `${variant}.json`)
    rmSync(report, { force: true })
    const result = spawnSync(
      process.execPath,
      [
        'node_modules/vitest/vitest.mjs',
        'run',
        ...testFiles,
        '-t',
        'Literature identifier links|identifier suffix scanning|DOI identity migration|Unicode DOI|Unicode width|non-ASCII|ASCII DOI|path segments|pure dot DOI|dot-only|does not generate|opaque DOI|opaque embedded DOI|resolver URL|resolver DOI|parseLiteraturePdfMetadata|normalizes resolvable identifiers|canonicalizes identifier values|collector|conservative duplicate metadata merging|Zotero collection boundary|Zotero preview result boundary|LiteraturePdfImporter|rejects published PDF|collects source identity|rejects Zotero source reuse|rolls back all imported|reuses DOI matches',
        '--config',
        'test/experiments/collector-ablation.config.ts',
        '--maxWorkers=1',
        '--reporter=json',
        '--outputFile',
        report
      ],
      {
        env: { ...process.env, COLLECTOR_ABLATION: variant },
        encoding: 'utf8',
        timeout: 120_000
      }
    )
    let data
    try {
      data = JSON.parse(readFileSync(report, 'utf8'))
    } catch {
      /* Invalid runs are not evidence. */
    }
    const inspected = inspectAblationReport({
      data,
      result,
      expectedTests: baselineTests,
      expectedFiles: testFiles,
      witness: isControl ? undefined : witnesses[variant]
    })
    const { failures, executed } = inspected
    const missingWitnesses = variant === 'baseline' ? missingAblationWitnesses(executed) : []
    const valid = inspected.valid && missingWitnesses.length === 0
    if (variant === 'baseline') baselineTests = executed
    const row = {
      variant,
      result: valid ? (isControl ? 'passed' : 'detected') : 'invalid',
      tests: (data?.numPassedTests ?? 0) + (data?.numFailedTests ?? 0),
      failedTests: failures,
      ...(missingWitnesses.length ? { missingWitnesses } : {})
    }
    rows.push(row)
    console.log(JSON.stringify(row))
    if (!valid) {
      console.error(result.stderr.slice(-4000))
      process.exitCode = 1
      break
    }
  }
  const finalHashes = Object.fromEntries(
    evidenceFiles.map((file) => [
      file,
      createHash('sha256').update(readFileSync(file)).digest('hex')
    ])
  )
  if (JSON.stringify(finalHashes) !== JSON.stringify(evidenceHashes))
    throw new Error(
      'Ablation source, tests or configuration changed during execution; discard this run.'
    )
  writeFileSync(
    summary,
    JSON.stringify(
      {
        evidenceStatus:
          rows.length === variants.length && rows.every(({ result }) => result !== 'invalid')
            ? 'complete'
            : 'invalid',
        runtime: { node: process.versions.node, platform: process.platform, arch: process.arch },
        sourceHashes: Object.fromEntries(sources.map((file) => [file, evidenceHashes[file]])),
        evidenceHashes,
        witnesses,
        variants: rows
      },
      null,
      2
    ) + '\n'
  )
}
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main()
