import { createHash } from 'node:crypto'
import {
  parseProjectRecordingData,
  type ProjectRecordingData
} from '../../shared/project-recording-data'

/** Main's adapter supplies this already-declared output reader. No path is accepted here. */
export type ProjectRecordingDeclarationSource = Readonly<{
  key: string
  read(signal: AbortSignal): Promise<Uint8Array>
}>
export type ProjectRecordingDeclarationDelta = ProjectRecordingData & { missingSequences: number }

/** Append-only author evidence intake. A changed old ID/sequence is rejected instead of
 * silently rewriting previously captured state. Data is never evaluated or sent to a project. */
export class ProjectRecordingDeclarations {
  private readonly states = new Map<string, { fingerprint: string; sequence: number }>()
  private readonly events = new Map<string, { fingerprint: string; sequence: number }>()
  private stateSequence = -1
  private eventSequence = -1

  read(bytes: Uint8Array): ProjectRecordingDeclarationDelta {
    const data = parseProjectRecordingData(bytes)
    const inspect = <T extends { id: string; sequence: number }>(
      entries: T[],
      known: typeof this.states,
      previous: number
    ): {
      entries: T[]
      changes: [string, { fingerprint: string; sequence: number }][]
      sequence: number
      gaps: number
    } => {
      const fresh: T[] = []
      const changes: [string, { fingerprint: string; sequence: number }][] = []
      let sequence = previous
      let gaps = 0
      for (const entry of entries) {
        const fingerprint = createHash('sha256').update(JSON.stringify(entry)).digest('hex')
        const existing = known.get(entry.id)
        if (existing) {
          if (existing.fingerprint !== fingerprint || existing.sequence !== entry.sequence)
            throw new Error('Previously recorded project declaration changed.')
          continue
        }
        if (entry.sequence <= sequence || known.size + changes.length >= 2000)
          throw new Error('Project declaration sequence or capacity is invalid.')
        gaps += entry.sequence - sequence - 1
        sequence = entry.sequence
        fresh.push(entry)
        changes.push([entry.id, { fingerprint, sequence }])
      }
      return { entries: fresh, changes, sequence, gaps }
    }
    // Validate both channels before accepting either, preserving atomic intake on a bad batch.
    const states = inspect(data.states, this.states, this.stateSequence)
    const events = inspect(data.events, this.events, this.eventSequence)
    for (const [key, value] of states.changes) this.states.set(key, value)
    for (const [key, value] of events.changes) this.events.set(key, value)
    this.stateSequence = states.sequence
    this.eventSequence = events.sequence
    return {
      ...data,
      states: states.entries,
      events: events.entries,
      missingSequences: states.gaps + events.gaps
    }
  }
}
