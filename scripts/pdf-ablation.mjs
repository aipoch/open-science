/* eslint-disable @typescript-eslint/explicit-function-return-type -- Standalone JavaScript experiment runner. */
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const ocr = 'src/main/uploads/pdf-ocr.ts'
const media = 'src/main/uploads/pdf-text-extraction.ts'
const reading = 'packages/literature-reading/src/reader.ts'
const runtime = 'test/experiments/pdf-worker-lifetime.test.ts'
export const variants = [
  {
    name: 'without-output-admission',
    file: media,
    from: 'remaining <= bodyPrefixLength',
    to: 'false',
    test: 'does not OCR or count a page'
  },
  {
    name: 'without-supplement-prefix-charge',
    file: media,
    from: 'remaining <= bodyPrefixLength',
    to: 'remaining <= marker.length',
    test: 'respects OCR supplement capacity'
  },
  {
    name: 'without-fallback-coverage',
    file: 'src/main/acp/runtime-events.ts',
    from: '...(coverageSummary.length ? { textCoverage: coverageSummary } : {}),',
    to: '',
    test: 'preserves page-batch metadata when a Literature result body is truncated'
  },
  {
    name: 'without-card-summary-fallback',
    file: 'src/renderer/src/pages/workspace/literature-tool-presentation.ts',
    from: 'Array.isArray(presentation?.textCoverage)',
    to: 'false',
    test: 'shows retained ACP coverage when the passage JSON is truncated'
  },
  {
    name: 'without-presentation-coverage',
    file: 'src/main/literature/mcp-server.ts',
    from: '...(textCoverage.length > 0 ? { textCoverage } : {}),',
    to: '',
    test: 'emits bounded presentation metadata before a large passage result'
  },
  {
    name: 'without-retained-coverage',
    file: 'src/main/acp/runtime-events.ts',
    from: '...(textCoverage.length > 0 ? { textCoverage } : {}),',
    to: '',
    test: 'preserves a Literature presentation block when the full result is truncated'
  },
  {
    name: 'control-comment',
    file: ocr,
    from: '// This worker owns Tesseract',
    to: '// Control: this worker owns Tesseract',
    control: true
  },
  {
    name: 'without-suite-error-check',
    file: 'scripts/pdf-ablation.mjs',
    from: '\n    filesClean &&\n',
    to: '\n    true &&\n',
    test: 'rejects an expected assertion mixed with an empty failed startup suite'
  },
  {
    name: 'without-unhandled-error-check',
    file: 'scripts/pdf-ablation.mjs',
    from: '\n    diagnosticsClean &&\n',
    to: '\n    true &&\n',
    test: 'rejects an expected assertion mixed with an unhandled error'
  },
  {
    name: 'without-page-attempt-limit',
    file: ocr,
    from: 'if (closed || attempts >= MAX_PDF_OCR_PAGES)',
    to: 'if (closed)',
    test: 'bounds automatic OCR pages'
  },
  {
    name: 'without-pixel-limit',
    file: ocr,
    from: '2400 / Math.max(base.width, base.height)',
    to: 'Infinity',
    test: 'caps rendered pixels'
  },
  {
    name: 'without-session-deadline',
    file: ocr,
    from: 'Math.min(startedAt + 120_000, performance.now() + PDF_OCR_TIMEOUT_MS)',
    to: 'performance.now() + PDF_OCR_TIMEOUT_MS',
    test: 'shares the 120-second admission budget'
  },
  {
    name: 'extra-separator-charge',
    file: media,
    from: 'totalChars += block.length + (pageTexts.length ? 2 : 0)',
    to: 'totalChars += block.length + 2',
    test: 'does not invent truncation at a fitting native output boundary'
  },
  {
    name: 'without-ocr',
    file: media,
    from: 'const ocr = options.ocr ? createPdfOcrSession() : undefined',
    to: 'const ocr = undefined as ReturnType<typeof createPdfOcrSession> | undefined',
    test: 'reads a real mixed PDF'
  },
  {
    name: 'without-native-preservation',
    file: media,
    from: 'pageText = nativeText ? `${nativeText}\\n\\n[OCR]\\n${recognized}` : recognized',
    to: 'pageText = recognized',
    test: 'preserves original native text when OCR'
  },
  {
    name: 'native-presence-shortcut',
    file: media,
    from: '(hasPageContent && !nativeText) || (hasRaster && /^\\d+$/.test(nativeText))',
    to: 'hasPageContent && !nativeText',
    test: 'reads a real mixed PDF'
  },
  {
    name: 'broad-mixed-page-ocr',
    file: media,
    from: '(hasPageContent && !nativeText) || (hasRaster && /^\\d+$/.test(nativeText))',
    to: '!nativeText || hasRaster',
    test: 'does not OCR readable native prose'
  },
  {
    name: 'without-empty-page-skip',
    file: media,
    from: '(hasPageContent && !nativeText)',
    to: '!nativeText',
    test: 'does not spend OCR attempts on an empty operator list'
  },
  {
    name: 'without-vector-uncertainty',
    file: media,
    from: 'if (hasRaster || hasVector) coverage.unverifiedPages.push(pageNumber)',
    to: 'if (hasRaster) coverage.unverifiedPages.push(pageNumber)',
    test: 'keeps vector body content unverified'
  },
  {
    name: 'without-visual-uncertainty',
    file: reading,
    from: '(document.coverage?.unverifiedPages?.length ?? 0) === 0',
    to: 'true',
    test: 'never treats image-bearing pages'
  },
  {
    name: 'without-page-coverage-proof',
    file: reading,
    from: 'new Set([...document.coverage.textPages, ...document.coverage.ocrPages]).size ===\n          document.pageCount',
    to: 'true',
    test: 'requires positive coverage'
  },
  {
    name: 'reset-stage-budget',
    file: ocr,
    from: 'const remaining = deadline - performance.now()',
    to: 'const remaining = PDF_OCR_TIMEOUT_MS',
    test: 'uses one deadline'
  },
  {
    name: 'without-render-cancellation',
    file: ocr,
    from: '() => rendering?.cancel()',
    to: '() => {}',
    test: 'cancels an overdue PDF render'
  },
  {
    name: 'without-setup-deadline-cancellation',
    file: ocr,
    from: 'if (closed || remaining <= 0) expire()',
    to: 'if (closed || remaining <= 0) throw new Error("PDF OCR deadline exceeded.")',
    test: 'exhausts the deadline during synchronous setup'
  },
  {
    name: 'without-encoding-deadline',
    file: 'src/main/uploads/pdf-ocr.ts',
    from: "await withinDeadline(() => canvas.encode('png'))",
    to: "await canvas.encode('png')",
    test: 'bounds a stalled PNG encoding'
  },
  {
    name: 'retry-on-cursor',
    file: reading,
    from: 'this.resolveDocument(reference, cursor === undefined)',
    to: 'this.resolveDocument(reference, true)',
    test: 'pagination shares one extraction'
  },
  {
    name: 'without-retry',
    file: reading,
    from: 'cached && !(retryIncomplete && cached.incomplete)',
    to: 'cached',
    test: 'retries incomplete pages'
  },
  {
    name: 'without-text-identity',
    file: 'packages/literature-reading/src/reader.ts',
    from: '.update(resolved.text)',
    to: ".update('')",
    test: 'text identity rejects stale cursors'
  },
  {
    name: 'extra-coverage-identity',
    file: reading,
    from: '.update(resolved.text)',
    to: '.update(resolved.text).update(JSON.stringify(resolved.coverage))',
    test: 'coverage-only updates preserve text cursors'
  },
  {
    name: 'without-confidence-filter',
    file: ocr,
    from: 'result.confidence! >= 50',
    to: 'true',
    test: 'does not turn low-confidence text'
  },
  {
    name: 'without-stop-join',
    file: ocr,
    from: 'await stop',
    to: 'void stop',
    test: 'close joins worker termination'
  },
  {
    name: 'without-timeout-worker-termination',
    file: ocr,
    from: 'if (worker) stop ??= worker.terminate()',
    to: 'if (worker) stop ??= Promise.resolve(0)',
    test: 'joins the real OCR owner and Tesseract descendant'
  },
  {
    name: 'without-worker-owner-stop',
    file: runtime,
    from: 'await outer.terminate() // ABLATION: owner termination',
    to: 'await Promise.resolve() // ABLATION: owner termination',
    test: 'terminating the owner stops a real'
  },
  {
    name: 'without-language-code-patch',
    file: 'test/experiments/pdf-worker-lifetime.test.ts',
    from: '${declaration} return langs',
    to: "${declaration?.replace('l.code', 'l.data')} return langs",
    test: 'initializes bundled language byte objects'
  }
]

