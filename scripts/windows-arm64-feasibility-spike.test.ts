import { describe, expect, it } from 'vitest'

import { collectFindings } from './windows-arm64-feasibility-spike.mjs'

describe('Windows ARM64 feasibility spike', () => {
  const findings = Object.fromEntries(collectFindings().map((finding) => [finding.id, finding]))

  it('keeps the existing architecture-aware packaging seams usable', () => {
    expect(findings['electron-builder'].status).toBe(true)
    expect(findings['native-node-packages'].status).toBe(true)
    expect(findings['appcontainer-host'].status).toBe(true)
    expect(findings['micromamba-arm64-binary'].status).toBe(true)
  })

  it('does not treat x64 runtime assets as native ARM64 support', () => {
    expect(findings['notebook-python-runtime-platform'].status).toBe(false)
    expect(findings['notebook-r-runtime'].status).toBe(false)
    expect(findings['prisma-engine'].status).toBe(false)
  })

  it('requires a native ARM64 validation run before support can be claimed', () => {
    expect(findings['native-arm64-validation'].status).toBe(false)
    expect(findings['native-arm64-validation'].blocking).toBe(true)
  })
})
