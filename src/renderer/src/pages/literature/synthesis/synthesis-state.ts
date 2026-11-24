import type {
  LiteratureSynthesisRequest,
  LiteratureSynthesisResult,
  SynthesisBlock,
  SynthesisCandidate,
  SynthesisCandidateCursor,
  SynthesisEditableBlock
} from '../../../../../shared/literature-synthesis'

export type SynthesisTransport = (
  request: LiteratureSynthesisRequest
) => Promise<LiteratureSynthesisResult>
export const candidateKey = (
  candidate: Pick<SynthesisCandidate, 'itemId' | 'versionId' | 'annotationId'>
): string => candidate.annotationId

function candidateCursorAdvances(
  previous: SynthesisCandidateCursor,
  next: SynthesisCandidateCursor
): boolean {
  const difference = Date.parse(next.createdAt) - Date.parse(previous.createdAt)
  if (difference !== 0) return difference > 0
  // SQLite's binary UTF-8 order follows Unicode code points, including non-BMP IDs.
  const previousId = [...previous.id]
  const nextId = [...next.id]
  for (let index = 0; index < Math.min(previousId.length, nextId.length); index++) {
    const order = nextId[index].codePointAt(0)! - previousId[index].codePointAt(0)!
    if (order !== 0) return order > 0
  }
  return nextId.length > previousId.length
}

export async function readSynthesisCandidates(
  request: SynthesisTransport,
  itemIds: string[]
): Promise<SynthesisCandidate[]> {
  const candidates: SynthesisCandidate[] = []
  const seen = new Set<string>()
  let cursor: SynthesisCandidateCursor | undefined
  for (;;) {
    const page = await request({ action: 'candidates', itemIds, cursor, limit: 100 })
    if (page.action !== 'candidates') throw new Error('Unexpected synthesis response.')
    for (const candidate of page.candidates) {
      const key = candidateKey(candidate)
      if (!seen.has(key)) {
        seen.add(key)
        candidates.push(candidate)
      }
    }
    if (page.nextCursor === undefined) return candidates
    if (cursor && !candidateCursorAdvances(cursor, page.nextCursor))
      throw new Error('Synthesis pagination did not advance.')
    cursor = page.nextCursor
  }
}

export const editableBlocks = (blocks: SynthesisBlock[]): SynthesisEditableBlock[] =>
  blocks.map((block) => (block.type === 'excerpt' ? { type: 'excerpt', id: block.id } : block))

export function moveSynthesisBlock(
  blocks: SynthesisBlock[],
  id: string,
  direction: -1 | 1
): SynthesisBlock[] {
  const index = blocks.findIndex((block) => block.id === id)
  const destination = index + direction
  if (index < 0 || destination < 0 || destination >= blocks.length) return blocks
  const result = [...blocks]
  ;[result[index], result[destination]] = [result[destination]!, result[index]!]
  return result
}

export function insertSynthesisBlock(
  blocks: SynthesisBlock[],
  id: string,
  boundary: number
): SynthesisBlock[] {
  const index = blocks.findIndex((block) => block.id === id)
  if (index < 0 || boundary < 0 || boundary > blocks.length) return blocks
  const destination = boundary > index ? boundary - 1 : boundary
  if (index === destination) return blocks
  const result = [...blocks]
  const [block] = result.splice(index, 1)
  result.splice(destination, 0, block!)
  return result
}

export type SynthesisMutationRequest = Extract<
  LiteratureSynthesisRequest,
  { action: 'create' | 'append' | 'update' | 'delete' }
>
type SynthesisMutationIdentity = {
  (request: SynthesisMutationRequest): SynthesisMutationRequest & { requestId: string }
  forget(requestId: string): void
}
export function createSynthesisMutationIdentity(): SynthesisMutationIdentity {
  const identities = new Map<string, string>()
  const identify = (
    request: SynthesisMutationRequest
  ): SynthesisMutationRequest & { requestId: string } => {
    const key = JSON.stringify(request)
    let requestId = identities.get(key)
    if (!requestId) {
      requestId = crypto.randomUUID()
      identities.set(key, requestId)
    }
    return { ...request, requestId }
  }
  return Object.assign(identify, {
    forget: (requestId: string): void => {
      for (const [key, id] of identities) if (id === requestId) identities.delete(key)
    }
  })
}
