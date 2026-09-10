import { isAbsolute, join, relative } from 'node:path'
import { inspect, inside } from './paths.mjs'
import { isReferenceFile } from './reference-bundle.mjs'

// Recovery receipts are input, not commands. Validate all derived paths before any cleanup/rename.
export async function validateJournal(journal, plan, file) {
  const stat = await inspect(file)
  if (!stat?.isFile() || stat.nlink !== 1)
    throw new Error('Migration journal must be a single-link regular file')
  if (
    ![1, 2].includes(journal.version) ||
    journal.home !== plan.home ||
    journal.configRoot !== plan.configRoot ||
    !['preparing', 'prepared', 'publishing', 'committed', 'rolling-back', 'rolled-back'].includes(
      journal.status
    ) ||
    !Array.isArray(journal.mappings) ||
    !Array.isArray(journal.participants)
  )
    throw new Error('Migration journal identity or schema mismatch')
  if (!journal.participants.length && !journal.mappings.length && journal.status === 'committed')
    return
  if (!/^[a-f0-9-]{36}$/.test(journal.id ?? '') || journal.platform !== plan.platform)
    throw new Error('Migration journal identity mismatch')
  const protectedPhase = journal.protectedMigration
  if (
    protectedPhase &&
    (protectedPhase.from !== plan.configRoot ||
      protectedPhase.to !== plan.configRoot ||
      protectedPhase.stage !== `${plan.configRoot}.brand-protected-stage-${journal.id}` ||
      protectedPhase.backup !== `${plan.configRoot}.brand-protected-backup-${journal.id}` ||
      !['preparing', 'publishing', 'committed'].includes(protectedPhase.status) ||
      JSON.stringify(protectedPhase.files) !==
        JSON.stringify(['open-science.db', 'open-science.db-wal', 'open-science.db-shm']))
  )
    throw new Error('Invalid protected migration paths')
  const paths = new Set()
  for (const m of journal.mappings) {
    if (
      ![m.from, m.to].every((p) => typeof p === 'string' && isAbsolute(p)) ||
      !['move', 'use-new'].includes(m.state)
    )
      throw new Error('Invalid journal mapping')
    if (inside(m.from, m.to) || inside(m.to, m.from)) throw new Error('Overlapping journal mapping')
  }
  const candidates = journal.mappings.map((m) => ({
    from: m.state === 'move' ? m.from : m.to,
    to: m.to
  }))
  candidates.push({ from: plan.configRoot, to: plan.configRoot })
  for (const p of [...journal.participants, ...(protectedPhase ? [protectedPhase] : [])]) {
    if (
      !candidates.some((c) => c.from === p.from && c.to === p.to) ||
      (p !== protectedPhase &&
        (p.stage !== `${p.to}.brand-stage-${journal.id}` ||
          p.backup !== `${p.from}.brand-backup-${journal.id}`)) ||
      inside(p.from, plan.stateDir) ||
      inside(p.to, plan.stateDir)
    )
      throw new Error('Invalid journal participant paths')
    if (
      p.files &&
      (p.from !== p.to ||
        !Array.isArray(p.files) ||
        new Set(p.files).size !== p.files.length ||
        p.files.some(
          (f) =>
            typeof f !== 'string' ||
            !isReferenceFile(f) ||
            isAbsolute(f) ||
            !inside(p.to, join(p.to, f)) ||
            relative(p.to, join(p.to, f)) !== f
        ))
    )
      throw new Error('Invalid journal reference bundle')
    for (const key of ['publishIntents', 'restoreIntents', 'rollbackOriginals'])
      if (
        p[key] !== undefined &&
        (!p.files || !Array.isArray(p[key]) || p[key].some((f) => !p.files.includes(f)))
      )
        throw new Error('Invalid journal member recovery state')
    for (const key of ['rollbackSnapshot', 'rollbackOriginalInPlace', 'restoreIntent', 'restored'])
      if (p[key] !== undefined && typeof p[key] !== 'boolean')
        throw new Error('Invalid journal participant recovery state')
    if (p.previousTarget) {
      const target = p.previousTarget
      if (
        p.files ||
        p.from === p.to ||
        target.backup !== `${p.to}.brand-existing-${journal.id}` ||
        !Array.isArray(target.original) ||
        !['empty', 'logs'].includes(target.kind) ||
        (target.kind === 'empty' && target.original.length !== 1) ||
        (target.kind === 'logs' &&
          !plan.mappings.some((m) => m.kind === 'logs' && m.from === p.from && m.to === p.to))
      )
        throw new Error('Invalid journal existing target')
    }
    for (const path of [p.stage, p.backup, p.previousTarget?.backup].filter(Boolean)) {
      if (paths.has(path)) throw new Error('Duplicate journal path')
      paths.add(path)
    }
    for (const manifest of [p.original, p.published, p.previousTarget?.original].filter(Boolean)) {
      if (!Array.isArray(manifest) || manifest[0]?.path !== '' || manifest[0]?.type !== 'directory')
        throw new Error('Invalid journal manifest')
      const entries = new Set()
      for (const e of manifest) {
        if (
          typeof e.path !== 'string' ||
          isAbsolute(e.path) ||
          !inside(p.to, join(p.to, e.path)) ||
          relative(p.to, join(p.to, e.path)) !== e.path ||
          entries.has(e.path) ||
          !['directory', 'file', 'symlink'].includes(e.type)
        )
          throw new Error('Invalid journal manifest entry')
        entries.add(e.path)
      }
    }
  }
  for (const a of journal.participants)
    for (const b of journal.participants) {
      if (
        a !== b &&
        a.files?.some((f) =>
          b.files
            ? b.files.some((g) => join(a.to, f) === join(b.to, g))
            : inside(b.to, join(a.to, f))
        )
      )
        throw new Error('Overlapping journal reference files')
      if (a !== b && !a.files && !b.files && (inside(a.from, b.from) || inside(a.to, b.to)))
        throw new Error('Overlapping journal participants')
    }
}
