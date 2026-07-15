import { describe, it, expect, vi } from 'vitest'
import { ParserEngine } from '../engine'
import type { ToolDescriptor } from '../types'
import { PUBMED_TOOLS } from './pubmed'

const jsonRes = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response

const textRes = (body: string): Response =>
  ({ ok: true, status: 200, text: async () => body }) as Response

const tool = (id: string): ToolDescriptor => PUBMED_TOOLS.find((t) => t.id === id)!

describe('pubmed connector (7 tools)', () => {
  it('exposes exactly the 7 official tool ids', () => {
    expect(PUBMED_TOOLS.map((t) => t.id).sort()).toEqual(
      [
        'convert_article_ids',
        'find_related_articles',
        'get_article_metadata',
        'get_copyright_status',
        'get_full_text_article',
        'lookup_article_by_citation',
        'search_articles'
      ].sort()
    )
  })

  it('search_articles: esearch page + total_count/has_more, threads email', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        esearchresult: {
          count: '100',
          idlist: ['1', '2', '3'],
          querytranslation: 'crispr[All Fields]'
        }
      })
    )
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('search_articles'),
      { query: 'crispr', max_results: 3, date_from: '2020', sort: 'pub_date' },
      { ncbiEmail: 'x@y.org', ncbiApiKey: 'KEY' }
    )) as Record<string, unknown>
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('esearch.fcgi')
    expect(url).toContain('term=crispr')
    expect(url).toContain('retmax=3')
    expect(url).toContain('mindate=2020')
    expect(url).toContain('datetype=pdat')
    expect(url).toContain('sort=pub_date')
    expect(url).toContain('email=x%40y.org')
    expect(url).toContain('api_key=KEY')
    expect(out).toEqual({
      pmids: ['1', '2', '3'],
      total_count: 100,
      returned_count: 3,
      query: 'crispr',
      query_translation: 'crispr[All Fields]',
      has_more: true
    })
  })

  it('get_article_metadata: parses efetch XML into the rich record shape', async () => {
    const xml =
      '<PubmedArticleSet><PubmedArticle>' +
      '<MedlineCitation><PMID Version="1">35486828</PMID><Article>' +
      '<Journal><Title>J Test</Title><ISOAbbreviation>J Tst</ISOAbbreviation>' +
      '<JournalIssue><Volume>39</Volume><Issue>7</Issue>' +
      '<PubDate><Year>2022</Year><Month>Jul</Month></PubDate></JournalIssue></Journal>' +
      '<ArticleTitle>A <i>study</i>.</ArticleTitle>' +
      '<Pagination><MedlinePgn>1195-1205</MedlinePgn></Pagination>' +
      '<Abstract><AbstractText Label="BG">Hello</AbstractText>' +
      '<AbstractText Label="RES">World</AbstractText></Abstract>' +
      '<AuthorList><Author><LastName>Ahn</LastName><ForeName>S J</ForeName><Initials>SJ</Initials>' +
      '<AffiliationInfo><Affiliation>Lab A</Affiliation></AffiliationInfo></Author>' +
      '<Author><CollectiveName>The Group</CollectiveName></Author></AuthorList>' +
      '<PublicationTypeList><PublicationType>Journal Article</PublicationType></PublicationTypeList>' +
      '<Language>eng</Language></Article>' +
      '<MeshHeadingList><MeshHeading><DescriptorName>Humans</DescriptorName></MeshHeading></MeshHeadingList>' +
      '</MedlineCitation>' +
      '<PubmedData><ArticleIdList>' +
      '<ArticleId IdType="pubmed">35486828</ArticleId>' +
      '<ArticleId IdType="pmc">PMC9046468</ArticleId>' +
      '<ArticleId IdType="doi">10.1/x</ArticleId>' +
      '</ArticleIdList></PubmedData>' +
      '</PubmedArticle></PubmedArticleSet>'
    const fetchImpl = vi.fn().mockResolvedValue(textRes(xml))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('get_article_metadata'),
      { pmids: ['35486828'] },
      { ncbiEmail: 'x@y.org' }
    )) as { articles: Record<string, unknown>[]; count: number; important_legal_notice: string }

    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('efetch.fcgi')
    expect(url).toContain('db=pubmed')
    expect(url).toContain('email=x%40y.org')
    expect(out.count).toBe(1)
    expect(out.important_legal_notice).toContain('According to PubMed')
    expect(out.articles[0]).toEqual({
      identifiers: { pmid: '35486828', pmc: 'PMC9046468', doi: '10.1/x' },
      title: 'A study.',
      abstract: 'Hello\nWorld',
      doi: '10.1/x',
      journal: { title: 'J Test', iso_abbreviation: 'J Tst' },
      authors: [
        { last_name: 'Ahn', fore_name: 'S J', initials: 'SJ', affiliations: ['Lab A'] },
        { collective_name: 'The Group', affiliations: [] }
      ],
      publication_date: { year: '2022', month: '07' },
      mesh_terms: ['Humans'],
      article_types: ['Journal Article'],
      language: 'eng',
      citation: { volume: '39', issue: '7', pages: '1195-1205' }
    })
  })

  it('find_related_articles: elink linkset reshape + max_results truncation', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        linksets: [
          {
            dbfrom: 'pubmed',
            ids: [35486828],
            linksetdbs: [{ dbto: 'pubmed', linkname: 'pubmed_pubmed', links: [1, 2, 3, 4] }]
          }
        ]
      })
    )
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('find_related_articles'),
      { pmids: ['35486828'], max_results: 2 },
      { ncbiEmail: 'x@y.org' }
    )) as { linksets: Record<string, unknown>[] }
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('elink.fcgi')
    expect(url).toContain('dbfrom=pubmed')
    expect(url).toContain('linkname=pubmed_pubmed')
    expect(url).toContain('id=35486828')
    expect(url).toContain('email=x%40y.org')
    expect(out.linksets).toEqual([
      {
        dbfrom: 'pubmed',
        ids: ['35486828'],
        linksetdbs: [{ dbto: 'pubmed', linkname: 'pubmed_pubmed', links: ['1', '2'] }]
      }
    ])
  })

  it('find_related_articles: pubmed_pmc derives db=pmc', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(jsonRes({ linksets: [] }))
    await new ParserEngine({ fetchImpl }).call(
      tool('find_related_articles'),
      { pmids: ['1'], link_type: 'pubmed_pmc' },
      {}
    )
    expect(String(fetchImpl.mock.calls[0][0])).toContain('db=pmc')
  })

  it('lookup_article_by_citation: builds bdata, parses pipe-delimited result', async () => {
    const respText =
      'science|1987|235|182|palmenberg ac|cit0|3026048\n' +
      'nature|2020|580|123|smith|cit1|AMBIGUOUS (2 matches)'
    const fetchImpl = vi.fn().mockResolvedValueOnce(textRes(respText))
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('lookup_article_by_citation'),
      {
        citations: [
          {
            journal: 'Science',
            year: 1987,
            volume: '235',
            first_page: '182',
            author: 'Palmenberg AC'
          },
          { journal: 'Nature', year: 2020, volume: '580', first_page: '123', author: 'Smith' }
        ]
      },
      { ncbiEmail: 'x@y.org' }
    )) as { citations: Record<string, unknown>[] }
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('ecitmatch.cgi')
    // bdata is URL-encoded: pipes -> %7C, \r -> %0D.
    expect(url).toContain('bdata=')
    expect(decodeURIComponent(url.split('bdata=')[1].split('&')[0])).toBe(
      'Science|1987|235|182|Palmenberg AC|cit0|\rNature|2020|580|123|Smith|cit1|'
    )
    expect(out.citations[0]).toEqual({
      journal: 'Science',
      year: '1987',
      volume: '235',
      first_page: '182',
      author: 'Palmenberg AC',
      pmid: '3026048',
      key: 'cit0'
    })
    expect(out.citations[1]).toMatchObject({
      pmid: null,
      key: 'cit1',
      status: 'ambiguous',
      detail: 'AMBIGUOUS (2 matches)'
    })
  })

  it('convert_article_ids: idconv request URL + record shape with explicit nulls', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        status: 'ok',
        records: [
          { 'requested-id': 'PMC9046468', pmcid: 'PMC9046468', pmid: 34713412, doi: '10.1/y' }
        ]
      })
    )
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('convert_article_ids'),
      { ids: ['PMC9046468'], id_type: 'pmcid' },
      { ncbiEmail: 'x@y.org', ncbiApiKey: 'KEY' }
    )) as { records: Record<string, unknown>[]; request: Record<string, unknown> }
    const url = String(fetchImpl.mock.calls[0][0])
    expect(url).toContain('idconv')
    expect(url).toContain('idtype=pmcid')
    expect(url).toContain('format=json')
    expect(url).toContain('email=x%40y.org')
    expect(url).toContain('api_key=KEY')
    expect(out.request.idtype).toBe('pmcid')
    expect(out.records[0]).toEqual({
      pmcid: 'PMC9046468',
      pmid: '34713412',
      doi: '10.1/y',
      'requested-id': 'PMC9046468'
    })
  })

  it('convert_article_ids: surfaces per-id error records', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        status: 'ok',
        records: [
          {
            'requested-id': '35486828',
            pmid: 35486828,
            status: 'error',
            errmsg: 'Identifier not found in PMC'
          }
        ]
      })
    )
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('convert_article_ids'),
      { ids: ['35486828'] },
      {}
    )) as { records: Record<string, unknown>[] }
    expect(out.records[0]).toEqual({
      pmcid: null,
      pmid: '35486828',
      doi: null,
      'requested-id': '35486828',
      status: 'error',
      errmsg: 'Identifier not found in PMC'
    })
  })

  it('get_full_text_article: OA article yields joined section full_text + license', async () => {
    const searchRes = jsonRes({
      resultList: {
        result: [
          {
            id: '9046468',
            pmid: '34713412',
            pmcid: 'PMC9046468',
            doi: '10.1/z',
            title: 'Search Title',
            isOpenAccess: 'Y',
            license: 'cc by'
          }
        ]
      }
    })
    const jats =
      '<article><front><article-meta><title-group>' +
      '<article-title>Full Title</article-title></title-group>' +
      '<abstract><title>Abstract</title><p>An abstract.</p></abstract>' +
      '</article-meta></front>' +
      '<body><sec sec-type="intro"><title>Introduction</title> <p>Intro text.</p></sec>' +
      '<sec><title>Results</title> <p>Result text.</p>' +
      '<fig><caption><p>should be excluded</p></caption></fig></sec></body></article>'
    const fetchImpl = vi
      .fn()
      .mockImplementation((url: string) =>
        Promise.resolve(url.includes('/search') ? searchRes : textRes(jats))
      )
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('get_full_text_article'),
      { pmc_ids: ['9046468'] },
      { ncbiEmail: 'x@y.org' }
    )) as { articles: Record<string, unknown>[]; count: number; important_legal_notice: string }
    // Bare digit was prefixed to PMC in the availability query and the fullTextXML path.
    expect(decodeURIComponent(String(fetchImpl.mock.calls[0][0]))).toContain('PMCID:PMC9046468')
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).includes('/PMC9046468/fullTextXML'))).toBe(
      true
    )
    expect(out.important_legal_notice).toContain('DOIs')
    expect(out.articles[0]).toEqual({
      identifiers: { pmcid: 'PMC9046468', pmid: '34713412', doi: '10.1/z' },
      title: 'Full Title',
      full_text: 'Introduction Intro text.\n\nResults Result text.',
      license: 'cc by',
      doi: '10.1/z',
      abstract: 'An abstract.'
    })
  })

  it('get_full_text_article: non-OA article reports fulltext_status', async () => {
    const fetchImpl = vi.fn().mockResolvedValueOnce(
      jsonRes({
        resultList: {
          result: [{ pmcid: 'PMC1', pmid: '1', isOpenAccess: 'N', abstractText: 'only abstract' }]
        }
      })
    )
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('get_full_text_article'),
      { pmc_ids: ['PMC1'] },
      {}
    )) as { articles: Record<string, unknown>[] }
    expect(out.articles[0]).toMatchObject({
      full_text: '',
      fulltext_status: 'not_open_access',
      abstract: 'only abstract'
    })
    // Only the availability search runs; no fullTextXML fetch for non-OA.
    expect(fetchImpl.mock.calls.length).toBe(1)
  })

  it('get_copyright_status: combines idconv + pubmed CI + pmc permissions', async () => {
    const idconv = jsonRes({
      status: 'ok',
      records: [{ 'requested-id': '35891187', pmcid: 'PMC8000000', pmid: 35891187, doi: '10.1/c' }]
    })
    const pubmedXml =
      '<PubmedArticleSet><PubmedArticle><MedlineCitation><PMID>35891187</PMID>' +
      '<Article><Abstract><AbstractText>x</AbstractText>' +
      '<CopyrightInformation>© 2022 The Authors</CopyrightInformation></Abstract></Article>' +
      '</MedlineCitation></PubmedArticle></PubmedArticleSet>'
    const pmcXml =
      '<pmc-articleset><article>' +
      '<front><article-meta>' +
      '<article-id pub-id-type="pmid">35891187</article-id>' +
      '<permissions><copyright-statement>© 2022 The Authors</copyright-statement>' +
      '<copyright-year>2022</copyright-year>' +
      '<license license-type="open-access"><license-p>CC BY</license-p>' +
      '<license_ref>https://creativecommons.org/licenses/by/4.0/</license_ref></license>' +
      '</permissions></article-meta></front></article></pmc-articleset>'
    const fetchImpl = vi.fn().mockImplementation((url: string) => {
      if (url.includes('idconv')) return Promise.resolve(idconv)
      if (url.includes('db=pmc')) return Promise.resolve(textRes(pmcXml))
      return Promise.resolve(textRes(pubmedXml))
    })
    const out = (await new ParserEngine({ fetchImpl }).call(
      tool('get_copyright_status'),
      { pmids: ['35891187'] },
      { ncbiEmail: 'x@y.org' }
    )) as { results: Record<string, unknown>[]; summary: Record<string, number> }
    // eutils calls carry etiquette.
    expect(
      fetchImpl.mock.calls
        .filter((c) => String(c[0]).includes('eutils'))
        .every((c) => String(c[0]).includes('email=x%40y.org'))
    ).toBe(true)
    expect(out.results[0]).toEqual({
      pmid: '35891187',
      pmc_id: 'PMC8000000',
      copyright: { statement: '© 2022 The Authors', year: 2022, holder: null },
      license: {
        type: 'open-access',
        url: 'https://creativecommons.org/licenses/by/4.0/',
        is_open_access: true
      },
      source: 'pmc',
      checked_sources: ['pubmed', 'pmc'],
      available_at: {
        pubmed_url: 'https://pubmed.ncbi.nlm.nih.gov/35891187/',
        pmc_url: 'https://pmc.ncbi.nlm.nih.gov/articles/PMC8000000/',
        doi_url: 'https://doi.org/10.1/c'
      }
    })
    expect(out.summary).toEqual({
      total_checked: 1,
      found_in_pubmed: 0,
      found_in_pmc: 1,
      not_found: 0,
      open_access_count: 1
    })
  })
})
