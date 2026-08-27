import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

import { describe, expect, it } from 'vitest'

const readSource = (name: string): string => readFileSync(resolve(__dirname, name), 'utf8')

describe('durable delegated work architecture', () => {
  it('keeps state owners and projections out of the public composer implementation', () => {
    const composer = readSource('./durable-delegated-work.ts')

    expect(composer).not.toContain('class RootDelegatePermissionOwner')
    expect(composer).not.toContain('class DelegatedWorkProjectionOwner')
    expect(composer).not.toContain('class DelegatedWorkReadModel')
    expect(composer).not.toContain('class DelegatedUserQuestionOwner')
    expect(composer).not.toContain('const createInMemoryDelegatedWorkRecords =')
    expect(composer).toContain('new DelegatedWorkAdmissionPolicy(')
    expect(composer).toContain('new RootDelegatePermissionOwner(')
    expect(composer).toContain('new DelegatedWorkProjectionOwner(')
    expect(composer).toContain('new DelegatedWorkReadModel(')
    expect(composer).toContain('new ReliableMessageDeliveryOwner(')
    expect(composer).toContain('new DelegatedUserQuestionOwner(')
  })
})
