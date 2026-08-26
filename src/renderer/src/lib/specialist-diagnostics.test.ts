// @vitest-environment node
import { describe, expect, it } from 'vitest'

import type { PackageDiagnostic } from '../../../shared/specialist-package'
import { specialistDiagnosticCopy } from './specialist-diagnostics'

// Every code emitted by zip-adapter.ts (scanArchive), package/validator.ts
// (validateSpecialistPackage) and package/service.ts (overwrite preview).
// Keep this list in sync when validation grows.
const ALL_PACKAGE_CODES = [
  // Archive layer (zip-adapter.ts)
  'package.archive-invalid',
  'package.archive-compressed-size-exceeded',
  'package.archive-file-count-exceeded',
  'package.archive-uncompressed-size-exceeded',
  'package.archive-file-size-exceeded',
  'package.archive-path-depth-exceeded',
  'package.archive-path-absolute',
  'package.archive-path-drive',
  'package.archive-path-backslash',
  'package.archive-path-traversal',
  'package.archive-path-duplicate',
  'package.archive-encryption-unsupported',
  'package.symbolic-link-forbidden',
  'package.archive-link-unsupported',
  'package.archive-compression-unsupported',
  'package.archive-compression-ratio-exceeded',
  'package.archive-layout-invalid',
  'package.metadata-noise-ignored',
  // Content layer (package/validator.ts)
  'package.json-invalid',
  'package.required-file-missing',
  'package.executable-content-present',
  'manifest.object-required',
  'manifest.field-forbidden',
  'manifest.schema-version-unsupported',
  'manifest.id-invalid',
  'manifest.version-invalid',
  'manifest.exported-app-version-invalid',
  'specialist.object-required',
  'specialist.identity-field-forbidden',
  'specialist.presentation-field-forbidden',
  'specialist.capability-field-forbidden',
  'specialist.enabled-field-forbidden',
  'specialist.field-forbidden',
  'specialist.name-invalid',
  'specialist.display-name-invalid',
  'specialist.description-invalid',
  'specialist.system-prompt-invalid',
  'specialist.skillIds-invalid',
  'specialist.skillIds-entry-invalid',
  'specialist.skillIds-duplicate',
  'specialist.connectorIds-invalid',
  'specialist.connectorIds-entry-invalid',
  'specialist.connectorIds-duplicate',
  'specialist.name-protected',
  'specialist.name-duplicate',
  'specialist.id-protected',
  'specialist.skill-unavailable',
  'specialist.connector-unavailable',
  'builtin.bundled-skills-forbidden',
  'skill.path-noncanonical',
  'skill.id-invalid',
  'skill.document-missing',
  'skill.document-invalid',
  'skill.name-mismatch',
  'skill.version-invalid',
  'skill.executable-content-present',
  'skill.existing-conflict',
  // Export preview (package/service.ts)
  'specialist.export-unbundled-skills',
  'specialist.export-version-unchanged',
  'specialist.export-validation-failed',
  // Overwrite preview (package/service.ts)
  'specialist.overwrite-same-version',
  'specialist.overwrite-downgrade',
  'specialist.overwrite-local-modifications',
  'specialist.overwrite-content-without-version-bump'
]

const diag = (code: string, overrides: Partial<PackageDiagnostic> = {}): PackageDiagnostic => ({
  severity: 'error',
  code,
  message: '',
  ...overrides
})

describe('specialistDiagnosticCopy', () => {
  it('covers every diagnostic code produced by ZIP validation', () => {
    for (const code of ALL_PACKAGE_CODES) {
      const copy = specialistDiagnosticCopy(diag(code))
      expect(copy.title, `${code} must have a title`).not.toBe('')
      expect(copy.body, `${code} must have a body`).not.toBe('')
      expect(copy.title, `${code} must not leak its raw code`).not.toContain(code)
      expect(copy.body, `${code} must not leak its raw code`).not.toContain(code)
    }
  })

  it('formats byte limits in human-readable units', () => {
    const copy = specialistDiagnosticCopy(
      diag('package.archive-file-size-exceeded', {
        actual: 31 * 1024 * 1024,
        limit: 25 * 1024 * 1024,
        unit: 'bytes'
      })
    )
    expect(copy.title).toBe('Single file too large')
    expect(copy.body).toContain('31 MB')
    expect(copy.body).toContain('25 MB')
  })

  it.each([
    ['specialist.skillIds-invalid', 'Skill list', 'Skill list must be an array'],
    ['specialist.skillIds-entry-invalid', 'Invalid Skill name', 'non-empty strings'],
    ['specialist.skillIds-duplicate', 'Duplicate Skill name', 'duplicate names'],
    ['specialist.connectorIds-invalid', 'Connector list', 'Connector list must be an array'],
    ['specialist.connectorIds-entry-invalid', 'Invalid Connector name', 'non-empty strings'],
    ['specialist.connectorIds-duplicate', 'Duplicate Connector name', 'duplicate names']
  ])('maps %s to actionable copy', (code, title, guidance) => {
    expect(specialistDiagnosticCopy(diag(code))).toEqual({
      title,
      body: expect.stringContaining(guidance)
    })
  })

  it('embeds file counts and depth levels verbatim', () => {
    const count = specialistDiagnosticCopy(
      diag('package.archive-file-count-exceeded', { actual: 2100, limit: 2000, unit: 'files' })
    )
    expect(count.body).toContain('2,100 files')
    expect(count.body).toContain('limit is 2,000')

    const depth = specialistDiagnosticCopy(
      diag('package.archive-path-depth-exceeded', { actual: 41, limit: 32, unit: 'levels' })
    )
    expect(depth.body).toContain('41 levels')
    expect(depth.body).toContain('limit is 32')
  })

  it('explains unsafe compression ratios numerically', () => {
    const copy = specialistDiagnosticCopy(
      diag('package.archive-compression-ratio-exceeded', {
        actual: 4800,
        limit: 1000,
        unit: 'ratio'
      })
    )
    expect(copy.body).toContain('4,800×')
  })

  it('falls back to generic copy that still hides the raw code', () => {
    const copy = specialistDiagnosticCopy(diag('some.unknown-code'))
    expect(copy.title).not.toBe('some.unknown-code')
    expect(copy.title).not.toContain('unknown-code')
    expect(copy.body).not.toContain('some.unknown-code')
  })
})
