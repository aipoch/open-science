import { createContext } from 'react'
import type { ArtifactReproducibilityOutputStorage } from '../../../../shared/artifact-reproducibility'

export const ReproducibilityOutputStorageContext = createContext<
  ArtifactReproducibilityOutputStorage | undefined
>(undefined)
