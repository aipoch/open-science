import { it, expect, vi, onTestFinished } from 'vitest'
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { ApplicationCallerLeaseRegistry } from '../src/main/caller-lifecycle'
import { PdfTranslationWriter } from '../src/main/literature/pdf-translation/writer'
import { extractPdfTranslationSource } from '../src/renderer/src/pages/workspace/previews/renderers/pdf-translation-extraction'
import { pdfTranslationLayoutFragments } from '../src/renderer/src/pages/workspace/previews/renderers/pdf-translation-fragments'
import { verifyPdfUnits } from '../test/pdf-translation-native-verification'
import { verifyPdfPreservation } from '../test/pdf-translation-preservation'

vi.mock('electron', () => ({ net: {} }))

const sha256 = (value: Uint8Array | string): string =>
  createHash('sha256').update(value).digest('hex')

type CorpusFixture = {
  id: string
  sha256: string
  pageCount: number
  boundaryChecks: Array<{ leftSuffix: string; rightPrefix: string; note?: string }>
  samples: Array<{
    prefix: string
    sourceSha256: string
    translation: string
    nativeAnchor?: { pageNumber: number; itemIndex: number }
    sourceCharacters?: number
  }>
  byteLength?: number
  pixelCheckPages?: number[]
  separateBoundaryChecks?: Array<{ leftSuffix: string; rightPrefix: string; note?: string }>
  nativeBoundaryChecks?: Array<{
    leftAnchor: { pageNumber: number; itemIndex: number }
    rightAnchor: { pageNumber: number; itemIndex: number }
    relationship: 'same-paragraph' | 'next-paragraph'
    leftSourceSha256: string
    rightSourceSha256: string
    sourceOnly?: true
  }>
}

