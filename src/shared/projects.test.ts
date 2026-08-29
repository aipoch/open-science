import { describe, expect, it } from 'vitest'

import { projectApplicationCommandContracts } from './projects'

const project = {
  id: 'project-1',
  name: 'Project',
  description: '',
  isExample: false,
  createdAt: 1,
  updatedAt: 2
}

describe('project application command contracts', () => {
  it('decodes the six Project command argument and result shapes', () => {
    const listArgs: [] = []
    const listResult = [project]
    expect(projectApplicationCommandContracts.list.args.parse(listArgs)).toBe(listArgs)
    expect(projectApplicationCommandContracts.list.result.parse(listResult)).toBe(listResult)
    expect(projectApplicationCommandContracts.get.args.parse(['project-1'])).toEqual(['project-1'])
    expect(projectApplicationCommandContracts.get.result.parse(null)).toBeNull()
    expect(projectApplicationCommandContracts.create.args.parse([{ name: 'Project' }])).toEqual([
      { name: 'Project' }
    ])
    expect(
      projectApplicationCommandContracts.update.args.parse([
        { id: 'project-1', name: 'Renamed', expectedUpdatedAt: 2 }
      ])
    ).toEqual([{ id: 'project-1', name: 'Renamed', expectedUpdatedAt: 2 }])
    expect(
      projectApplicationCommandContracts.update.args.parse([
        { id: 'project-1', pinned: true, expectedUpdatedAt: 2 }
      ])
    ).toEqual([{ id: 'project-1', pinned: true, expectedUpdatedAt: 2 }])
    expect(
      projectApplicationCommandContracts.create.args.parse([
        { name: 'Project', agentContext: 'Always cite DOIs.' }
      ])
    ).toEqual([{ name: 'Project', agentContext: 'Always cite DOIs.' }])
    expect(
      projectApplicationCommandContracts.update.args.parse([
        { id: 'project-1', agentContext: 'Always cite DOIs.', expectedUpdatedAt: 2 }
      ])
    ).toEqual([{ id: 'project-1', agentContext: 'Always cite DOIs.', expectedUpdatedAt: 2 }])
    expect(
      projectApplicationCommandContracts.get.result.parse({
        ...project,
        agentContext: 'Always cite DOIs.'
      })
    ).toEqual({ ...project, agentContext: 'Always cite DOIs.' })
    expect(
      projectApplicationCommandContracts.updateArchive.args.parse([
        { id: 'project-1', archived: true, expectedArchivedAt: null }
      ])
    ).toEqual([{ id: 'project-1', archived: true, expectedArchivedAt: null }])
    expect(projectApplicationCommandContracts.delete.args.parse([{ id: 'project-1' }])).toEqual([
      { id: 'project-1' }
    ])
    expect(projectApplicationCommandContracts.delete.result.parse({ status: 'deleted' })).toEqual({
      status: 'deleted'
    })
    expect(
      projectApplicationCommandContracts.delete.result.parse({ status: 'cleanup-pending' })
    ).toEqual({ status: 'cleanup-pending' })
  })

  it('rejects malformed and surplus public fields', () => {
    expect(() => projectApplicationCommandContracts.create.args.parse([{ name: 42 }])).toThrow()
    expect(() =>
      projectApplicationCommandContracts.delete.args.parse([
        { id: 'project-1', databasePath: '/private/research.db' }
      ])
    ).toThrow()
    expect(() =>
      projectApplicationCommandContracts.list.result.parse([{ ...project, createdAt: 'today' }])
    ).toThrow()
  })

  it('rejects an agent context beyond the 16000 character limit', () => {
    const oversized = 'x'.repeat(16001)

    expect(() =>
      projectApplicationCommandContracts.create.args.parse([
        { name: 'Project', agentContext: oversized }
      ])
    ).toThrow()
  })

  it('requires an update baseline and enforces Project name and description limits', () => {
    expect(() =>
      projectApplicationCommandContracts.update.args.parse([{ id: 'project-1', name: 'Renamed' }])
    ).toThrow()
    expect(() =>
      projectApplicationCommandContracts.create.args.parse([{ name: 'x'.repeat(201) }])
    ).toThrow()
    expect(() =>
      projectApplicationCommandContracts.create.args.parse([
        { name: 'Project', description: 'x'.repeat(1001) }
      ])
    ).toThrow()
    expect(() =>
      projectApplicationCommandContracts.update.args.parse([
        { id: 'project-1', name: 'x'.repeat(201), expectedUpdatedAt: 2 }
      ])
    ).toThrow()
    expect(() =>
      projectApplicationCommandContracts.update.args.parse([
        { id: 'project-1', description: 'x'.repeat(1001), expectedUpdatedAt: 2 }
      ])
    ).toThrow()
    expect(
      projectApplicationCommandContracts.create.args.parse([
        { name: 'x'.repeat(200), description: 'x'.repeat(1000) }
      ])
    ).toEqual([{ name: 'x'.repeat(200), description: 'x'.repeat(1000) }])
  })

  it('keeps historical projects above the new write limits readable', () => {
    const historicalProject = {
      ...project,
      name: 'x'.repeat(201),
      description: 'x'.repeat(1001)
    }

    expect(projectApplicationCommandContracts.list.result.parse([historicalProject])).toEqual([
      historicalProject
    ])
  })
})
