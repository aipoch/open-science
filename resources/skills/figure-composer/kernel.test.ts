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
    expect(skill).toMatch(/transport or REPL observation\s+timeout/u)
    expect(skill).toMatch(/still\s+`running`/u)
    expect(skill).toContain('never authorizes `host.stopChild`')
    expect(skill).toContain('Retry only after the pinned Attempt is terminal')
    expect(skill).toMatch(/Version\/Artifact\s+identity validation was explicitly rejected/u)
    expect(skill).toMatch(/Attempt is never\s+retryable/u)
  })

  it('keeps the generated panel contract intact on revision retries', () => {
    const skill = readFileSync(skillFile, 'utf8')

    expect(skill).toContain('actually call')
    expect(skill).toContain('panel_task(outline, letter, fig_label)')
    expect(skill).toContain('byte-for-byte unchanged')
    expect(skill).toMatch(/Never\s+handwrite/u)
    expect(skill).toMatch(/filename, pixel geometry,\s+publication/u)
    expect(skill).toMatch(/alias fails\s+validation/u)
    expect(skill).toContain('must not enter composition provenance')
    expect(skill).toMatch(/fresh-name\s+retry/u)
  })

  it('requires formal review before returning the finalized composite', () => {
    const skill = readFileSync(skillFile, 'utf8')

    expect(skill).toMatch(/At least\s+one formal/u)
    expect(skill).toContain('reviewer Attempt is mandatory')
    expect(skill).toMatch(/never replace this step with\s+Main self-review/u)
    expect(skill).toContain('Only after a reviewer accepts the current composite')
    expect(skill).toContain('user-visible Markdown link named')
    expect(skill).toContain('Do not create a duplicate root Artifact')
  })

  it('keeps child Skill discovery and visual QA bounded', () => {
    const skill = readFileSync(skillFile, 'utf8')

    expect(skill).toContain('self-contained')
    expect(skill).toContain('must not search for or read any `SKILL.md`')
    expect(skill).toContain('at most two `notebook_execute` calls')
    expect(skill).toContain('Panel workers\ndo not call image-view tools')
    expect(skill).toContain('`row` and `col` are zero-based indices')
    expect(skill).toContain('positive physical millimeter heights')
    expect(skill).toContain('`fixed_panel_set: true`')
    expect(skill).toMatch(/does not load the outer\s+composer document/u)
    expect(skill).toMatch(/Do not\s+list the Skill directory/u)
    expect(skill).toContain('do not read it again in the same turn')
    expect(skill).toContain('read `kernel.py` or')
    expect(skill).toContain('Main/root never resolves panel bytes')
    expect(skill).toContain('producer task below owns path resolution')
    expect(skill).toMatch(/do not inspect every\s+crop by default/u)
    expect(skill).toContain('at most two image-view calls total')
    expect(skill).toMatch(/Per-panel zooms, strips, multiple\s+crops/u)
    expect(skill).toContain('zero findings is valid')
    expect(skill).toContain('Never run a third reviewer')
    expect(skill).toContain('exactly four child Attempts')
    expect(skill).not.toMatch(/review floors? 5|5\s*→\s*4\s*→\s*3/u)
    expect(skill).not.toContain('loads `figure-style` directly')
  })
})
