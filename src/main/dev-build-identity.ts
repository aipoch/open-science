// Replaced by the backend builder only for development builds. Release builds cannot opt in
// through argv or inherited environment variables.
export const devBuildIdentity: { buildId: string; workspaceRoot: string } | undefined = undefined