// Opt-in and offline: provide the PDF directory, manifest and reviewed baseline explicitly.
// Run-local manifests and baselines are intentionally not committed.
it.skipIf(!process.env.PDF_TRANSLATION_CORPUS)(
  'compares real scientific PDF boundaries and reviewed translation backfill with the baseline',
  async () => {
    const directory = resolve(process.env.PDF_TRANSLATION_CORPUS!)
    const manifestPath = process.env.PDF_TRANSLATION_CORPUS_MANIFEST
    const baselinePath = process.env.PDF_TRANSLATION_CORPUS_BASELINE
    if (!manifestPath || !baselinePath)
      throw new Error(
        'Set PDF_TRANSLATION_CORPUS_MANIFEST and PDF_TRANSLATION_CORPUS_BASELINE to reviewed local files.'
      )
    const outputDirectory = resolve(process.env.PDF_TRANSLATION_CORPUS_OUTPUT ?? directory)
    await mkdir(outputDirectory, { recursive: true })
    await writeFile(
      resolve(outputDirectory, 'report.json'),
      JSON.stringify({ status: 'running' }) + '\n'
    )
    const corpus: CorpusFixture[] = JSON.parse(await readFile(resolve(manifestPath), 'utf8'))
    const baseline = JSON.parse(await readFile(resolve(baselinePath), 'utf8'))
    const registry = new ApplicationCallerLeaseRegistry()
    onTestFinished(() => registry.dispose())
    const caller = registry.acquire({ leaseId: 'real-pdf-corpus', surface: 'electron' })
    const writer = new PdfTranslationWriter(() => resolve('resources/pdf-translation/worker.mjs'))
    const reports = []
    for (const fixture of corpus) {
      const bytes = new Uint8Array(await readFile(resolve(directory, `${fixture.id}.pdf`)))
      expect(sha256(bytes), `${fixture.id}: cached PDF identity`).toBe(fixture.sha256)
      if (fixture.byteLength !== undefined)
        expect(bytes.byteLength, `${fixture.id}: cached PDF byte length`).toBe(fixture.byteLength)
      const loading = getDocument({ data: bytes.slice(), useSystemFonts: true })
      try {
        const extraction = await extractPdfTranslationSource({
          document: await loading.promise,
          resourceRequestKey: fixture.id,
          signal: caller.lease.signal
        })
        const { source, coverage } = extraction
        expect(source.pages).toHaveLength(fixture.pageCount)
        expect(
          coverage.includedItemCount + coverage.excludedItemCount,
          `${fixture.id}: accounted native text items`
        ).toBe(coverage.textItemCount)
        const units = source.units
        const nativeKeys = units.flatMap((unit) =>
          unit.fragments.flatMap((fragment) =>
            fragment.items.map((item) => `${fragment.pageNumber}:${item.index}`)
          )
        )
        expect(new Set(nativeKeys).size, `${fixture.id}: unique source-item ownership`).toBe(
          nativeKeys.length
        )
        expect(nativeKeys.length, `${fixture.id}: complete fragment ownership`).toBe(
          coverage.includedItemCount
        )
        // Triage only: lowercase continuations after unfinished prose are NOT certified defects.
        const suspectBoundaries = units.flatMap((unit, index) => {
          const previous = units[index - 1]
          if (
            !previous ||
            previous.source.length < 80 ||
            !/^[a-z]/u.test(unit.source) ||
            /[.!?:;]$/u.test(previous.source.trim()) ||
            previous.fragments.at(-1)?.pageNumber !== unit.fragments[0]?.pageNumber
          )
            return []
          return [
            {
              sourceIndex: index,
              pageNumber: unit.fragments[0].pageNumber,
              previousTail: previous.source.slice(-100),
              currentHead: unit.source.slice(0, 100)
            }
          ]
        })
        const knownBoundaryDefects = [
          ...fixture.boundaryChecks
            .filter(
              (check) =>
                !units.some((unit) =>
                  unit.source.includes(`${check.leftSuffix} ${check.rightPrefix}`)
                )
            )
            .map((check) => ({ ...check, kind: 'must-join' })),
          ...(fixture.separateBoundaryChecks ?? [])
            .filter(
              (check) =>
                !units.some(
                  (unit, index) =>
                    unit.source.endsWith(check.leftSuffix) &&
                    units[index + 1]?.source.startsWith(check.rightPrefix)
                )
            )
            .map((check) => ({ ...check, kind: 'must-separate' }))
        ]
        // Native anchors plus complete paragraph hashes avoid shipping copied
        // source passages and detect both false joins and incomplete repairs.
        for (const check of fixture.nativeBoundaryChecks ?? []) {
          const owners = [check.leftAnchor, check.rightAnchor].map((anchor) =>
            units.flatMap((unit, index) =>
              unit.fragments.some(
                (fragment) =>
                  fragment.pageNumber === anchor.pageNumber &&
                  fragment.items.some((item) => item.index === anchor.itemIndex)
              )
                ? [index]
                : []
            )
          )
          expect(
            owners.map((indices) => indices.length),
            `${fixture.id}: boundary ownership`
          ).toEqual([1, 1])
          const [left, right] = owners.map((indices) => indices[0])
          expect(right, `${fixture.id}: ${check.relationship}`).toBe(
            left + (check.relationship === 'next-paragraph' ? 1 : 0)
          )
          expect(sha256(units[left].source), `${fixture.id}: complete left paragraph`).toBe(
            check.leftSourceSha256
          )
          expect(sha256(units[right].source), `${fixture.id}: complete right paragraph`).toBe(
            check.rightSourceSha256
          )
          if (check.sourceOnly)
            expect(
              [units[left].sourceOnly, units[right].sourceOnly],
              `${fixture.id}: protected source layout`
            ).toEqual([true, true])
        }
        const selected = fixture.samples.map((sample) => {
          const candidates = units.filter(
            (unit) =>
              unit.source.startsWith(sample.prefix) &&
              (!sample.nativeAnchor ||
                unit.fragments.some(
                  (fragment) =>
                    fragment.pageNumber === sample.nativeAnchor!.pageNumber &&
                    fragment.items.some((item) => item.index === sample.nativeAnchor!.itemIndex)
                ))
          )
          // Short headings can prefix a longer paragraph elsewhere. Their reviewed
          // full-text hash disambiguates; identical text at two locations still fails.
          const matches =
            candidates.length > 1
              ? candidates.filter((unit) => sha256(unit.source) === sample.sourceSha256)
              : candidates
          expect(matches, `${fixture.id}: unique reviewed sample`).toHaveLength(1)
          const unit = matches[0]
          expect(
            unit.sourceOnly,
            `${fixture.id}: reviewed target must own translatable prose`
          ).toBeUndefined()
          if (sample.sourceCharacters !== undefined)
            expect(unit.source.length, `${fixture.id}: reviewed whole-source length`).toBe(
              sample.sourceCharacters
            )
          expect(
            sha256(unit.source),
            `${fixture.id}: sample changed; review translation again`
          ).toBe(sample.sourceSha256)
          return {
            ...unit,
            fragments: pdfTranslationLayoutFragments(unit, source),
            translation: sample.translation
          }
        })
        const started = performance.now()
        const generated = await writer.generateDetailed(
          {
            id: fixture.id.replaceAll('.', '-'),
            data: bytes,
            pages: source.pages,
            preserveUnsupported: true,
            units: selected
          },
          caller.lease
        )
        expect(generated).not.toBeNull()
        if (!generated) throw new Error('Corpus generation returned no result')
        await writeFile(resolve(outputDirectory, `${fixture.id}-translated.pdf`), generated.data)
        const translated = getDocument({ data: generated.data.slice(), useSystemFonts: true })
        let placement: Awaited<ReturnType<typeof verifyPdfUnits>>
        let preservation: Awaited<ReturnType<typeof verifyPdfPreservation>>
        try {
          const document = await translated.promise
          expect(document.numPages).toBe(fixture.pageCount)
          placement = await verifyPdfUnits(
            document,
            selected.map((unit, sourceIndex) => ({ ...unit, sourceIndex })),
            generated.layoutFailures,
            await loading.promise
          )
          preservation = await verifyPdfPreservation(
            await loading.promise,
            document,
            selected,
            generated.layoutFailures,
            fixture.pixelCheckPages
          )
        } finally {
          await translated.destroy()
        }
        const verified = selected.map((unit, unitIndex) => ({
          unitIndex,
          pageNumbers: placement[unitIndex].pageNumbers,
          sourceCharacters: unit.source.length,
          retained: placement[unitIndex].retained,
          translationFound: placement[unitIndex].translationFound
        }))
        const sourceCharacters = units.reduce((sum, unit) => sum + unit.source.length, 0)
        const attemptedCharacters = verified.reduce((sum, unit) => sum + unit.sourceCharacters, 0)
        const fitted = verified.filter((unit) => !unit.retained && unit.translationFound)
        const retainedCharacters = verified
          .filter((unit) => unit.retained || !unit.translationFound)
          .reduce((sum, unit) => sum + unit.sourceCharacters, 0)
        const report = {
          id: fixture.id,
          sourceSha256: fixture.sha256,
          pageCount: source.pages.length,
          blockCount: units.length,
          sourceCharacters,
          excludedItemCount: coverage.excludedItemCount,
          suspectBoundaryCount: suspectBoundaries.length,
          suspectBoundaries,
          knownBoundaryDefectCount: knownBoundaryDefects.length,
          knownBoundaryDefects,
          attemptedBlocks: selected.length,
          fittedBlocks: fitted.length,
          retainedBlocks: selected.length - fitted.length,
          attemptedCharacters,
          retainedCharacters,
          attemptedSourceRatio: attemptedCharacters / sourceCharacters,
          fittedAttemptedSourceRatio:
            (attemptedCharacters - retainedCharacters) / attemptedCharacters,
          generationMs: performance.now() - started,
          layoutFailures: generated.layoutFailures,
          retainedSources: Object.fromEntries(
            generated.layoutFailures.map((failure) => [
              sha256(selected[failure.unitIndex].source),
              failure.code
            ])
          ),
          verificationFailures: verified.filter((unit) => !unit.retained && !unit.translationFound),
          samples: verified,
          preservation
        }
        reports.push(report)
        await writeFile(
          resolve(outputDirectory, `${fixture.id}-extraction.json`),
          JSON.stringify(extraction, null, 2) + '\n'
        )
      } finally {
        await loading.destroy()
      }
    }
    await writeFile(
      resolve(outputDirectory, 'report.json'),
      JSON.stringify(
        {
          method:
            'Actual source parser and native PDF writer; full-document boundary triage, selected reviewed Chinese translations only; no model or user database.',
          reports
        },
        null,
        2
      ) + '\n'
    )
    for (const report of reports) {
      expect(report.verificationFailures, `${report.id}: complete target in owned regions`).toEqual(
        []
      )
      expect(
        report.preservation.pages.flatMap((page) => page.failures),
        `${report.id}: independently preserved non-target content`
      ).toEqual([])
      const expected = baseline[report.id]
      expect(expected, `${report.id}: baseline exists`).toBeDefined()
      if (expected.retainedSources !== undefined)
        expect(report.retainedSources, `${report.id}: exact protected source and reason`).toEqual(
          expected.retainedSources
        )
      expect(report.excludedItemCount, `${report.id}: missing source items`).toBeLessThanOrEqual(
        expected.maxExcludedItems
      )
      expect(
        report.suspectBoundaryCount,
        `${report.id}: heuristic triage regression`
      ).toBeLessThanOrEqual(expected.maxSuspectBoundaries)
      expect(
        report.knownBoundaryDefectCount,
        `${report.id}: verified boundary regression`
      ).toBeLessThanOrEqual(expected.maxKnownBoundaryDefects)
      expect(
        report.fittedBlocks,
        `${report.id}: reviewed translation backfill`
      ).toBeGreaterThanOrEqual(expected.minFittedBlocks)
      expect(
        report.retainedBlocks,
        `${report.id}: unexpectedly retained original`
      ).toBeLessThanOrEqual(expected.maxRetainedBlocks)
    }
  },
  180_000
)
