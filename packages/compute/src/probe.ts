export type ProbeScriptOutput = {
  os?: string
  cpus?: number
  memMib?: number
  gpus?: Array<{ type: string; count: number }>
  detectedScheduler?: 'slurm' | 'pbs' | 'lsf' | 'none'
  scratchEnv?: string
  scratchPath?: string
  scratchWritable?: boolean
  schedulerAvailable?: boolean
}

const aggregateGpus = (raw: string): Array<{ type: string; count: number }> => {
  if (!raw.trim()) return []
  const models = raw
    .split(';')
    .map((model) => model.trim())
    .filter(Boolean)
  const counts = new Map<string, number>()
  for (const model of models) counts.set(model, (counts.get(model) ?? 0) + 1)
  return Array.from(counts.entries()).map(([type, count]) => ({ type, count }))
}

export const parseProbeOutput = (stdout: string): ProbeScriptOutput => {
  const values: Record<string, string> = {}
  for (const line of stdout.split('\n')) {
    const separator = line.indexOf('=')
    if (separator === -1) continue
    values[line.slice(0, separator).trim()] = line.slice(separator + 1).trim()
  }

  const cpus = Number.parseInt(values['cpus'] ?? '', 10)
  const memMib = Number.parseInt(values['mem_mib'] ?? '', 10)
  const detectedScheduler: ProbeScriptOutput['detectedScheduler'] =
    values['sbatch'] === 'yes'
      ? 'slurm'
      : values['qsub'] === 'yes'
        ? 'pbs'
        : values['bsub'] === 'yes'
          ? 'lsf'
          : ['sbatch', 'qsub', 'bsub'].every((key) => values[key] === 'no')
            ? 'none'
            : undefined

  return {
    os: values['os'] || undefined,
    cpus: Number.isFinite(cpus) && cpus > 0 ? cpus : undefined,
    memMib: Number.isFinite(memMib) && memMib > 0 ? memMib : undefined,
    gpus: aggregateGpus(values['gpus'] ?? ''),
    detectedScheduler,
    scratchEnv: values['scratch'] || undefined,
    scratchPath: values['scratch_path'] || undefined,
    scratchWritable:
      values['scratch_writable'] === 'yes'
        ? true
        : values['scratch_writable'] === 'no'
          ? false
          : undefined,
    schedulerAvailable:
      values['scheduler_available'] === 'yes'
        ? true
        : values['scheduler_available'] === 'no'
          ? false
          : undefined
  }
}
