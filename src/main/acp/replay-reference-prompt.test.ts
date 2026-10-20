import { expect, it, vi } from 'vitest'
import { prepareReplayReferences } from './replay-reference-prompt'
import { replayReferenceText } from '../../shared/replay-reference'

it('links only current Ask targets and restores the persistent reading route every turn', async () => {
  const prepare = vi.fn<import('../session-replay/session-reading').PrepareSessionReading>(
    async () => 'compact reading route'
  )
  const link = replayReferenceText('snapshot', 'display', 'source-project')
  const result = await prepareReplayReferences(
    `why? ${link}`,
    link,
    'project',
    prepare,
    'receiving',
    'message'
  )
  expect(prepare).toHaveBeenCalledWith({
    projectId: 'project',
    sessionId: 'receiving',
    promptMessageId: 'message',
    sources: [{ projectId: 'source-project', id: 'snapshot' }]
  })
  expect(result).toEqual({
    text: 'why? [Linked Session]',
    history: '[Linked Session]',
    context: 'compact reading route'
  })
  await prepareReplayReferences('follow up', link, 'project', prepare, 'receiving', 'next-message')
  expect(prepare.mock.calls.at(-1)?.[0]).toMatchObject({ sources: [] })
})

it('fails when reading is unavailable instead of passing an opaque link to the Agent', async () => {
  await expect(
    prepareReplayReferences(replayReferenceText('snapshot', 'display'), undefined, 'project')
  ).rejects.toThrow('unavailable')
  expect(await prepareReplayReferences('ordinary text', undefined, 'project')).toEqual({
    text: 'ordinary text'
  })
})
