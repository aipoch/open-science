import type {
  AgentComputeHostSummary,
  ComputeHost,
  ComputeHostDetails,
  DetailsAuthor,
  ExecResult,
  JobResult,
  JobStatusResult,
  SubmitJobResult
} from '../../shared/compute'
import { ComputeHostUnavailableError, computeHostSummary } from '../../shared/compute'
import type { DownloadDest, LocalFile } from '../../shared/remote-fs'
import type { ComputeService } from './compute-service'

type SessionComputeHostRegistry = Readonly<{
  getEnabled(sessionId: string): string[]
  getSelected(sessionId: string): string[]
}>

type AgentComputeContext = Readonly<{ sessionId: string; projectId: string }>

type RawComputeService = Pick<
  ComputeService,
  | 'list'
  | 'getDetails'
  | 'appendDetails'
  | 'replaceDetails'
  | 'callCommand'
  | 'download'
  | 'submitJob'
  | 'getJobStatus'
  | 'getJobResult'
  | 'setSessionConcurrencyLimit'
  | 'getSessionConcurrencyStatus'
>

// The only Compute facade exposed to Agent RPC. Global ComputeService remains unrestricted for
// Settings and internal runtimes; every Agent provider operation passes through Session admission.
export class AgentComputeService {
  constructor(
    private readonly compute: RawComputeService,
    private readonly registry: SessionComputeHostRegistry
  ) {}

  private enabledIds(sessionId: string): string[] {
    return this.registry.getEnabled(sessionId)
  }

  private async requireEnabled(sessionId: string, providerId: string): Promise<void> {
    if (!this.enabledIds(sessionId).includes(providerId)) throw new ComputeHostUnavailableError()
    // A stale Session projection must not turn a removed global host into a distinguishable error.
    const configured = await this.compute.list()
    if (!configured.some((host) => host.providerId === providerId)) {
      throw new ComputeHostUnavailableError()
    }
  }

  async list(sessionId: string): Promise<ComputeHost[]> {
    const enabled = new Set(this.enabledIds(sessionId))
    if (enabled.size === 0) return []
    return (await this.compute.list()).filter((host) => enabled.has(host.providerId))
  }

  async listHosts(sessionId: string): Promise<AgentComputeHostSummary[]> {
    const enabled = new Set(this.enabledIds(sessionId))
    const selected = new Set(
      this.registry.getSelected(sessionId).filter((providerId) => enabled.has(providerId))
    )
    const hosts = await this.list(sessionId)
    return hosts.map((host) => ({
      ...computeHostSummary(host),
      role: selected.has(host.providerId) ? 'selected' : 'available'
    }))
  }

  // Compatibility name: registered-but-disabled hosts are intentionally no longer returned.
  listRegistered(sessionId: string): Promise<AgentComputeHostSummary[]> {
    return this.listHosts(sessionId)
  }

  async listPreferred(sessionId: string): Promise<AgentComputeHostSummary[]> {
    return (await this.listHosts(sessionId)).filter((host) => host.role === 'selected')
  }

  listCompute(sessionId: string): string[] {
    return this.enabledIds(sessionId)
  }

  async getDetails(sessionId: string, providerId: string): Promise<ComputeHostDetails> {
    await this.requireEnabled(sessionId, providerId)
    return this.compute.getDetails(providerId)
  }

  async appendDetails(
    sessionId: string,
    providerId: string,
    request: { text: string; author: DetailsAuthor }
  ): Promise<void> {
    await this.requireEnabled(sessionId, providerId)
    return this.compute.appendDetails(providerId, request)
  }

  async replaceDetails(
    sessionId: string,
    providerId: string,
    request: { text: string; oldText: string; author: DetailsAuthor }
  ): Promise<void> {
    await this.requireEnabled(sessionId, providerId)
    return this.compute.replaceDetails(providerId, request)
  }

  async callCommand(
    context: AgentComputeContext,
    providerId: string,
    cmd: string,
    intent: string,
    loginShell = true,
    timeoutSeconds?: number
  ): Promise<ExecResult> {
    await this.requireEnabled(context.sessionId, providerId)
    return this.compute.callCommand(providerId, cmd, intent, loginShell, timeoutSeconds, context)
  }

  async download(
    context: AgentComputeContext,
    providerId: string,
    remotePath: string,
    dest: DownloadDest
  ): Promise<LocalFile> {
    await this.requireEnabled(context.sessionId, providerId)
    return this.compute.download(providerId, remotePath, dest, context)
  }

  async submitJob(
    context: AgentComputeContext,
    providerId: string,
    intent: string,
    command: string,
    options: Parameters<RawComputeService['submitJob']>[3]
  ): Promise<SubmitJobResult> {
    await this.requireEnabled(context.sessionId, providerId)
    return this.compute.submitJob(providerId, intent, command, options, context)
  }

  async getJobStatus(
    context: AgentComputeContext,
    providerId: string,
    jobId: string
  ): Promise<JobStatusResult> {
    await this.requireEnabled(context.sessionId, providerId)
    return this.compute.getJobStatus(jobId, { ...context, providerId })
  }

  async getJobResult(
    context: AgentComputeContext,
    providerId: string,
    jobId: string
  ): Promise<JobResult> {
    await this.requireEnabled(context.sessionId, providerId)
    return this.compute.getJobResult(jobId, { ...context, providerId })
  }

  setSessionConcurrencyLimit(sessionId: string, limit: number): Promise<void> {
    return this.compute.setSessionConcurrencyLimit(sessionId, limit)
  }

  getSessionConcurrencyStatus(
    sessionId: string
  ): ReturnType<ComputeService['getSessionConcurrencyStatus']> {
    return this.compute.getSessionConcurrencyStatus(sessionId)
  }
}

export type { AgentComputeContext, RawComputeService, SessionComputeHostRegistry }
