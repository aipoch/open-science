import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import { createAgentEnvironmentOwnership } from './agent-environment-ownership'
import { envPrefix } from './runtime-paths'

const createEnvironment = (name = 'analysis'): { root: string; prefix: string } => {
  const root = mkdtempSync(join(tmpdir(), 'open-science-agent-env-'))
  const prefix = envPrefix(root, name)
  mkdirSync(prefix, { recursive: true })
  return { root, prefix }
}

describe('Agent environment ownership receipts', () => {
  it('records exact durable ownership and treats the receipt as language-specific', () => {
    const { root, prefix } = createEnvironment()
    try {
      const ownership = createAgentEnvironmentOwnership(root)
      ownership.record('analysis', 'python')

      expect(ownership.owns('analysis', 'python')).toBe(true)
      expect(ownership.owns('analysis', 'r')).toBe(false)
      expect(
        JSON.parse(
          readFileSync(join(root, '.agent-environment-ownership', 'analysis.json'), 'utf8')
        )
      ).toMatchObject({
        schema: 1,
        kind: 'agent-created-runtime-environment',
        name: 'analysis',
        language: 'python',
        canonicalPrefix: prefix
      })
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('fails closed for historical environments and mismatched receipts', () => {
    const { root } = createEnvironment()
    try {
      const ownership = createAgentEnvironmentOwnership(root)
      expect(ownership.owns('analysis', 'python')).toBe(false)
      expect(() => ownership.consume('analysis')).toThrow()

      ownership.record('analysis', 'python')
      const receiptPath = join(root, '.agent-environment-ownership', 'analysis.json')
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>
      writeFileSync(
        receiptPath,
        `${JSON.stringify({ ...receipt, canonicalPrefix: '/elsewhere' })}\n`
      )

      expect(ownership.owns('analysis', 'python')).toBe(false)
      expect(() => ownership.consume('analysis')).toThrow(/does not match/)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('requires the prefix-generation marker as well as the protected receipt', () => {
    const { root, prefix } = createEnvironment()
    try {
      const ownership = createAgentEnvironmentOwnership(root)
      ownership.record('analysis', 'python')
      rmSync(join(prefix, '.open-science-agent-environment.json'))

      expect(ownership.owns('analysis', 'python')).toBe(false)
      expect(() => ownership.consume('analysis')).toThrow()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('consumes deletion authority before removal and can restore it after a failed removal', () => {
    const { root } = createEnvironment()
    try {
      const ownership = createAgentEnvironmentOwnership(root)
      ownership.record('analysis', 'python')

      const receipt = ownership.consume('analysis')
      expect(ownership.owns('analysis', 'python')).toBe(false)

      ownership.restore(receipt)
      expect(ownership.owns('analysis', 'python')).toBe(true)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
