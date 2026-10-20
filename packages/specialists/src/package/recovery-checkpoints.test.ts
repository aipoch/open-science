import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { SpecialistRepository } from '../repository'
import { SpecialistPackageTransaction as Transaction } from './transaction'
import { fakeSkillParticipant } from '../../test/fixtures'
let storageRoot: string
beforeEach(async () => {
  storageRoot = join(tmpdir(), 'specialist-checkpoints-' + randomUUID())
  await mkdir(storageRoot)
})
afterEach(async () => {
  await rm(storageRoot, { recursive: true, force: true })
})
it.each([
  { checkpoint: 'prepared', phase: 'prepared', specialistLive: false, skillLive: false },
  {
    checkpoint: 'committing before Specialist swap',
    phase: 'committing',
    specialistLive: false,
    skillLive: false
  },
  {
    checkpoint: 'committing after Specialist swap',
    phase: 'committing',
    specialistLive: true,
    skillLive: false
  },
  {
    checkpoint: 'committing after Skill swap',
    phase: 'committing',
    specialistLive: true,
    skillLive: true
  },
  { checkpoint: 'committed', phase: 'committed', specialistLive: true, skillLive: true },
  {
    checkpoint: 'rolling back',
    phase: 'rolling-back',
    specialistLive: false,
    skillLive: false
  },
  { checkpoint: 'rolled back', phase: 'rolled-back', specialistLive: false, skillLive: false }
] as const)(
  'recovers a complete old or new package after restart at $checkpoint',
  async ({ checkpoint, phase, specialistLive }) => {
    const root = join(storageRoot, checkpoint.replaceAll(' ', '-'))
    await mkdir(root)
    const repository = new SpecialistRepository(root)
    const skillPort = {
      ...fakeSkillParticipant,
      recover: vi.fn(async () => {}),
      rollback: vi.fn(fakeSkillParticipant.rollback)
    }
    const before = await repository.getAll()
    const after = {
      ...before,
      specialists: [
        {
          id: 'interrupted-specialist',
          name: 'INTERRUPTED_SPECIALIST',
          displayName: 'Interrupted Specialist',
          description: 'A complete new state.',
          systemPrompt: 'Certified identity.',
          enabled: false,
          setupPending: true,
          capabilityMode: 'selected' as const,
          fullAccess: { excludedSkillIds: [], excludedConnectorIds: [], connectorTools: [] },
          selectedCapabilities: {
            skillIds: ['interrupted-skill'],
            connectorIds: [],
            connectorTools: []
          },
          revision: 1,
          packageVersion: '1.0.0',
          origin: 'imported' as const,
          ownedSkillIds: ['interrupted-skill']
        }
      ]
    }
    const transactionId = `restart-${checkpoint.toLowerCase().replaceAll(' ', '-').slice(0, 40)}`
    if (specialistLive) await repository.replaceAll(after)
    // Physical Skill publication is the participant owner's responsibility.
    if (phase === 'rolling-back' || phase === 'rolled-back') {
      await skillPort.rollback(transactionId)
      await repository.replaceAll(before)
    }
    await writeFile(
      join(root, 'specialist-package-transaction.json'),
      `${JSON.stringify({
        transactionId,
        phase,
        specialistId: 'interrupted-specialist',
        before,
        after
      })}\n`,
      'utf8'
    )

    const restarted = new Transaction(root, repository, undefined, skillPort)
    await restarted.recover()
    await restarted.recover()
    const recovered = await repository.getAll()

    if (phase === 'committed') {
      expect(recovered.specialists).toEqual(after.specialists)
      expect(skillPort.recover).toHaveBeenCalledWith(transactionId, 'commit')
    } else {
      expect(recovered).toEqual(before)
      if (phase === 'rolled-back')
        expect(skillPort.recover).not.toHaveBeenCalledWith(transactionId, expect.anything())
      else expect(skillPort.recover).toHaveBeenCalledWith(transactionId, 'rollback')
    }
  }
)
