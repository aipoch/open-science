import {
  LiteratureCitationDocument as CitationDocument,
  type ReformattedCitationDocument,
  type ReformatCitationDocumentRequest
} from '@aipoch/literature-citations/documents'
import {
  artifactLiteratureManifestSchema,
  type ArtifactLiteratureManifest
} from '../../shared/artifact-literature'
export class LiteratureCitationDocument extends CitationDocument {
  override async reformat(
    request: Omit<ReformatCitationDocumentRequest, 'literature'> & {
      literature: ArtifactLiteratureManifest
    }
  ): Promise<
    Omit<ReformattedCitationDocument, 'literature'> & { literature: ArtifactLiteratureManifest }
  > {
    const literature = artifactLiteratureManifestSchema.parse(request.literature)
    const result = await super.reformat({ ...request, literature })
    return {
      ...result,
      literature: artifactLiteratureManifestSchema.parse({
        ...literature,
        styleId: request.styleId,
        locale: request.locale
      })
    }
  }
}
