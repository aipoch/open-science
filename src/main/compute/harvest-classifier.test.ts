import { describe, expect, it } from 'vitest'

import { classifyFiles, type FileEntry, type OutputDeclaration } from './harvest-classifier'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const mb = (n: number): number => n * 1024 * 1024

const file = (path: string, size_bytes: number): FileEntry => ({ path, size_bytes })

// ---------------------------------------------------------------------------
// Basic classification — featured / hidden / remote / excluded
// ---------------------------------------------------------------------------

describe('classifyFiles — basic categories', () => {
  it('classifies a featured glob match', () => {
    const files: FileEntry[] = [file('model.result', mb(1))]
    const outputs: OutputDeclaration[] = ['*.result']
    const result = classifyFiles(files, outputs, {}, new Set())

    expect(result.featured).toEqual(['model.result'])
    expect(result.hidden).toEqual([])
    expect(result.remote).toEqual([])
    expect(result.excluded).toEqual([])
    expect(result.left_on_remote).toEqual([])
  })

  it('classifies a hidden visibility glob match', () => {
    const files: FileEntry[] = [file('train.log', mb(2))]
    const outputs: OutputDeclaration[] = [{ glob: '*.log', visibility: 'hidden' }]
    const result = classifyFiles(files, outputs, {}, new Set())

    expect(result.hidden).toEqual(['train.log'])
    expect(result.featured).toEqual([])
  })

  it('classifies a remote residency match (left_on_remote, not downloaded)', () => {
    const files: FileEntry[] = [file('checkpoint.bin', mb(50))]
    const outputs: OutputDeclaration[] = [{ glob: '*.bin', residency: 'remote' }]
    const result = classifyFiles(files, outputs, {}, new Set())

    expect(result.remote).toEqual(['checkpoint.bin'])
    expect(result.left_on_remote).toHaveLength(1)
    expect(result.left_on_remote[0]!.path).toBe('checkpoint.bin')
    expect(result.left_on_remote[0]!.reason).toBe('residency_remote')
    expect(result.featured).toEqual([])
    expect(result.hidden).toEqual([])
  })

  it('classifies a harvest.exclude match', () => {
    const files: FileEntry[] = [file('tmp_cache.dat', mb(1))]
    const outputs: OutputDeclaration[] = ['*.result']
    const result = classifyFiles(files, outputs, { exclude: ['*.dat'] }, new Set())

    expect(result.excluded).toEqual(['tmp_cache.dat'])
    expect(result.featured).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Control files always excluded
// ---------------------------------------------------------------------------

describe('classifyFiles — control file exclusion', () => {
  it('always excludes command.sh, launcher.sh, exit_code, job.pid', () => {
    const files: FileEntry[] = [
      file('command.sh', 100),
      file('launcher.sh', 200),
      file('exit_code', 10),
      file('job.pid', 5),
      file('model.result', mb(1))
    ]
    const outputs: OutputDeclaration[] = ['*.result']
    const result = classifyFiles(files, outputs, {}, new Set())

    expect(result.excluded).toContain('command.sh')
    expect(result.excluded).toContain('launcher.sh')
    expect(result.excluded).toContain('exit_code')
    expect(result.excluded).toContain('job.pid')
    expect(result.featured).toEqual(['model.result'])
  })
})

// ---------------------------------------------------------------------------
// Staged input exclusion
// ---------------------------------------------------------------------------

describe('classifyFiles — staged input exclusion', () => {
  it('excludes staged input bare names even when they match an output glob', () => {
    const files: FileEntry[] = [file('input.fa', mb(5)), file('model.result', mb(1))]
    const outputs: OutputDeclaration[] = ['*.result', '*.fa']
    const stagedInputs = new Set(['input.fa'])
    const result = classifyFiles(files, outputs, {}, stagedInputs)

    expect(result.excluded).toContain('input.fa')
    expect(result.featured).toEqual(['model.result'])
  })
})

// ---------------------------------------------------------------------------
// No outputs declaration — default hidden
// ---------------------------------------------------------------------------

describe('classifyFiles — no outputs (default hidden)', () => {
  it('treats all non-control, non-input files as hidden when outputs is empty', () => {
    const files: FileEntry[] = [
      file('output.csv', mb(1)),
      file('notes.txt', mb(0.5)),
      file('command.sh', 100),
      file('input.fa', mb(2))
    ]
    const stagedInputs = new Set(['input.fa'])
    const result = classifyFiles(files, [], {}, stagedInputs)

    expect(result.hidden).toContain('output.csv')
    expect(result.hidden).toContain('notes.txt')
    expect(result.excluded).toContain('command.sh')
    expect(result.excluded).toContain('input.fa')
    expect(result.featured).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// Size threshold: single file exceeds max_file_mb
// ---------------------------------------------------------------------------

describe('classifyFiles — max_file_mb threshold', () => {
  it('sends a single oversized file to left_on_remote with reason exceeds_max_file_mb', () => {
    const files: FileEntry[] = [file('huge.bin', mb(200))]
    const outputs: OutputDeclaration[] = [{ glob: '*.bin', visibility: 'hidden' }]
    const result = classifyFiles(files, outputs, { max_file_mb: 100 }, new Set())

    expect(result.hidden).toEqual([])
    expect(result.left_on_remote).toHaveLength(1)
    expect(result.left_on_remote[0]!.path).toBe('huge.bin')
    expect(result.left_on_remote[0]!.reason).toBe('exceeds_max_file_mb')
    expect(result.left_on_remote[0]!.size_mb).toBeCloseTo(200)
  })

  it('uses default 100 MB when max_file_mb not configured', () => {
    const files: FileEntry[] = [file('big.csv', mb(101))]
    const outputs: OutputDeclaration[] = [{ glob: '*.csv', visibility: 'hidden' }]
    const result = classifyFiles(files, outputs, {}, new Set())

    expect(result.left_on_remote[0]!.reason).toBe('exceeds_max_file_mb')
  })
})

// ---------------------------------------------------------------------------
// Cumulative total threshold: max_total_mb
// ---------------------------------------------------------------------------

describe('classifyFiles — max_total_mb threshold', () => {
  it('stops downloading when cumulative total exceeds max_total_mb and marks remainder', () => {
    // Three files: 200 MB each. max_file_mb = 250 (each file ok individually),
    // max_total_mb = 500. First two sum to 400 MB (ok), third would push to 600 MB (over).
    const files: FileEntry[] = [
      file('a.csv', mb(200)),
      file('b.csv', mb(200)),
      file('c.csv', mb(200)) // would push total to 600
    ]
    const outputs: OutputDeclaration[] = [{ glob: '*.csv', visibility: 'featured' }]
    const result = classifyFiles(files, outputs, { max_file_mb: 250, max_total_mb: 500 }, new Set())

    // a and b are downloaded
    expect(result.featured).toContain('a.csv')
    expect(result.featured).toContain('b.csv')
    // c is left on remote
    expect(result.left_on_remote).toHaveLength(1)
    expect(result.left_on_remote[0]!.path).toBe('c.csv')
    expect(result.left_on_remote[0]!.reason).toBe('exceeds_max_total_mb')
  })

  it('preserves order when applying max_total_mb cutoff', () => {
    // max_file_mb = 400 so each individual file passes the per-file check.
    // max_total_mb = 500: first (300 MB) fits, second would push to 600 MB — over.
    const files: FileEntry[] = [
      file('first.csv', mb(300)),
      file('second.csv', mb(300)),
      file('third.csv', mb(100))
    ]
    const outputs: OutputDeclaration[] = [{ glob: '*.csv', visibility: 'hidden' }]
    const result = classifyFiles(files, outputs, { max_file_mb: 400, max_total_mb: 500 }, new Set())

    // first: 300 (ok), second: would push to 600 (over), third: also over
    expect(result.hidden).toEqual(['first.csv'])
    expect(result.left_on_remote.map((e) => e.path)).toEqual(['second.csv', 'third.csv'])
    expect(result.left_on_remote[0]!.reason).toBe('exceeds_max_total_mb')
    expect(result.left_on_remote[1]!.reason).toBe('exceeds_max_total_mb')
  })

  it('uses default 500 MB when max_total_mb not configured', () => {
    const files: FileEntry[] = Array.from(
      { length: 6 },
      (_, i) => file(`file${i}.csv`, mb(100)) // 6 × 100 = 600 MB
    )
    const outputs: OutputDeclaration[] = [{ glob: '*.csv', visibility: 'hidden' }]
    const result = classifyFiles(files, outputs, {}, new Set())

    // Files 0–4 fit (500 MB), file 5 is over
    expect(result.hidden).toHaveLength(5)
    expect(result.left_on_remote).toHaveLength(1)
    expect(result.left_on_remote[0]!.path).toBe('file5.csv')
    expect(result.left_on_remote[0]!.reason).toBe('exceeds_max_total_mb')
  })
})

// ---------------------------------------------------------------------------
// Glob semantics
// ---------------------------------------------------------------------------

describe('classifyFiles — glob semantics', () => {
  it('*.result matches top-level only (not sub/dir/file.result)', () => {
    const files: FileEntry[] = [file('model.result', mb(1)), file('sub/dir/model.result', mb(1))]
    const outputs: OutputDeclaration[] = ['*.result']
    const result = classifyFiles(files, outputs, {}, new Set())

    expect(result.featured).toContain('model.result')
    // sub/dir/model.result is NOT matched by *.result (no recursive glob)
    expect(result.featured).not.toContain('sub/dir/model.result')
  })

  it('**/*.log matches recursively at any depth', () => {
    const files: FileEntry[] = [
      file('root.log', mb(1)),
      file('sub/nested.log', mb(1)),
      file('a/b/c/deep.log', mb(1))
    ]
    const outputs: OutputDeclaration[] = [{ glob: '**/*.log', visibility: 'hidden' }]
    const result = classifyFiles(files, outputs, {}, new Set())

    expect(result.hidden).toContain('root.log')
    expect(result.hidden).toContain('sub/nested.log')
    expect(result.hidden).toContain('a/b/c/deep.log')
  })
})

// ---------------------------------------------------------------------------
// to_download list
// ---------------------------------------------------------------------------

describe('classifyFiles — to_download list', () => {
  it('to_download contains featured and hidden files (but not remote or excluded)', () => {
    const files: FileEntry[] = [
      file('model.result', mb(1)),
      file('debug.log', mb(0.5)),
      file('weights.bin', mb(50)),
      file('command.sh', 100)
    ]
    const outputs: OutputDeclaration[] = [
      '*.result',
      { glob: '*.log', visibility: 'hidden' },
      { glob: '*.bin', residency: 'remote' }
    ]
    const result = classifyFiles(files, outputs, {}, new Set())

    expect(result.to_download).toContain('model.result')
    expect(result.to_download).toContain('debug.log')
    expect(result.to_download).not.toContain('weights.bin')
    expect(result.to_download).not.toContain('command.sh')
  })
})

// ---------------------------------------------------------------------------
// Combined scenario (manual e2e recipe from issue)
// ---------------------------------------------------------------------------

describe('classifyFiles — combined e2e scenario', () => {
  it('matches the manual recipe: model.result→featured, train.log→hidden, huge.bin→left_on_remote, command.sh→excluded, input.fa→excluded', () => {
    const files: FileEntry[] = [
      file('model.result', 1_000),
      file('train.log', 2_000),
      file('huge.bin', 200 * 1024 * 1024),
      file('command.sh', 50),
      file('input.fa', 500)
    ]
    // huge.bin is declared as hidden but exceeds the 100 MB default per-file limit.
    const outputs: OutputDeclaration[] = [
      '*.result',
      { glob: '*.log', visibility: 'hidden' },
      { glob: '*.bin', visibility: 'hidden' }
    ]
    const stagedInputs = new Set(['input.fa'])
    const result = classifyFiles(files, outputs, {}, stagedInputs)

    expect(result.featured).toContain('model.result')
    expect(result.hidden).toContain('train.log')
    expect(result.left_on_remote.map((e) => e.path)).toContain('huge.bin')
    expect(result.left_on_remote.find((e) => e.path === 'huge.bin')!.reason).toBe(
      'exceeds_max_file_mb'
    )
    expect(result.excluded).toContain('command.sh')
    expect(result.excluded).toContain('input.fa')
  })
})
