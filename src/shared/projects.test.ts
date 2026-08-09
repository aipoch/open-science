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
      projectApplicationCommandContracts.update.args.parse([{ id: 'project-1', name: 'Renamed' }])
    ).toEqual([{ id: 'project-1', name: 'Renamed' }])
    expect(
      projectApplicationCommandContracts.update.args.parse([{ id: 'project-1', pinned: true }])
    ).toEqual([{ id: 'project-1', pinned: true }])
    expect(
      projectApplicationCommandContracts.updateArchive.args.parse([
        { id: 'project-1', archived: true, expectedArchivedAt: null }
      ])
    ).toEqual([{ id: 'project-1', archived: true, expectedArchivedAt: null }])
    expect(projectApplicationCommandContracts.delete.args.parse([{ id: 'project-1' }])).toEqual([
      { id: 'project-1' }
    ])
    expect(projectApplicationCommandContracts.delete.result.parse(undefined)).toBeUndefined()
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
})
