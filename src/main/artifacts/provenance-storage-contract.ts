import { reproductionRecipes, reproductionEvidence } from './reproducibility-host'
import type { ArtifactReproducibilityRecipe } from '@aipoch/reproducibility/contracts'
export const validateArtifactReproducibilityRecipeStorage = (
  recipe: ArtifactReproducibilityRecipe,
  storageRoot: string
): Promise<void> =>
  reproductionRecipes.validateArtifactReproducibilityRecipeStorage(
    recipe,
    reproductionEvidence(storageRoot)
  )
export {
  decodeArtifactReproducibilityReceipt,
  validateArtifactReproducibilityReceiptStorage
} from './artifact-reproducibility-receipts'
export { decodeArtifactExecutionSnapshot } from './provenance-execution-snapshot-decoder'
