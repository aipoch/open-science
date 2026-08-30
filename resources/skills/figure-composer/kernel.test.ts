import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { describe, expect, it } from 'vitest'

const python3 = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3'].find(
  existsSync
)
const gate = python3 ? describe : describe.skip
const testFile = resolve(dirname(fileURLToPath(import.meta.url)), 'test_kernel.py')
const skillFile = resolve(dirname(fileURLToPath(import.meta.url)), 'SKILL.md')

gate('figure-composer kernel', () => {
  it('passes its Python regression tests', () => {
    expect(() => execFileSync(python3 as string, [testFile], { timeout: 5_000 })).not.toThrow()
  })

  it('uses bounded collection windows without cancelling running Attempts', () => {
    const skill = readFileSync(skillFile, 'utf8')

    expect(skill).toContain("timeoutSeconds: 240, returnWhen: 'all'")
    expect(skill).toContain('timeoutMs` is at most `270000')
    expect(skill).not.toContain('timeoutSeconds: 1800')
    expect(skill).toContain('**Delegated Wait**')
    expect(skill).toContain('**Attempt Deadline**')
    expect(skill).toContain('transport or REPL observation timeout')
    expect(skill).toContain('still `running`')
    expect(skill).toContain('never authorizes `host.stopChild`')
    expect(skill).toContain('Retry only after the pinned Attempt is terminal')
    expect(skill).toContain('Version/Artifact identity validation was explicitly rejected')
    expect(skill).toContain('Attempt is never retryable')
  })

  it('keeps the generated panel contract intact on revision retries', () => {
    const skill = readFileSync(skillFile, 'utf8')

    expect(skill).toContain('actually call')
    expect(skill).toContain('panel_task(outline, letter, fig_label)')
    expect(skill).toContain('byte-for-byte unchanged')
    expect(skill).toContain('Never handwrite')
    expect(skill).toContain('filename, pixel geometry, publication')
    expect(skill).toContain('alias fails validation')
    expect(skill).toContain('must not enter composition provenance')
    expect(skill).toContain('fresh-name retry')
  })

  it('requires formal review before returning the finalized composite', () => {
    const skill = readFileSync(skillFile, 'utf8')

    expect(skill).toContain('At least one formal')
    expect(skill).toContain('reviewer Attempt is mandatory')
    expect(skill).toContain('never replace this step with Main self-review')
    expect(skill).toContain('Only after a reviewer accepts the current composite')
    expect(skill).toContain('user-visible Markdown link named')
    expect(skill).toContain('Do not create a duplicate root Artifact')
  })
})
