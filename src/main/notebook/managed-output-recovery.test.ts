import { expect, it } from 'vitest'
import { managedOutputSelectionSchema } from '../../shared/managed-execution'
import {
  createManagedOutputRecoveryAuthority,
  resolveManagedOutputRecoveryAuthority,
  revokeManagedOutputRecoveryAuthority,
  type ManagedOutputRecoveryAuthority
} from './managed-output-recovery'

const scope = { projectId: 'project', sessionId: 'session', operationId: 'current-operation' }
const selection = {
  producerRunId: 'original-run',
  filename: 'report.json',
  path: 'results/report.json'
}
const declaration = {
  ...scope,
  collectionId: 'a'.repeat(64),
  producerRunId: selection.producerRunId,
  producerProvenance: {
    rootFrameId: 'main-frame',
    agentFrameId: 'main-frame',
    messageBranchId: 'original-branch',
    runtimeSegmentId: 'original-segment',
    promptMessageId: 'original-prompt'
  },
  outputs: [
    {
      filename: selection.filename,
      path: selection.path,
      sha256: 'b'.repeat(64),
      sizeBytes: 42,
      generationId: 'original-generation'
    }
  ]
}
const definition = (): typeof declaration => structuredClone(declaration)
type Input = Parameters<typeof createManagedOutputRecoveryAuthority>[0]
const createUnknown = (input: unknown): ManagedOutputRecoveryAuthority =>
  createManagedOutputRecoveryAuthority(input as Input)

it('issues opaque authority bound to an exact old Run and immutable output generation', () => {
  const input = definition()
  const authority = createManagedOutputRecoveryAuthority(input)
  const proof = resolveManagedOutputRecoveryAuthority(authority, scope, selection)
  expect(JSON.stringify(authority)).toBe('{}')
  expect(Object.keys(authority)).toEqual([])
  expect(proof).toEqual({
    collectionId: input.collectionId,
    producerRunId: input.producerRunId,
    producerProvenance: input.producerProvenance,
    output: input.outputs[0],
    signal: expect.any(AbortSignal)
  })
  expect(proof).not.toHaveProperty('capability')
  expect(proof).not.toHaveProperty('outputRoot')
  expect(proof).not.toHaveProperty('outputs')
})

it('rejects fabricated, serialized and brand-copied objects', () => {
  const authority = createManagedOutputRecoveryAuthority(definition())
  for (const forged of [
    {},
    JSON.parse(JSON.stringify(authority)),
    { ...authority },
    Object.create(authority)
  ]) {
    expect(() => resolveManagedOutputRecoveryAuthority(forged, scope, selection)).toThrow(
      'does not belong'
    )
  }
})

it.each(['projectId', 'sessionId', 'operationId'] as const)('rejects a different %s', (key) => {
  const authority = createManagedOutputRecoveryAuthority(definition())
  expect(() =>
    resolveManagedOutputRecoveryAuthority(authority, { ...scope, [key]: 'foreign' }, selection)
  ).toThrow('does not belong')
})

it('rejects a substituted Run, undeclared file, or renamed path without accepting supplied provenance', () => {
  const authority = createManagedOutputRecoveryAuthority(definition())
  expect(() =>
    resolveManagedOutputRecoveryAuthority(authority, scope, {
      ...selection,
      producerRunId: 'different-run'
    })
  ).toThrow('original Notebook Run')
  expect(() =>
    resolveManagedOutputRecoveryAuthority(authority, scope, {
      ...selection,
      filename: 'different.json'
    })
  ).toThrow('exact output')
  expect(() =>
    resolveManagedOutputRecoveryAuthority(authority, scope, {
      ...selection,
      path: 'different/report.json'
    })
  ).toThrow('exact output')
  expect(() =>
    resolveManagedOutputRecoveryAuthority(authority, scope, {
      ...selection,
      producerProvenance: definition().producerProvenance
    } as typeof selection)
  ).toThrow()
})

