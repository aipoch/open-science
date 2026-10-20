import { persistentContentReferences } from '../storage/prisma-content-references'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { inspectPdfPageCount } from '../uploads/attachment-media'

import { tmpdir } from 'node:os'

import { join } from 'node:path'

import { createProjectDbClient, migrateApplicationDatabase } from '../projects/prisma-client'

import { ContentRepository } from '../storage/content-repository'

import { LiteratureCatalog } from './catalog'

import { expect, it, vi } from 'vitest'

import { literatureItemInputSchema } from '@aipoch/literature-library/item'
import { type LiteratureItemView } from '@aipoch/literature-library/contracts'

import {
  LiteratureFullTextFinder,
  type LiteratureFullTextFinderOptions
} from '@aipoch/literature-discovery'

const setup = (): {
  finder: LiteratureFullTextFinder
  options: LiteratureFullTextFinderOptions
  item: LiteratureItemView
} => {
  const item: LiteratureItemView = {
    id: 'item-1',
    metadataRevision: 1,
    createdAt: 1,
    updatedAt: 1,
    attachments: [],
    projectIds: [],
    collectionIds: [],
    item: literatureItemInputSchema.parse({
      title: 'Example paper',
      itemType: 'journalArticle',
      identifiers: [{ scheme: 'doi', value: '10.1000/example' }]
    })
  }
  const options: LiteratureFullTextFinderOptions = {
    catalog: {
      get: vi.fn(async () => item),
      attachContent: vi.fn(async () => ({ attachmentId: 'attachment-1', versionId: 'version-1' }))
    },
    content: {
      withPublishedContent: vi.fn(async ({ sourcePath }, acquire) => {
        const bytes = await readFile(sourcePath)
        return acquire({
          id: 'blob-1',
          path: sourcePath,
          storageKey: 'blob-1',
          sizeBytes: BigInt(bytes.length),
          checksum: 'a'.repeat(64),
          contentType: 'application/pdf'
        })
      })
    },
    openAlexKey: vi.fn(async () => undefined),
    fetch: vi.fn(async (input) =>
      new URL(String(input)).hostname === 'pmc.ncbi.nlm.nih.gov'
        ? Response.json({ records: [] })
        : Response.json({
            resultList: {
              result: [
                {
                  doi: '10.1000/example',
                  fullTextUrlList: {
                    fullTextUrl: [
                      {
                        availabilityCode: 'OA',
                        documentStyle: 'pdf',
                        site: 'Example journal',
                        url: 'https://journal.example/paper.pdf'
                      },
                      {
                        availabilityCode: 'S',
                        documentStyle: 'pdf',
                        site: 'Subscription',
                        url: 'https://journal.example/paid.pdf'
                      },
                      {
                        availabilityCode: 'OA',
                        documentStyle: 'html',
                        url: 'https://journal.example/paper'
                      }
                    ]
                  }
                },
                {
                  doi: '10.1000/other',
                  fullTextUrlList: {
                    fullTextUrl: [
                      {
                        availabilityCode: 'OA',
                        documentStyle: 'pdf',
                        url: 'https://journal.example/other.pdf'
                      }
                    ]
                  }
                }
              ]
            }
          })
    ),
    download: vi.fn(async () => Buffer.from('%PDF-1.7\nexample')),
    pageCount: vi.fn(async () => 8)
  }
  return { finder: new LiteratureFullTextFinder(options), options, item }
}

const twoPagePdf = (): Buffer => {
  const pageTwoStream = 'BT /F1 12 Tf 10 50 Td (Page two claim) Tj ET'
  const objects = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 5 0 R /Resources << >> >>\nendobj\n',
    '4 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Contents 6 0 R /Resources << /Font << /F1 7 0 R >> >> >>\nendobj\n',
    '5 0 obj\n<< /Length 0 >>\nstream\n\nendstream\nendobj\n',
    `6 0 obj\n<< /Length ${pageTwoStream.length} >>\nstream\n${pageTwoStream}\nendstream\nendobj\n`,
    '7 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n'
  ]
  let pdf = '%PDF-1.4\n'
  const offsets = objects.map((object) => {
    const offset = Buffer.byteLength(pdf)
    pdf += object
    return offset
  })
  const xref = Buffer.byteLength(pdf)
  pdf += `xref\n0 8\n0000000000 65535 f \n${offsets
    .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
    .join('')}trailer\n<< /Size 8 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return Buffer.from(pdf)
}

it('retains the selected manuscript source after the downloaded PDF is persisted and reopened', async () => {
  const storageRoot = await mkdtemp(join(tmpdir(), 'full-text-provenance-'))
  let client = createProjectDbClient(storageRoot)
  try {
    await migrateApplicationDatabase(client)
    let catalog = new LiteratureCatalog(async () => client)
    const content = new ContentRepository({
      references: persistentContentReferences,
      storageRoot,
      getClient: async () => client
    })
    const created = await catalog.transact({ kind: 'create-item', item: setup().item.item })
    const bytes = twoPagePdf()
    const finder = new LiteratureFullTextFinder({
      pageCount: inspectPdfPageCount,
      catalog,
      content,
      openAlexKey: async () => undefined,
      contactEmail: async () => 'research@lab.org',
      fetch: async (input) => {
        const host = new URL(String(input)).hostname
        if (host === 'api.unpaywall.org')
          return Response.json({
            doi: '10.1000/example',
            oa_locations: [
              {
                url_for_pdf: 'https://repository.example/manuscript.pdf',
                url_for_landing_page: 'https://repository.example/article',
                repository_institution: 'Example repository',
                version: 'acceptedVersion',
                license: 'cc-by'
              }
            ]
          })
        return host === 'pmc.ncbi.nlm.nih.gov'
          ? Response.json({ records: [] })
          : Response.json({ resultList: { result: [] } })
      },
      download: async () => bytes
    })
    const found = await finder.run({ mode: 'search', itemId: created.id })
    if (found.mode !== 'search') throw new Error('Expected search')
    expect(found.candidates).toHaveLength(1)
    expect(found.candidates[0]).toMatchObject({
      provider: 'unpaywall',
      sourceUrl: 'https://repository.example/article',
      version: 'accepted',
      license: 'cc-by'
    })
    await finder.run({ mode: 'attach', itemId: created.id, candidateId: found.candidates[0].id })
    await client.$disconnect()
    client = createProjectDbClient(storageRoot)
    catalog = new LiteratureCatalog(async () => client)
    const saved = await catalog.get(created.id)
    expect(saved?.attachments).toHaveLength(1)
    const version = saved!.attachments[0].versions[0]
    expect(version.pageCount).toBe(2)
    const row = await client.literatureAttachmentVersion.findUniqueOrThrow({
      where: { id: version.id }
    })
    const opened = await content.open(row.contentBlobId)
    expect(await readFile(opened.path)).toEqual(bytes)
    expect(version.provenance).toMatchObject({
      provider: 'unpaywall',
      sourceUrl: 'https://repository.example/article',
      version: 'accepted',
      license: 'cc-by',
      acquiredAt: expect.any(Number)
    })
    expect(JSON.parse(row.provenanceJson!)).toEqual(version.provenance)
  } finally {
    await client.$disconnect()
    await rm(storageRoot, { recursive: true, force: true })
  }
})
