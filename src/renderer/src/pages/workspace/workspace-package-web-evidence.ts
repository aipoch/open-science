import { isBuiltinWebActivity } from './workspace-web-fetch-details'
import type { ToolActivity } from '@/stores/session-store-contract'
import {
  packageWebActivityEvidenceSchema,
  type PackageWebActivityEvidence
} from '../../../../shared/session-package-web'

// This packet is saved, policy-filtered display data. It never establishes live tool authority.
export const readPackageWebEvidence = (
  activity: Pick<
    ToolActivity,
    'id' | 'packageWebEvidence' | 'executionInvocationId' | 'providerToolName' | 'appOwned'
  >
): PackageWebActivityEvidence | undefined => {
  const parsed = packageWebActivityEvidenceSchema.safeParse(activity.packageWebEvidence)
  return parsed.success &&
    parsed.data.activityId === activity.id &&
    parsed.data.invocationId === activity.executionInvocationId &&
    isBuiltinWebActivity(activity as ToolActivity, parsed.data.operation)
    ? parsed.data
    : undefined
}
