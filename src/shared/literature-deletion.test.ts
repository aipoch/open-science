import { describe, expect, it } from 'vitest'
import {
  literatureDeletionError,
  parseLiteratureDeletionError,
  type LiteratureDeletionDiagnostic
} from './literature-deletion'

const diagnostic: LiteratureDeletionDiagnostic = {
  reason: 'referenced',
  issues: [],
  truncated: false,
  references: [
    {
      attachmentId: 'attachment',
      versionId: 'version',
      projectId: 'project',
      sessionId: 'session',
      sessionTitle: 'Quoted "paper"\n阅读',
      location: 'message-history',
      messageId: 'message',
      branchId: 'inactive-branch',
      frameId: 'frame'
    }
  ]
}

describe('literature deletion error transport', () => {
  it.each(['', "Error invoking remote method 'literature:transact': Error: "])(
    'retains validated locations after message-only serialization with prefix %s',
    (prefix) => {
      const transported = JSON.parse(
        JSON.stringify({ message: literatureDeletionError(diagnostic).message })
      )
      expect(parseLiteratureDeletionError(new Error(prefix + transported.message))).toEqual(
        diagnostic
      )
    }
  )
  it('retains a useful reason without trusting malformed or truncated details', () => {
    for (const payload of ['{', '{"reason":"invented"}', '{"references":[{"projectId":null}]}']) {
      expect(
        parseLiteratureDeletionError(
          new Error('LITERATURE_ATTACHMENT_IN_USE\nLITERATURE_DELETION_DETAILS:' + payload)
        )
      ).toEqual({ reason: 'referenced', issues: [], references: [], truncated: true })
    }
    expect(parseLiteratureDeletionError(new Error('network failure'))).toBeUndefined()
  })
})
