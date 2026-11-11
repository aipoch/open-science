import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

// Remove one mechanism at a time in disposable source copies. No production flags, source edits,
// network, dependency installation or full-suite execution. Baseline assertions must pass; a
// mutant only counts as detected if its specified behavioral assertion actually fails.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = 'packages/connector-builtins/src/'
const main = 'humangenetics-eqtl.ts'
const reader = 'humangenetics-eqtl-tabix.ts'
const tests = ['humangenetics-eqtl.test.ts', 'humangenetics-eqtl-tabix.test.ts']
const files = [main, reader, ...tests]
const originals = Object.fromEntries(
  files.map((file) => [file, readFileSync(join(root, source, file), 'utf8')])
)
const mutations = [
  {
    name: 'no-genome-build-check',
    target: 'missing or unsupported genome_build',
    edits: [[main, "if (args.genome_build !== 'GRCh38')", 'if (false)']]
  },
  {
    name: 'no-point-bin-selection',
    target: 'does not decode unrelated 16-KiB bins',
    edits: [[reader, 'wanted && bins.has(bin)', 'wanted']]
  },
  {
    name: 'no-ancestor-bin-selection',
    target: 'packed into a parent bin',
    edits: [[reader, 'wanted && bins.has(bin)', 'wanted && bin >= 4681 && bins.has(bin)']]
  },
  {
    name: 'no-header-coordinate-binding',
    target: 'coordinate-column mismatch',
    edits: [[reader, "names[1] !== 'chromosome' || names[2] !== 'position'", 'false']]
  },
  {
    name: 'no-fatal-utf8-decoding',
    target: 'invalid UTF-8',
    edits: [
      [
        reader,
        "new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })",
        "new TextDecoder('utf-8', { fatal: false, ignoreBOM: true })"
      ]
    ]
  },
  {
    name: 'no-chunk-union',
    target: 'reassembles a row crossing BGZF blocks',
    edits: [[reader, 'if (previous && chunk.start <= previous.end)', 'if (false)']]
  },
  {
    name: 'no-exact-region-filter',
    target: '1-based inclusive boundaries',
    edits: [
      [main, 'position < location.region.start', 'false'],
      [main, 'position > location.region.end', 'false']
    ]
  },
  {
    name: 'no-identifier-filter',
    target: '1-based inclusive boundaries',
    edits: [
      [
        main,
        "['gene_id', 'rsid', 'variant'].some(",
        "false && ['gene_id', 'rsid', 'variant'].some("
      ]
    ]
  },
  {
    name: 'no-range-address-proof',
    target: 'equal-length range mapped',
    edits: [
      [reader, 'from !== start', 'false'],
      [reader, 'to !== Math.min(end!, total - 1)', 'false']
    ]
  },
  {
    name: 'no-file-version-proof',
    target: 'unsafe byte-range transport: changed',
    edits: [
      [reader, "else if (response.headers.get('etag') !== this.validator)", 'else if (false)']
    ]
  },
  {
    name: 'no-strong-etag',
    target: 'rejects weak ETags',
    edits: [
      [reader, 'if (!this.validator || !/^"[^"\\r\\n]*"$/.test(this.validator))', 'if (false)']
    ]
  },
  {
    name: 'no-gzip-integrity',
    target: 'rejects damaged BGZF payloads',
    edits: [
      [
        reader,
        "import { gunzipSync } from 'node:zlib'",
        "import { gunzipSync, inflateRawSync } from 'node:zlib'"
      ],
      [
        reader,
        'gunzipSync(data.subarray(offset, offset + size), { maxOutputLength: 65536 })',
        'inflateRawSync(data.subarray(extraEnd, offset + size - 8), { maxOutputLength: 65536 })'
      ]
    ]
  },
  {
    name: 'no-compressed-byte-budgets',
    target: 'limits the compressed byte range',
    edits: [
      [reader, 'end! - start + 1 > this.remaining', 'false'],
      [reader, 'if (size > maxBytes)', 'if (false)']
    ]
  },
  {
    name: 'no-bgzf-block-inflation-bound',
    target: 'oversized inflated BGZF block',
    edits: [[reader, '{ maxOutputLength: 65536 }', '{ maxOutputLength: 128 * 1024 * 1024 }']]
  },
  {
    name: 'no-cumulative-inflation-budget',
    target: 'cumulative inflation budget',
    edits: [[reader, 'if (inflated > MAX_INFLATED)', 'if (false)']]
  },
  {
    name: 'no-extra-record-proof',
    target: 'prove truncation at cap 1',
    edits: [[main, 'if (records.length > max) break', 'if (records.length >= max) break']]
  },
  {
    name: 'no-decimal-significance',
    target: 'nonzero decimal p-value significance',
    edits: [
      [
        main,
        'nlog10p = -Math.log10(mantissa) - (Number(exponent) + whole.length - first - 1)',
        'nlog10p = -Math.log10(p)'
      ]
    ]
  },
  {
    name: 'no-request-admission',
    target: 'spaces every file request',
    edits: [[reader, 'await admit(ctx.signal)', 'ctx.signal?.throwIfAborted()']]
  },
  {
    name: 'no-http-cancellation',
    target: 'unfinished HTTP operation',
    edits: [[reader, "{ headers, signal, redirect: 'error' }", "{ headers, redirect: 'error' }"]]
  }
]
const report = {
  source_sha256: Object.fromEntries(
    files.map((file) => [file, createHash('sha256').update(originals[file]).digest('hex')])
  ),
  baseline: null,
  controls: [],
  mutations: [],
  scope:
    'Fixed-response protocol tests and independent full-TSV-scan oracle; not live-service or all-input correctness proof.'
}
for (const variant of [
  { name: 'baseline', edits: [] },
  {
    name: 'comment-only-negative-control',
    control: true,
    edits: [
      [
        reader,
        'Read-only, bounded TBI/BGZF access.',
        'Read-only, bounded TBI/BGZF access (negative control).'
      ]
    ]
  },
  ...mutations
]) {
  const directory = mkdtempSync(join(tmpdir(), 'eqtl-ablation-'))
  try {
    const copies = { ...originals }
    for (const [file, from, to] of variant.edits) {
      assert.equal(
        copies[file].split(from).length - 1,
        1,
        `Ambiguous/stale mutation anchor: ${variant.name}`
      )
      copies[file] = copies[file].replace(from, to)
    }
    for (const file of files) writeFileSync(join(directory, file), copies[file])
    symlinkSync(join(root, 'node_modules'), join(directory, 'node_modules'))
    const config = {
      root: directory,
      resolve: {
        alias: { '@aipoch/connector-core': join(root, 'packages/connector-core/dist/index.js') }
      },
      test: {
        include: tests,
        testTimeout: 15000,
        maxWorkers: 1,
        reporters: ['json'],
        outputFile: join(directory, 'result.json')
      }
    }
    writeFileSync(
      join(directory, 'vitest.config.mjs'),
      `export default ${JSON.stringify(config)}\n`
    )
    const run = spawnSync(
      process.execPath,
      [
        join(root, 'node_modules/vitest/vitest.mjs'),
        'run',
        '--config',
        join(directory, 'vitest.config.mjs')
      ],
      { cwd: root, encoding: 'utf8', timeout: 60000, maxBuffer: 4 * 1024 * 1024 }
    )
    assert.equal(run.error, undefined, `Runner error: ${run.error}`)
    const result = JSON.parse(readFileSync(join(directory, 'result.json'), 'utf8'))
    const failed = result.testResults.flatMap((file) =>
      file.assertionResults.filter((test) => test.status === 'failed').map((test) => test.fullName)
    )
    if (variant.name === 'baseline' || variant.control) {
      assert.equal(run.status, 0, run.stdout + run.stderr)
      assert.equal(
        result.numPassedTests,
        result.numTotalTests,
        'Baseline must have no skips or failures'
      )
      if (variant.control)
        report.controls.push({
          name: variant.name,
          passed: result.numPassedTests,
          failed: failed.length
        })
      else report.baseline = { passed: result.numPassedTests, failed: failed.length }
    } else {
      assert.equal(run.status, 1, `Mutation was not detected: ${variant.name}`)
      assert.equal(
        result.numTotalTests,
        report.baseline.passed,
        'Mutation must execute the baseline test inventory'
      )
      assert(
        failed.length < report.baseline.passed,
        'A blanket runner/hook failure is not ablation evidence'
      )
      assert(
        failed.some((name) => name.includes(variant.target)),
        `Expected behavioral witness missing: ${variant.name}: ${failed.join('\n')}`
      )
      report.mutations.push({ name: variant.name, detected: true, failed_assertions: failed })
    }
    console.log(
      `${variant.name}: ${variant.name === 'baseline' || variant.control ? 'passed' : 'detected'}`
    )
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}
if (process.argv[2]) writeFileSync(resolve(process.argv[2]), JSON.stringify(report, null, 2) + '\n')
console.log(JSON.stringify(report, null, 2))
