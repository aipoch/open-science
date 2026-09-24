import { useTranslation } from 'react-i18next'
import type { AcpPermissionRequest } from '../../../../shared/acp'
import { WorkspaceToolCodeBlock } from './WorkspaceToolCodeBlock'

export function hasConfigurationPlan(request: AcpPermissionRequest): boolean {
  if (request.appOwned && request.approvalPlan?.format === 'json-v1') return true
  if (
    !request.appOwned ||
    !request.rawInput ||
    typeof request.rawInput !== 'object' ||
    !('configurationPlan' in request.rawInput)
  )
    return false
  const plan = request.rawInput.configurationPlan
  return Boolean(
    plan &&
    typeof plan === 'object' &&
    'kind' in plan &&
    ['package-installation', 'agent-configuration', 'skill-publication'].includes(String(plan.kind))
  )
}

type PlanPreview = {
  kind?: string
  target?:
    | string
    | { runtimeId?: string; label?: string; environmentName?: string; interpreterPath?: string }
  name?: string
  packages?: Array<{ name: string; version: string }>
  installed?: Array<{ name: string; version?: string }>
  files?: Array<{ path: string; content?: string; bytes: number }>
}

export function ConfigurationPlanDetail({
  request
}: {
  request: AcpPermissionRequest
}): React.JSX.Element {
  const { t } = useTranslation()
  const plan: PlanPreview = request.approvalPlan
    ? JSON.parse(request.approvalPlan.json)
    : (request.rawInput as { configurationPlan: PlanPreview }).configurationPlan
  const target =
    typeof plan.target === 'string'
      ? plan.target
      : (plan.target?.label ?? plan.target?.environmentName ?? plan.target?.runtimeId ?? plan.name)
  return (
    <div className="space-y-2">
      <p className="text-xs text-text-300">
        {t('Approval applies only to the target and content shown below.')}
      </p>
      {target ? (
        <p className="break-all text-sm">
          <span className="text-text-300">{t('Target')}: </span>
          {target}
        </p>
      ) : null}
      {plan.packages?.length ? (
        <table className="w-full text-left text-sm">
          <thead>
            <tr>
              <th className="py-1">{t('Package')}</th>
              <th>{t('Version')}</th>
            </tr>
          </thead>
          <tbody>
            {plan.packages.map((pkg) => {
              const before = plan.installed?.find((entry) => entry.name === pkg.name)?.version
              return (
                <tr key={pkg.name}>
                  <td className="py-1">{pkg.name}</td>
                  <td>{before ? `${before} → ${pkg.version}` : pkg.version}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      ) : null}
      {plan.files?.map((file) => (
        <details key={file.path} className="text-sm">
          <summary className="cursor-pointer break-all">{file.path}</summary>
          {file.content !== undefined ? (
            <WorkspaceToolCodeBlock code={file.content} language="text" copyable />
          ) : (
            <span>{file.bytes}</span>
          )}
        </details>
      ))}
      <details open={!plan.packages && !plan.files} className="text-xs text-text-300">
        <summary className="cursor-pointer">{t('Details')}</summary>
        <WorkspaceToolCodeBlock
          code={request.approvalPlan?.json ?? JSON.stringify(plan, null, 2)}
          copyable
        />
      </details>
    </div>
  )
}
