export interface AnalysisConfiguration {
  /** Repository-relative registry with a packages: [{ root }] array. Read as JSON from the revision. */
  packageRegistry?: string
  /** Trusted source aliases, relative to the revision root. No candidate tsconfig is loaded. */
  sourcePaths?: Record<string, string[]>
}

export interface AnalyzeRevisionOptions {
  repository: string
  revision: string
  configuration?: AnalysisConfiguration
}

export interface StaticFileEvidence {
  path: string
  dependencies: string[]
  unresolved: string[]
}

export interface StaticImpactReport {
  schemaVersion: 1
  purpose: 'diagnostic'
  canPruneTests: false
  revision: string
  engine: { name: 'dependency-cruiser'; version: string }
  sourcePaths: Record<string, string[]>
  limitations: string[]
  files: StaticFileEvidence[]
}
