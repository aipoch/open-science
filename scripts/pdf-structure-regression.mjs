#!/usr/bin/env node
/* eslint-disable @typescript-eslint/explicit-function-return-type */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { createCanvas, loadImage } from '@napi-rs/canvas'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const readJson = (path) => JSON.parse(readFileSync(path, 'utf8'))

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

// Compare decoded pixels, so PNG metadata or compression changes are not regressions.
async function imageSignature(path) {
  const image = await loadImage(readFileSync(path)).catch((error) => {
    throw new Error(`Cannot decode crop image: ${path}`, { cause: error })
  })
  const canvas = createCanvas(image.width, image.height)
  try {
    const context = canvas.getContext('2d')
    context.drawImage(image, 0, 0)
    return {
      width: image.width,
      height: image.height,
      sha256: sha256(context.getImageData(0, 0, image.width, image.height).data)
    }
  } finally {
    canvas.width = 1
    canvas.height = 1
  }
}

// Compare extraction records in full, including source geometry, spans and notes.
// Run-specific fingerprints and model metadata are outside these record arrays.
export async function comparePdfStructureBatches(batches, baseDirectory = '.') {
  assert(Array.isArray(batches) && batches.length > 0, 'At least one batch is required')
  const reports = []
  for (const { manifest, before, after, batchSize = 5, sourceRoot } of batches) {
    assert(typeof before === 'string' && before, 'A baseline prefix is required')
    assert(typeof after === 'string' && after, 'A candidate prefix is required')
    assert(Number.isInteger(batchSize) && batchSize > 0, 'Batch size must be a positive integer')
    const documents = readJson(resolve(baseDirectory, manifest))
    assert(Array.isArray(documents) && documents.length > 0, 'The manifest must contain documents')
    const ids = new Set()
    const differences = []
    let pages = 0
    let imagesCompared = 0
    let unrenderedRecords = 0
    for (const document of documents) {
      const { id, name, total } = document
      assert(typeof id === 'string' && id && !ids.has(id), 'Document IDs must be unique strings')
      ids.add(id)
      assert(Number.isInteger(total) && total > 0, `Invalid page count: ${id}`)
      assert(
        typeof document.path === 'string' && document.path,
        `Source PDF path is required: ${id}`
      )
      const sourcePath = resolve(baseDirectory, sourceRoot ?? dirname(manifest), document.path)
      const sourceSha256 = sha256(readFileSync(sourcePath))
      for (let first = 1; first <= total; first += batchSize) {
        const expectedPages = Array.from(
          { length: Math.min(batchSize, total - first + 1) },
          (_, index) => first + index
        )
        const readBatch = (prefix) => {
          const path = resolve(baseDirectory, `${prefix}-${id}-${first}`, 'structure.json')
          const result = readJson(path)
          assert.equal(result.sourceSha256, sourceSha256, `Source PDF hash mismatch: ${path}`)
          assert.equal(result.pageCount, total, `Document page count mismatch: ${path}`)
          assert.deepEqual(
            result.processedPages,
            expectedPages,
            `Incomplete page coverage: ${path}`
          )
          for (const kind of ['figures', 'tables', 'algorithms']) {
            assert(Array.isArray(result[kind]), `Missing ${kind} array: ${path}`)
            assert(
              result[kind].every((record) => expectedPages.includes(record.page)),
              `Unexpected record page in ${kind}: ${path}`
            )
          }
          return result
        }
        const baseline = readBatch(before)
        const candidate = readBatch(after)
        for (const page of expectedPages) {
          for (const kind of ['figures', 'tables', 'algorithms']) {
            const previous = baseline[kind].filter((record) => record.page === page)
            const current = candidate[kind].filter((record) => record.page === page)
            if (!isDeepStrictEqual(previous, current)) {
              differences.push({ file: name ?? id, page, kind, before: previous, after: current })
            }
            // Read all referenced crops on both sides, even when a record was added or removed.
            const signatures = async (records, prefix) => {
              const results = []
              for (const record of records) {
                if (!record.thumbnail) {
                  assert(
                    !record.region && record.issue,
                    `Missing crop reference: ${id}, page ${page}`
                  )
                  results.push(null)
                  continue
                }
                const path = resolve(baseDirectory, `${prefix}-${id}-${first}`, record.thumbnail)
                results.push(await imageSignature(path))
              }
              return results
            }
            const oldImages = await signatures(previous, before)
            const newImages = await signatures(current, after)
            unrenderedRecords += newImages.filter((image) => image === null).length
            imagesCompared += newImages.filter((image, index) => image && oldImages[index]).length
            if (!isDeepStrictEqual(oldImages, newImages)) {
              differences.push({
                file: name ?? id,
                page,
                kind: `${kind}-images`,
                before: oldImages,
                after: newImages
              })
            }
          }
        }
        pages += expectedPages.length
      }
    }
    reports.push({
      manifest,
      documents: documents.length,
      pages,
      imagesCompared,
      unrenderedRecords,
      differences
    })
  }
  return reports
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let reportPath
  try {
    const [configPath, outputPath] = process.argv.slice(2)
    assert(
      configPath && outputPath,
      'Usage: node scripts/pdf-structure-regression.mjs CONFIG OUTPUT'
    )
    const config = resolve(configPath)
    assert(resolve(outputPath) !== config, 'The report must not overwrite its configuration')
    reportPath = resolve(outputPath)
    writeFileSync(reportPath, JSON.stringify({ status: 'running' }) + '\n')
    const reports = await comparePdfStructureBatches(readJson(config).batches, dirname(config))
    const status = reports.some(({ differences }) => differences.length) ? 'changed' : 'passed'
    writeFileSync(reportPath, JSON.stringify({ status, reports }, null, 2) + '\n')
    console.log(
      JSON.stringify(
        reports.map(({ differences, ...summary }) => ({
          ...summary,
          differences: differences.length
        })),
        null,
        2
      )
    )
    if (reports.some(({ differences }) => differences.length)) process.exitCode = 1
  } catch (error) {
    if (reportPath) {
      writeFileSync(
        reportPath,
        JSON.stringify({ status: 'failed', error: error.message }, null, 2) + '\n'
      )
    }
    console.error(`PDF regression failed: ${error.message}`)
    process.exitCode = 1
  }
}
