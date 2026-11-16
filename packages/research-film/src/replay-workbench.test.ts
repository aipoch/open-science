import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { researchFilmResources } from './resources.js'
import { expect, it } from 'vitest'
import { replayWorkbench } from './replay-workbench.js'
import { replayNarrationSpec } from './replay-case.js'
import { buildVideoTimeline } from './timeline.js'
import type { ReplayEvidence, ResearchVideoSessionSource } from './source.js'

it('projects real inputs, Notebook failures and result previews without inventing human control actions', () => {
  const base = { messageId: 'p', title: 'Record', text: 'Source' }
  const events: ReplayEvidence[] = [
    { ...base, id: 'human', kind: 'human-input' },
    { ...base, id: 'file', kind: 'attachment', title: 'prices.csv', text: 'prices.csv · 20 bytes' },
    { ...base, id: 'auto', kind: 'application-event' },
    {
      ...base,
      id: 'plan',
      kind: 'plan',
      status: 'blocked',
      text: JSON.stringify({
        document: {
          task_summary: 'Compare portfolios',
          phases: [{ name: 'Analysis', delegations: [{ steps: [{ title: 'Read prices' }] }] }]
        },
        steps: { 'Read prices': { status: 'blocked' } }
      })
    },
    {
      ...base,
      id: 'run',
      kind: 'execution',
      status: 'failed',
      execution: { code: 'print(1)', output: 'Actual failure', language: 'python' }
    },
    {
      ...base,
      id: 'result',
      kind: 'result',
      title: 'summary.csv',
      previewText: 'Name,Value\nNVDA,42'
    }
  ]
  const spec = {
    schemaVersion: 1 as const,
    title: 'Study',
    scenes: events.map((e) => ({ id: e.id, evidenceIds: [e.id], narration: 'Recorded evidence.' }))
  }
  const timeline = buildVideoTimeline(
    replayNarrationSpec(spec),
    Object.fromEntries(
      events.map((e) => [
        e.id + '_0',
        {
          duration: 5,
          words: [
            [0, 1],
            [1, 2]
          ]
        }
      ])
    )
  )
  const source: ResearchVideoSessionSource = {
    sessionTitle: 'Source session',
    project: 'p',
    messages: [],
    provenance: {
      projectId: 'p',
      sessionId: 's',
      mode: 'operation-replay',
      sourceClaimsIndependentlyVerified: false
    },
    replay: { schemaVersion: 1, events, omissions: [] }
  }
  const data = replayWorkbench(
    spec,
    source,
    timeline,
    events.map((event, i) => ({
      event,
      start: timeline.scenes[i].start,
      end: timeline.scenes[i].start + timeline.scenes[i].dur
    })),
    {}
  )
  expect(data).toMatchObject({
    scenes: [
      { kind: 'opening' },
      { kind: 'upload', prompt_id: 'human' },
      { kind: 'conversation', messages: [{ role: 'system', label: 'Input attachment' }] },
      { kind: 'conversation', messages: [{ role: 'system', text: 'Source' }] },
      {
        kind: 'conversation',
        messages: [
          {
            role: 'system',
            label: 'Recorded snapshot',
            text: expect.stringContaining('Read prices · blocked')
          }
        ]
      },
      { kind: 'run', phase: 'failed', code: 'print(1)', stdout: 'Actual failure' },
      { kind: 'result', result_id: 'result' }
    ],
    results: expect.arrayContaining([
      {
        id: 'result',
        name: 'summary.csv',
        evidence_refs: ['result'],
        type: 'table',
        columns: ['Name', 'Value'],
        rows: [['NVDA', '42']]
      }
    ]),
    captions: expect.arrayContaining([
      expect.objectContaining({ start: expect.any(Number), end: expect.any(Number) })
    ])
  })
  expect(data.results).toHaveLength(1)
})

it('keeps adapted replay asset hashes aligned with the bundled bytes', async () => {
  const { replayDirectory } = researchFilmResources()
  const manifest = JSON.parse(
    await readFile(join(replayDirectory, 'asset-provenance.json'), 'utf8')
  ) as { files: Array<{ path: string; bundledSha256: string }> }
  for (const entry of manifest.files) {
    const bytes = await readFile(join(replayDirectory, entry.path))
    expect(createHash('sha256').update(bytes).digest('hex'), entry.path).toBe(entry.bundledSha256)
  }
})
