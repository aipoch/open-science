import { createHash } from 'node:crypto'

import type { NotebookHelperModuleEvidence } from '../../shared/notebook'

const recordValue = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

const digestNotebookHelperSource = (source: string): string =>
  createHash('sha256').update(source).digest('hex')

const notebookHelperEvidenceKey = (
  helper: Pick<
    NotebookHelperModuleEvidence,
    'helperId' | 'skillIdentity' | 'registeredGeneration' | 'sourceDigest'
  >
): string =>
  [helper.skillIdentity, helper.helperId, helper.registeredGeneration, helper.sourceDigest].join(
    '\0'
  )

const decodeNotebookHelperEvidence = (
  value: unknown
):
  | { state: 'valid'; value: NotebookHelperModuleEvidence }
  | { state: 'invalid'; reason: 'source-missing' | 'source-corrupt' } => {
  const helper = recordValue(value)
  if (!helper || typeof helper.source !== 'string') {
    return { state: 'invalid', reason: 'source-missing' }
  }
  if (
    typeof helper.helperId !== 'string' ||
    typeof helper.skillIdentity !== 'string' ||
    typeof helper.packageOrigin !== 'string' ||
    typeof helper.interfaceRevision !== 'string' ||
    typeof helper.registeredGeneration !== 'string' ||
    !Array.isArray(helper.exports) ||
    helper.exports.some((name) => typeof name !== 'string') ||
    (helper.dependencies !== undefined &&
      (!Array.isArray(helper.dependencies) ||
        helper.dependencies.some((id) => typeof id !== 'string'))) ||
    typeof helper.sourceDigest !== 'string' ||
    digestNotebookHelperSource(helper.source) !== helper.sourceDigest
  ) {
    return { state: 'invalid', reason: 'source-corrupt' }
  }
  return {
    state: 'valid',
    value: {
      helperId: helper.helperId,
      skillIdentity: helper.skillIdentity,
      packageOrigin: helper.packageOrigin,
      interfaceRevision: helper.interfaceRevision,
      registeredGeneration: helper.registeredGeneration,
      exports: [...helper.exports] as string[],
      ...(helper.dependencies ? { dependencies: [...helper.dependencies] as string[] } : {}),
      source: helper.source,
      sourceDigest: helper.sourceDigest
    }
  }
}

export { decodeNotebookHelperEvidence, digestNotebookHelperSource, notebookHelperEvidenceKey }