export function variantCategory(variant) {
  if (variant.control) return 'control'
  return /^(src|packages)\//.test(variant.file) ? 'production' : 'supporting'
}

// Freeze all first-party code/configuration, rather than guessing transitive imports.
// Installed OCR code, WASM and models are included separately; the lockfile describes
// the remaining toolchain resolution, not a hash of every installed dependency byte.
export function experimentInputHashes(root) {
  const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' })
    .split('\0')
    .filter((file) => /\.(?:[cm]?[jt]sx?|json|ya?ml|patch|otf)$/.test(file))
  const runtime = []
  const visit = (directory) => {
    for (const entry of readdirSync(resolve(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`
      if (entry.isDirectory()) visit(path)
      else runtime.push(path)
    }
  }
  for (const dependency of [
    'tesseract.js',
    'tesseract.js-core',
    '@tesseract.js-data/eng',
    '@tesseract.js-data/chi_sim'
  ])
    visit(`node_modules/${dependency}`)
  const files = [...new Set([...tracked, ...runtime])].sort()
  return Object.fromEntries([
    ...files.map((file) => [
      file,
      createHash('sha256')
        .update(readFileSync(resolve(root, file)))
        .digest('hex')
    ]),
    ['[node-executable]', createHash('sha256').update(readFileSync(process.execPath)).digest('hex')]
  ])
}

export function validateRun(child, result, variant) {
  const files = result?.testResults
  if (!Array.isArray(files) || files.length === 0) return false
  const assertions = files.flatMap((file) => file.assertionResults ?? [])
  const failures = assertions.filter((test) => test.status === 'failed')
  const filesClean = files.every(
    (file) =>
      !file.message &&
      ['passed', 'failed'].includes(file.status) &&
      (file.status !== 'failed' || file.assertionResults?.some((test) => test.status === 'failed'))
  )
  const semantic =
    failures.length > 0 &&
    failures.every(
      (test) =>
        test.fullName.includes(variant.test ?? '') &&
        test.failureMessages.some((message) =>
          /AssertionError|expected .*throw|promise resolved|cursor is invalid/i.test(message)
        ) &&
        !test.failureMessages.some((message) =>
          /timed out|Cannot find module|SyntaxError|ReferenceError|startup/i.test(message)
        )
    )
  const diagnosticsClean =
    !/Vitest caught \d+ unhandled|Unhandled Errors?|Unhandled Rejection|Uncaught Exception/i.test(
      child.stderr ?? ''
    )
  return (
    !child.signal &&
    !child.error &&
    filesClean &&
    diagnosticsClean &&
    (variant.control
      ? child.status === 0 &&
        failures.length === 0 &&
        assertions.some((test) => test.status === 'passed')
      : child.status === 1 && semantic)
  )
}

export function run() {
  const root = process.cwd()
  const scratch = mkdtempSync(join(tmpdir(), 'pdf-ablation-'))
  const hashes = () => experimentInputHashes(root)
  const sourceHashes = hashes()
  const reportPath = process.argv[2] ? resolve(root, process.argv[2]) : join(scratch, 'report.json')
  console.log(`Ablation report: ${reportPath}`)
  const dependencyPath = resolve(root, 'node_modules/tesseract.js/src/worker-script/index.js')
  const dependency = {
    version: JSON.parse(
      readFileSync(resolve(root, 'node_modules/tesseract.js/package.json'), 'utf8')
    ).version,
    initializerSourceSha256: createHash('sha256').update(readFileSync(dependencyPath)).digest('hex')
  }
  const report = {
    status: 'running',
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    inputScope:
      'tracked first-party code/config/fonts; installed OCR code/WASM/models; Node executable; dependency resolution lockfile',
    dependency,
    sourceHashes,
    runs: []
  }
  const inputsMatch = () => JSON.stringify(sourceHashes) === JSON.stringify(hashes())
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  let baselineNames
  for (const variant of [{ name: 'baseline', control: true }, ...variants]) {
    const output = join(scratch, variant.name + '.json')
    const args = [
      resolve('node_modules/vitest/vitest.mjs'),
      'run',
      '--config',
      'test/experiments/pdf-ablation.config.ts',
      '--reporter=json',
      '--outputFile',
      output
    ]
    if (variant.test) args.push('-t', variant.test)
    const inputsMatchedBefore = inputsMatch()
    const child = spawnSync(process.execPath, args, {
      cwd: root,
      env: { ...process.env, PDF_ABLATION_VARIANT: variant.name },
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 1_000_000
    })
    let result
    try {
      result = JSON.parse(readFileSync(output, 'utf8'))
    } catch {
      /* Missing reports cannot count as a detected mutation. */
    }
    const assertions = result?.testResults?.flatMap((file) => file.assertionResults ?? []) ?? []
    const failures = assertions.filter((test) => test.status === 'failed')
    const executedNames = assertions
      .filter((test) => ['passed', 'failed'].includes(test.status))
      .map((test) => test.fullName)
      .sort()
    baselineNames ??= executedNames
    const expectedNames = baselineNames.filter(
      (name) => !variant.test || name.includes(variant.test)
    )
    const cohortMatches = JSON.stringify(executedNames) === JSON.stringify(expectedNames)
    const inputsMatchedAfter = inputsMatch()
    const valid =
      validateRun(child, result, variant) &&
      cohortMatches &&
      inputsMatchedBefore &&
      inputsMatchedAfter
    const run = {
      variant: variant.name,
      category: variantCategory(variant),
      expected: variant.control ? 'pass' : 'semantic-failure',
      valid,
      cohortMatches,
      inputsMatchedBefore,
      inputsMatchedAfter,
      exitCode: child.status,
      signal: child.signal,
      passed: assertions.filter((test) => test.status === 'passed').length,
      failures: failures.map(({ fullName, failureMessages }) => ({
        fullName,
        messages: failureMessages.map((message) => message.slice(0, 1600))
      }))
    }
    report.runs.push(run)
    console.log(
      `${variant.name}: ${valid ? 'confirmed' : 'INVALID'} (${run.passed} pass, ${failures.length} fail)`
    )
    writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
    if (!valid) {
      console.error(child.stdout.slice(-2000), child.stderr.slice(-2000))
      break
    }
  }
  const unchanged = inputsMatch()
  report.status =
    unchanged && report.runs.length === variants.length + 1 && report.runs.every((run) => run.valid)
      ? 'complete'
      : 'invalid'
  report.sourcesUnchanged = unchanged
  report.categories = Object.fromEntries(
    ['production', 'supporting', 'control'].map((category) => [
      category,
      report.runs.filter((run) => run.category === category).length
    ])
  )
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n')
  if (report.status !== 'complete') process.exitCode = 1
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) run()
