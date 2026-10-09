import { createHash } from 'node:crypto'
import type { ResearchDemoDescription } from '../../shared/research-demo'
import type { ResearchReproductionDescription } from '../../shared/research-reproduction'
import type { ResearchMaterialAuthority } from '../notebook/research-materials'
import type { ManagedExecutionService } from '../notebook/managed-execution-service'

export const demoSource = {
  projectId: 'project',
  sourceSessionId: 'source',
  sourceImportId: 'import-1'
}
export const demoSourceIdentity = 'research-materials:' + 'a'.repeat(64)
export const checksum = (value: Buffer): string => createHash('sha256').update(value).digest('hex')
export function demoFixture(
  options: {
    editDemo?(demo: ResearchDemoDescription): void
    editDescription?(description: ResearchReproductionDescription): void
  } = {}
): {
  authority: ResearchMaterialAuthority
  content: Map<string, { name: string; bytes: Buffer }>
  demo: ResearchDemoDescription
  description: ResearchReproductionDescription
  runtimes: Awaited<ReturnType<ManagedExecutionService['runtimes']>>
} {
  const code = Buffer.from('console.log("offline demo")')
  const description: ResearchReproductionDescription = {
    format: 'open-science-reproduction-description',
    descriptionVersion: 1,
    title: 'Example',
    materials: [
      {
        key: 'script',
        role: 'script',
        availability: 'included',
        filename: 'demo.mjs',
        restorePath: 'demo.mjs',
        sha256: checksum(code),
        sizeBytes: code.length
      }
    ],
    plans: [
      {
        key: 'example',
        title: 'Example',
        scope: 'engineering-check',
        materialKeys: ['script'],
        claim: 'Engineering only',
        limitations: ['Offline'],
        entrypoints: [{ materialKey: 'script' }],
        requirements: { node: '>=22' }
      }
    ]
  }
  options.editDescription?.(description)
  const descriptor = Buffer.from(JSON.stringify(description))
  const demo: ResearchDemoDescription = {
    format: 'open-science-replay-demo',
    version: 1,
    title: 'Offline example',
    description: 'A local demonstration',
    descriptorSha256: checksum(descriptor),
    planKey: 'example',
    substitutions: ['Uses synthetic inputs, not original model responses.'],
    entrypoint: { materialKey: 'script' },
    arguments: [],
    timeoutMs: 10000,
    outputs: []
  }
  options.editDemo?.(demo)
  const content = new Map([
    ['descriptor', { name: 'research-reproduction.json', bytes: descriptor }],
    ['script', { name: 'demo.mjs', bytes: code }],
    ['demo', { name: 'research-demo.json', bytes: Buffer.from(JSON.stringify(demo)) }]
  ])
  const authority: ResearchMaterialAuthority = {
    source: {
      projectId: demoSource.projectId,
      sessionId: demoSource.sourceSessionId,
      identity: demoSourceIdentity,
      title: 'Example'
    },
    versions: [...content].map(([versionId, file]) => ({
      versionId,
      sourceIdentity: demoSourceIdentity,
      filename: file.name,
      sha256: checksum(file.bytes),
      sizeBytes: file.bytes.length
    })),
    readVersion: async (versionId, { maxBytes }) => {
      const bytes = content.get(versionId)!.bytes
      if (bytes.length > maxBytes) throw new Error('bounded read')
      return bytes
    }
  }
  const runtimes = {
    available: true,
    runtimes: [
      {
        runtimeId: 'b'.repeat(64),
        kind: 'node' as const,
        version: '24.18.1',
        platform: 'darwin' as const,
        arch: 'arm64',
        sha256: 'c'.repeat(64)
      }
    ],
    diagnostics: { nativeServiceSupported: true, issues: [] }
  }
  return { authority, content, demo, description, runtimes }
}