it('detaches all declaration data from later caller mutation and freezes every returned declaration', () => {
  const input = definition()
  const original = structuredClone(input)
  const authority = createManagedOutputRecoveryAuthority(input)
  input.operationId = 'changed-operation'
  input.collectionId = 'c'.repeat(64)
  input.producerRunId = 'changed-run'
  for (const key of Object.keys(input.producerProvenance) as Array<
    keyof typeof input.producerProvenance
  >)
    input.producerProvenance[key] = 'changed'
  input.outputs[0].path = 'changed.json'
  input.outputs[0].filename = 'changed.json'
  input.outputs[0].sha256 = 'd'.repeat(64)
  input.outputs[0].sizeBytes = 999
  input.outputs[0].generationId = 'changed-generation'
  input.outputs.push({ ...input.outputs[0], filename: 'injected.json', path: 'injected.json' })
  const proof = resolveManagedOutputRecoveryAuthority(authority, scope, selection)
  expect(proof.collectionId).toBe(original.collectionId)
  expect(proof.producerRunId).toBe(original.producerRunId)
  expect(proof.producerProvenance).toEqual(original.producerProvenance)
  expect(proof.output).toEqual(original.outputs[0])
  for (const frozen of [authority, proof, proof.producerProvenance, proof.output])
    expect(Object.isFrozen(frozen)).toBe(true)
  expect(() => Object.assign(proof.output, { generationId: 'forged' })).toThrow(TypeError)
  expect(() => Object.assign(proof.producerProvenance, { promptMessageId: 'forged' })).toThrow(
    TypeError
  )
  expect(() =>
    resolveManagedOutputRecoveryAuthority(authority, scope, {
      ...selection,
      filename: 'injected.json',
      path: 'injected.json'
    })
  ).toThrow('exact output')
})

it.each([
  '../report.json',
  '/etc/passwd',
  'x/../../report.json',
  'x\\report.json',
  './report.json',
  'x//report.json',
  'C:report.json',
  'x\0y',
  'x\ny',
  ''
])('uses the shared selection constraint to reject unsafe path %j', (path) => {
  const input = definition()
  input.outputs[0].path = path
  expect(
    managedOutputSelectionSchema.safeParse({ filename: selection.filename, path }).success
  ).toBe(false)
  expect(() => createManagedOutputRecoveryAuthority(input)).toThrow()
})

it.each(['../report.json', '/report.json', 'x\\report.json', 'x\ny', ''])(
  'rejects invalid output filename %j',
  (filename) => {
    const input = definition()
    input.outputs[0].filename = filename
    expect(() => createManagedOutputRecoveryAuthority(input)).toThrow()
  }
)

it.each(['results/NUL.txt', 'results/report?.json', 'results/trailing. ', 'results/é.json'])(
  'preserves the original output selection rules for %j without introducing portable archive restrictions',
  (path) => {
    const input = definition()
    const filename = path.split('/').at(-1)!
    expect(managedOutputSelectionSchema.parse({ path, filename })).toEqual({ path, filename })
    input.outputs[0] = { ...input.outputs[0], path, filename }
    const authority = createManagedOutputRecoveryAuthority(input)
    expect(
      resolveManagedOutputRecoveryAuthority(authority, scope, {
        producerRunId: selection.producerRunId,
        path,
        filename
      }).output.path
    ).toBe(path)
  }
)

it('does not normalize distinct path spellings into a different authorized file', () => {
  const input = definition()
  input.outputs = [
    { ...input.outputs[0], filename: 'upper.json', path: 'Results/report.json' },
    { ...input.outputs[0], filename: 'lower.json', path: 'results/report.json' },
    { ...input.outputs[0], filename: 'composed.json', path: 'résult.json' },
    { ...input.outputs[0], filename: 'decomposed.json', path: 're\u0301sult.json' }
  ]
  const authority = createManagedOutputRecoveryAuthority(input)
  for (const output of input.outputs)
    expect(
      resolveManagedOutputRecoveryAuthority(authority, scope, {
        producerRunId: selection.producerRunId,
        filename: output.filename,
        path: output.path
      }).output.path
    ).toBe(output.path)
  expect(() =>
    resolveManagedOutputRecoveryAuthority(authority, scope, {
      ...selection,
      filename: 'upper.json'
    })
  ).toThrow('exact output')
})

it.each(['duplicate filename', 'duplicate path', 'parent before child', 'child before parent'])(
  'rejects ambiguous declared output sets: %s',
  (kind) => {
    const input = definition()
    const file = input.outputs[0]
    input.outputs.push({ ...file, filename: 'other.json', path: 'other.json' })
    if (kind === 'duplicate filename') input.outputs[1].filename = file.filename
    else if (kind === 'duplicate path') input.outputs[1].path = file.path
    else {
      input.outputs[0].path = kind === 'parent before child' ? 'results' : 'results/child.json'
      input.outputs[1].path = kind === 'parent before child' ? 'results/child.json' : 'results'
    }
    expect(() => createManagedOutputRecoveryAuthority(input)).toThrow(/Duplicate|Conflicting/)
  }
)

