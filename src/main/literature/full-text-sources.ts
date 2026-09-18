import { LiteratureProviderError } from './provider-error'
import { z } from 'zod'
import {
  normalizeLiteratureIdentifierValue,
  type LiteratureFullTextCandidate
} from '../../shared/literature'
import { netFetchStandard } from '../skills/net-fetch'
import { fullTextUrl } from './full-text-download'

type Candidate = Omit<LiteratureFullTextCandidate, 'id'>
type Identifiers = { doi?: string; pmid?: string; pmcid?: string }
const optionalText = z.string().nullish()

// Discovery reads metadata only; PDFs are downloaded after the user selects a candidate.
export const readFullTextProvider = async (
  url: string,
  fetcher: typeof fetch = netFetchStandard
): Promise<string | undefined> => {
  const response = await fetcher(url, {
    redirect: 'error',
    headers: { Accept: 'application/json, application/xml' },
    signal: AbortSignal.timeout(15_000)
  })
  if (response.status === 404) {
    await response.body?.cancel()
    return undefined
  }
  if (!response.ok) {
    await response.body?.cancel()
    throw new LiteratureProviderError(response.status)
  }
  if (!response.body) throw new Error('Full-text provider returned an empty response.')
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let length = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      length += value.length
      if (length > 2 * 1024 * 1024) throw new Error('Full-text provider response is too large.')
      chunks.push(value)
    }
  } finally {
    await reader.cancel()
  }
  return Buffer.concat(chunks).toString('utf8')
}

const unpaywallLocation = z.object({
  url_for_pdf: optionalText,
  url_for_landing_page: optionalText,
  repository_institution: optionalText,
  license: optionalText,
  version: optionalText
})
export const findUnpaywallPdfs = async (
  doi: string,
  email: string,
  fetcher?: typeof fetch
): Promise<Candidate[]> => {
  doi = normalizeLiteratureIdentifierValue('doi', doi).toLowerCase()
  const url = new URL(`https://api.unpaywall.org/v2/${encodeURIComponent(doi)}`)
  url.searchParams.set('email', z.string().email().parse(email))
  const raw = await readFullTextProvider(url.href, fetcher)
  if (raw === undefined) return []
  const work = z
    .object({
      doi: z.string(),
      best_oa_location: unpaywallLocation.nullish(),
      oa_locations: z.array(unpaywallLocation).optional()
    })
    .parse(JSON.parse(raw))
  if (normalizeLiteratureIdentifierValue('doi', work.doi).toLowerCase() !== doi) return []
  return [work.best_oa_location, ...(work.oa_locations ?? [])].flatMap((entry): Candidate[] => {
    if (!entry?.url_for_pdf) return []
    return [
      {
        provider: 'unpaywall',
        url: entry.url_for_pdf,
        sourceUrl: entry.url_for_landing_page || `https://doi.org/${doi}`,
        source: entry.repository_institution || 'Unpaywall',
        license: entry.license || undefined,
        version:
          entry.version === 'publishedVersion'
            ? 'published'
            : entry.version === 'acceptedVersion'
              ? 'accepted'
              : entry.version === 'submittedVersion'
                ? 'submitted'
                : undefined
      }
    ]
  })
}

const matches = (expected: Identifiers, actual: Identifiers): boolean => {
  const pairs = [
    [
      expected.doi,
      actual.doi ? normalizeLiteratureIdentifierValue('doi', actual.doi).toLowerCase() : undefined
    ],
    [expected.pmid, actual.pmid],
    [expected.pmcid?.toUpperCase(), actual.pmcid?.toUpperCase()]
  ]
  return pairs.some(([a, b]) => a && a === b) && !pairs.some(([a, b]) => a && b && a !== b)
}
const pmcMetadata = z.object({
  pmcid: z.string(),
  version: z.number().int().positive(),
  pmid: z.union([z.string(), z.number()]).nullish(),
  doi: optionalText,
  is_manuscript: z.boolean().optional(),
  license_code: optionalText,
  pdf_url: optionalText
})

