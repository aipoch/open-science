import { describe, expect, it } from 'vitest'

import { resolveMessageBranchPath } from './conversation-graph'
import { importExternalConversationGraph } from './external-conversation-import'

const externalMessage = (id: string, text = id): Record<string, unknown> => ({
  role: id.startsWith('a') ? 'assistant' : 'user',
  content: [{ type: 'text', text }],
  _uuid: id
})

describe('external conversation tree import', () => {
  it('converts the 53-parent / 37-active / fork_point 31 export without flattening history', () => {
    const parent = Array.from({ length: 53 }, (_, index) =>
      externalMessage(index % 2 === 0 ? `u${index}` : `a${index}`)
    )
    const active = [
      ...parent.slice(0, 31),
      ...Array.from({ length: 6 }, (_, index) =>
        externalMessage(index % 2 === 0 ? `u-new-${index}` : `a-new-${index}`)
      )
    ]
    const graph = importExternalConversationGraph({
      root_frame_id: 'frame-root',
      frames: [
        {
          id: 'frame-root',
          parent_frame_id: null,
          agent_name: 'OPERON',
          status: 'completed',
          created_at: '2026-07-27T00:00:00.000Z',
          context_metadata: {
            branch_meta: {
              active_branch_id: 'branch-active',
              branches: {
                'branch-parent': {
                  parent_id: null,
                  fork_point: null,
                  messages: parent
                },
                'branch-active': {
                  parent_id: 'branch-parent',
                  fork_point: 31,
                  messages: []
                }
              }
            }
          },
          messages: active
        }
      ]
    })

    expect(resolveMessageBranchPath(graph, 'branch-parent')).toHaveLength(53)
    expect(resolveMessageBranchPath(graph, 'branch-active')).toHaveLength(37)
    expect(graph.messages).toHaveLength(59)
    expect(graph.branches.find((branch) => branch.id === 'branch-active')).toMatchObject({
      parentBranchId: 'branch-parent',
      forkMessageId: parent[30]._uuid,
      supersededMessageId: parent[31]._uuid
    })
  })

  it('rejects prefix disagreement and cyclic Frame parents instead of guessing a flat history', () => {
    const parent = [externalMessage('u0'), externalMessage('a1')]
    expect(() =>
      importExternalConversationGraph({
        root_frame_id: 'frame-root',
        frames: [
          {
            id: 'frame-root',
            parent_frame_id: null,
            context_metadata: {
              branch_meta: {
                active_branch_id: 'child',
                branches: {
                  parent: { parent_id: null, fork_point: null, messages: parent },
                  child: {
                    parent_id: 'parent',
                    fork_point: 1,
                    messages: [externalMessage('different')]
                  }
                }
              }
            },
            messages: []
          }
        ]
      })
    ).toThrow(/shared prefix/)

    expect(() =>
      importExternalConversationGraph({
        root_frame_id: 'frame-a',
        frames: [
          { id: 'frame-a', parent_frame_id: 'frame-b', messages: [] },
          { id: 'frame-b', parent_frame_id: 'frame-a', messages: [] }
        ]
      })
    ).toThrow(/parent relationship/)

    expect(() =>
      importExternalConversationGraph({
        root_frame_id: 'frame-root',
        frames: [
          {
            id: 'frame-root',
            parent_frame_id: null,
            context_metadata: {
              branch_meta: {
                active_branch_id: 'branch-one',
                branches: {
                  'branch-one': {
                    parent_id: null,
                    fork_point: null,
                    messages: [externalMessage('u-reused')]
                  },
                  'branch-two': {
                    parent_id: null,
                    fork_point: null,
                    messages: [externalMessage('u-reused')]
                  }
                }
              }
            },
            messages: [externalMessage('u-reused')]
          }
        ]
      })
    ).toThrow(/reused outside its validated shared prefix/)
  })
})