it.each([
  ['sha256', 'A'.repeat(64)],
  ['sha256', 'g'.repeat(64)],
  ['sha256', 'a'.repeat(63)],
  ['sizeBytes', -1],
  ['sizeBytes', 0.5],
  ['sizeBytes', Number.NaN],
  ['sizeBytes', Number.POSITIVE_INFINITY],
  ['sizeBytes', Number.MAX_SAFE_INTEGER + 1],
  ['generationId', undefined],
  ['generationId', ''],
  ['generationId', '../generation']
])('rejects invalid exact output evidence %s=%j', (key, value) => {
  const input = definition()
  expect(() =>
    createUnknown({ ...input, outputs: [{ ...input.outputs[0], [key]: value }] })
  ).toThrow()
})

it('requires all five original provenance fields and rejects unsupported declaration fields', () => {
  for (const key of Object.keys(definition().producerProvenance)) {
    const input = definition()
    const provenance = { ...input.producerProvenance } as Record<string, string>
    delete provenance[key]
    expect(() => createUnknown({ ...input, producerProvenance: provenance })).toThrow()
  }
  const input = definition()
  for (const invalid of [
    { ...input, collectionId: 'caller-invented-id' },
    { ...input, projectId: '../project' },
    { ...input, producerRunId: '' },
    { ...input, execute: 'unexpected command' },
    { ...input, outputs: [{ ...input.outputs[0], outputRoot: '/foreign' }] },
    { ...input, producerProvenance: { ...input.producerProvenance, injected: true } },
    { ...input, signal: {} }
  ])
    expect(() => createUnknown(invalid)).toThrow()
})

it('bounds the grant to 100 outputs and permits exact zero-byte files', () => {
  const input = definition()
  input.outputs = Array.from({ length: 100 }, (_, index) => ({
    ...input.outputs[0],
    filename: `file-${index}.json`,
    path: `results/file-${index}.json`,
    sizeBytes: 0
  }))
  const authority = createManagedOutputRecoveryAuthority(input)
  expect(
    resolveManagedOutputRecoveryAuthority(authority, scope, {
      producerRunId: input.producerRunId,
      filename: input.outputs[99].filename,
      path: input.outputs[99].path
    }).output.sizeBytes
  ).toBe(0)
  input.outputs.push({ ...input.outputs[0], filename: 'overflow.json', path: 'overflow.json' })
  expect(() => createManagedOutputRecoveryAuthority(input)).toThrow()
})

it('supports an empty grant without granting arbitrary output access', () => {
  const authority = createManagedOutputRecoveryAuthority({ ...definition(), outputs: [] })
  expect(() => resolveManagedOutputRecoveryAuthority(authority, scope, selection)).toThrow(
    'exact output'
  )
})

it('rejects already-aborted authority and propagates later cancellation to previously resolved proofs', () => {
  const controller = new AbortController()
  const authority = createManagedOutputRecoveryAuthority({
    ...definition(),
    signal: controller.signal
  })
  const proof = resolveManagedOutputRecoveryAuthority(authority, scope, selection)
  expect(proof.signal.aborted).toBe(false)
  controller.abort(new Error('collection stopped'))
  expect(proof.signal.aborted).toBe(true)
  expect(proof.signal.reason.message).toBe('collection stopped')
  expect(() => resolveManagedOutputRecoveryAuthority(authority, scope, selection)).toThrow(
    'collection stopped'
  )
  expect(() =>
    createManagedOutputRecoveryAuthority({ ...definition(), signal: controller.signal })
  ).toThrow('collection stopped')
})

it('revokes one authority and its resolved proof without revoking other grants or the parent signal', () => {
  const controller = new AbortController()
  const authority = createManagedOutputRecoveryAuthority({
    ...definition(),
    signal: controller.signal
  })
  const other = createManagedOutputRecoveryAuthority({ ...definition(), signal: controller.signal })
  const proof = resolveManagedOutputRecoveryAuthority(authority, scope, selection)
  revokeManagedOutputRecoveryAuthority(authority)
  revokeManagedOutputRecoveryAuthority(authority)
  expect(proof.signal.aborted).toBe(true)
  expect(controller.signal.aborted).toBe(false)
  expect(() => resolveManagedOutputRecoveryAuthority(authority, scope, selection)).toThrow(
    'authority has ended'
  )
  expect(resolveManagedOutputRecoveryAuthority(other, scope, selection).signal.aborted).toBe(false)
  const independent = createManagedOutputRecoveryAuthority(definition())
  revokeManagedOutputRecoveryAuthority(independent)
  expect(() => resolveManagedOutputRecoveryAuthority(independent, scope, selection)).toThrow(
    'authority has ended'
  )
})