export const findPmcPdfs = async (
  identifiers: Identifiers,
  fetcher?: typeof fetch
): Promise<{ candidates: Candidate[]; noRecord: boolean }> => {
  if (identifiers.doi) {
    identifiers = {
      ...identifiers,
      doi: normalizeLiteratureIdentifierValue('doi', identifiers.doi).toLowerCase()
    }
  }
  let pmcid = identifiers.pmcid?.toUpperCase()
  if (!pmcid) {
    const identifier = identifiers.doi || identifiers.pmid
    if (!identifier) return { candidates: [], noRecord: true }
    const url = new URL('https://pmc.ncbi.nlm.nih.gov/tools/idconv/api/v1/articles/')
    url.search = new URLSearchParams({
      ids: identifier,
      idtype: identifiers.doi ? 'doi' : 'pmid',
      format: 'json',
      tool: 'OpenScience'
    }).toString()
    const raw = await readFullTextProvider(url.href, fetcher)
    if (raw === undefined) return { candidates: [], noRecord: true }
    const result = z
      .object({
        records: z.array(z.object({ pmcid: optionalText, pmid: optionalText, doi: optionalText }))
      })
      .parse(JSON.parse(raw))
    pmcid = result.records
      .find((entry) =>
        matches(identifiers, {
          doi: entry.doi ?? undefined,
          pmid: entry.pmid ?? undefined,
          pmcid: entry.pmcid ?? undefined
        })
      )
      ?.pmcid?.toUpperCase()
  }
  if (!pmcid || !/^PMC\d+$/u.test(pmcid)) return { candidates: [], noRecord: true }
  const bucket = 'https://pmc-oa-opendata.s3.amazonaws.com'
  const listing = await readFullTextProvider(
    `${bucket}/?${new URLSearchParams({ 'list-type': '2', prefix: `${pmcid}.`, delimiter: '/', 'max-keys': '10' })}`,
    fetcher
  )
  if (listing === undefined) return { candidates: [], noRecord: false }
  // S3 returns a fixed XML vocabulary; only numeric PMC version prefixes are accepted.
  if (
    !listing.includes('<ListBucketResult') ||
    !listing.includes('<IsTruncated>false</IsTruncated>')
  )
    throw new Error('PMC version listing is incomplete.')
  const prefixes = [
    ...listing.matchAll(
      /<CommonPrefixes>\s*<Prefix>(PMC\d+\.\d+)\/<\/Prefix>\s*<\/CommonPrefixes>/gu
    )
  ]
    .map((match) => match[1])
    .filter((prefix) => prefix.startsWith(`${pmcid}.`))
    .slice(0, 10)
  const candidates: Candidate[] = []
  for (const prefix of prefixes) {
    const raw = await readFullTextProvider(`${bucket}/${prefix}/${prefix}.json`, fetcher)
    if (raw === undefined) continue
    const metadata = pmcMetadata.parse(JSON.parse(raw))
    if (
      `${metadata.pmcid}.${metadata.version}` !== prefix ||
      !matches(
        { ...identifiers, pmcid },
        {
          pmcid: metadata.pmcid,
          pmid: metadata.pmid == null ? undefined : String(metadata.pmid),
          doi: metadata.doi ?? undefined
        }
      ) ||
      !metadata.pdf_url
    )
      continue
    let url: URL
    try {
      url = fullTextUrl(
        metadata.pdf_url.startsWith('s3://pmc-oa-opendata/')
          ? metadata.pdf_url.replace('s3://pmc-oa-opendata/', `${bucket}/`)
          : metadata.pdf_url
      )
    } catch {
      continue
    }
    if (
      url.origin !== bucket ||
      !url.pathname.startsWith(`/${prefix}/`) ||
      !url.pathname.toLowerCase().endsWith('.pdf')
    )
      continue
    candidates.push({
      provider: 'pmc',
      source: 'PubMed Central',
      url: url.href,
      sourceUrl: `https://pmc.ncbi.nlm.nih.gov/articles/${prefix}/`,
      license: metadata.license_code || undefined,
      version: metadata.is_manuscript ? 'accepted' : undefined
    })
  }
  return { candidates, noRecord: false }
}
