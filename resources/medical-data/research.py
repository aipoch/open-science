"""Official molecular research services; no API keys or copied browser sessions."""
from contextlib import closing
from pathlib import Path
from urllib.parse import urlencode, quote, urljoin, urlsplit
import csv
import gzip
import json
import re
import uuid
import xml.etree.ElementTree as ET

import httpx
from core import DataError, Links, now, file_hash


class Research:
    def __init__(self, store):
        self.store = store

    def request(self, url, *, payload=None, accept='application/json', as_json=True):
        self.store.allowed_url(url)
        try:
            with httpx.Client(timeout=90, transport=self.store.transport, follow_redirects=False) as client:
                for _ in range(6):
                    self.store.allowed_url(url)
                    method = 'POST' if payload is not None else 'GET'
                    response = client.send(client.build_request(method, url, json=payload,
                        headers={'Accept': accept, 'User-Agent': 'OpenScience-MedicalDataMCP/0.4'}), stream=True)
                    with closing(response):
                        if response.status_code in (301, 302, 303, 307, 308):
                            location = response.headers.get('location')
                            if not location or payload is not None:
                                raise DataError('Official service returned an unexpected redirect or access page.')
                            url = urljoin(url, location)
                            continue
                        if response.status_code >= 400:
                            raise DataError(f'Official service returned HTTP {response.status_code}; no automatic retry or access bypass.')
                        chunks, total = [], 0
                        for block in response.iter_bytes():
                            total += len(block)
                            if total > 16 * 1024 * 1024:
                                raise DataError('API response exceeds 16 MiB; use a smaller query or official bulk file.')
                            chunks.append(block)
                        text = b''.join(chunks).decode('utf-8', errors='replace')
                        if as_json:
                            value = json.loads(text)
                            if isinstance(value, dict) and any(k.lower() in ('error', 'errors') and value[k] for k in value):
                                raise DataError('Official service returned an error object; query was not successful.')
                            return value
                        return text
                raise DataError('Too many official redirects.')
        except (httpx.HTTPError, json.JSONDecodeError):
            raise DataError('Official service response unavailable or invalid; no automatic retry.') from None

    def save(self, value, label, url):
        target = self.store.root / 'exports' / f'{label}_{uuid.uuid4().hex}.json'
        target.write_text(json.dumps(value, ensure_ascii=False), encoding='utf-8')
        return {'source_url': url, 'retrieved_at': now(), 'raw_response_path': str(target)}

    def files_from_page(self, url, pattern):
        parser = Links()
        parser.feed(self.request(url, accept='text/html', as_json=False))
        urls = sorted({urljoin(url, href) for href in parser.links if re.search(pattern, href)})
        urls = [u for u in urls if urlsplit(u).hostname in self.store.config['hosts'] and '{' not in u]
        if not urls:
            raise DataError('No official file links were found; this is not evidence that the dataset is empty.')
        return {'source_url': url, 'retrieved_at': now(), 'files': [{'filename': Path(urlsplit(u).path).name, 'url': u} for u in urls]}

    def hgnc(self, mode, field, value, max_rows=20):
        if mode not in ('search', 'fetch') or not re.fullmatch(r'[a-z_]+', field) or not value or len(value) > 500:
            raise DataError('Use a documented HGNC field and a nonempty value of at most 500 characters.')
        if not 1 <= max_rows <= 500:
            raise DataError('max_rows must be 1–500.')
        url = f'https://rest.genenames.org/{mode}/{field}/{quote(value, safe="")}'
        raw = self.request(url)
        response = raw.get('response', {})
        docs = response.get('docs')
        if not isinstance(docs, list):
            raise DataError('HGNC response has no record list.')
        return {**self.save(raw, f'hgnc_{mode}', url), 'num_found': response.get('numFound'),
                'returned_count': min(len(docs), max_rows), 'records': docs[:max_rows],
                'truncated': len(docs) > max_rows or response.get('numFound', len(docs)) > len(docs),
                'scope': 'search returns indexed identifiers; fetch returns complete records'}

    def hgnc_files(self, prefix='hgnc/tsv/tsv/', cursor='', limit=100):
        if not prefix.startswith('hgnc/') or '..' in prefix or not 1 <= limit <= 500:
            raise DataError('Use an HGNC bucket prefix and limit 1–500.')
        url = 'https://storage.googleapis.com/public-download-files?' + urlencode({'prefix': prefix, 'marker': cursor, 'max-keys': limit})
        try:
            root = ET.fromstring(self.request(url, accept='application/xml', as_json=False))
        except ET.ParseError:
            raise DataError('HGNC official file index is not valid XML.') from None
        files = []
        for item in root.findall('{*}Contents'):
            key = item.findtext('{*}Key')
            files.append({'filename': Path(key).name, 'key': key,
                'url': 'https://storage.googleapis.com/public-download-files/' + quote(key, safe='/'),
                'bytes': int(item.findtext('{*}Size')), 'etag': item.findtext('{*}ETag'),
                'last_modified': item.findtext('{*}LastModified')})
        return {'source_url': url, 'files': files, 'truncated': root.findtext('{*}IsTruncated') == 'true',
                'next_cursor': root.findtext('{*}NextMarker') or (files[-1]['key'] if files else ''),
                'checksum_note': 'ETag is an object identity, not a claimed SHA256. download_file computes SHA256.'}

    def chea3(self, genes, query_name, top_n):
        if not genes or len(genes) > 2000 or not all(isinstance(g, str) and re.fullmatch(r'[A-Za-z0-9_.-]{1,80}', g) for g in genes):
            raise DataError('Supply 1–2000 gene symbols, not free text or patient information.')
        if not 1 <= top_n <= 500 or len(query_name) > 100:
            raise DataError('top_n must be 1–500; query_name is at most 100 characters.')
        url = 'https://maayanlab.cloud/chea3/api/enrich/'
        unique = list(dict.fromkeys(g.strip() for g in genes))
        raw = self.request(url, payload={'query_name': query_name, 'gene_set': unique})
        if not isinstance(raw, dict) or not raw or not all(isinstance(v, list) for v in raw.values()):
            raise DataError('ChEA3 response did not contain library ranking lists.')
        return {**self.save(raw, 'chea3', url), 'submitted_gene_count': len(unique),
                'recognized_gene_count': None, 'recognized_genes': None,
                'libraries': {key: {'records': rows[:top_n], 'total_records': len(rows), 'truncated': len(rows) > top_n} for key, rows in raw.items()},
                'note': 'Upstream does not identify all recognized input genes. TF ranking is hypothesis evidence, not causal validation.'}

    def biodbnet(self, method, params):
        url = 'https://biodbnet-abcc.ncifcrf.gov/webServices/rest.php/biodbnetRestApi.json?' + urlencode({'method': method, **params})
        raw = self.request(url)
        def bounded(value):
            if isinstance(value, str):
                return value if len(value) <= 2000 else value[:2000] + '… [read full raw_response_path]'
            if isinstance(value, list):
                return [bounded(item) for item in value[:100]]
            if isinstance(value, dict):
                return {key: bounded(item) for key, item in value.items()}
            return value
        preview = bounded(raw)
        return {**self.save(raw, f'biodbnet_{method}', url), 'result': preview,
                'truncated': preview != raw,
                'total_records': len(raw) if isinstance(raw, list) else None,
                'note': 'Unmapped inputs and multi-valued outputs are preserved in the full response; preview is capped at 100 list items and 2000 characters per value. Do not silently choose one ID.'}

    @staticmethod
    def ids(values):
        if not values or len(values) > 200 or any(not isinstance(v, str) or len(v) > 120 or any(c in v for c in ',\r\n') for v in values):
            raise DataError('Supply 1–200 individual identifiers without commas or line breaks.')
        return ','.join(values)

    def cellosaurus_sparql(self, query, max_rows):
        if not 1 <= max_rows <= 500 or len(query) > 12000:
            raise DataError('Use max_rows 1–500 and query at most 12000 characters.')
        # Read-only SELECT subset; disallow external endpoints and update operations.
        stripped = re.sub(r'(?m)^\s*#[^\n]*', '', query)
        if not re.match(r'\s*(?:PREFIX\s+\w*:\s*<[^>]+>\s*)*SELECT\b', stripped, re.I) or re.search(r'\b(SERVICE|LOAD|INSERT|DELETE|CLEAR|DROP|CREATE|MOVE|COPY|ADD|FROM)\b', stripped, re.I):
            raise DataError('Only a local-graph SELECT without SERVICE, FROM or update operations is supported.')
        prolog_match = re.match(r'\s*((?:PREFIX\s+\w*:\s*<[^>]+>\s*)*)', stripped, re.I)
        prolog = prolog_match.group(1)
        body = stripped[prolog_match.end():]
        limited = f'{prolog}\nSELECT * WHERE {{ {{ {body} }} }} LIMIT {max_rows + 1}'
        url = 'https://sparql.cellosaurus.org/sparql?' + urlencode({'query': limited, 'format': 'application/sparql-results+json'})
        raw = self.request(url, accept='application/sparql-results+json')
        rows = raw.get('results', {}).get('bindings')
        if not isinstance(rows, list):
            raise DataError('Cellosaurus SPARQL did not return bindings.')
        return {**self.save(raw, 'cellosaurus_sparql', url), 'variables': raw.get('head', {}).get('vars'),
                'records': rows[:max_rows], 'truncated': len(rows) > max_rows, 'limit': max_rows}

    def cellosaurus_rdf(self, accession, format):
        if not re.fullmatch(r'CVCL_[A-Z0-9]{4}', accession) or format not in ('ttl', 'rdf', 'jsonld', 'n3'):
            raise DataError('Use CVCL_XXXX and ttl/rdf/jsonld/n3.')
        url = f'https://purl.expasy.org/cellosaurus/rdf/cvcl/{accession}.{format}'
        raw = self.request(url, accept='*/*', as_json=False)
        if raw.lstrip().lower().startswith(('<html', '<!doctype html')):
            raise DataError('RDF service returned an HTML page, not RDF.')
        return {**self.save({'content': raw, 'format': format}, 'cellosaurus_rdf', url), 'content': raw, 'format': format}

    def cellosaurus_str(self, markers, species, algorithm, scoring_mode, score_filter, min_markers, max_results):
        if species not in ('human', 'mouse', 'dog') or algorithm not in (1, 2, 3) or scoring_mode not in (1, 2, 3):
            raise DataError('Use documented CLASTR species, algorithm and scoring mode.')
        if not 0 <= score_filter <= 100 or not 1 <= min_markers <= 50 or not 1 <= max_results <= 500 or not 1 <= len(markers) <= 50:
            raise DataError('Invalid CLASTR limits.')
        if any(not re.fullmatch(r'[A-Za-z0-9_-]{1,30}', k) or not re.fullmatch(r'[XYxy0-9., ]{1,100}', v) for k, v in markers.items()):
            raise DataError('Markers must contain documented locus names and comma-separated allele values.')
        options = {'species': species, 'algorithm': algorithm, 'scoringMode': scoring_mode,
                   'scoreFilter': score_filter, 'minMarkers': min_markers, 'maxResults': max_results, 'outputFormat': 'json'}
        if any(k.lower() in {x.lower() for x in options} for k in markers):
            raise DataError('Marker names cannot replace CLASTR options.')
        url = 'https://www.cellosaurus.org/str-search/api/query?' + urlencode({**markers, **options})
        raw = self.request(url)
        return {**self.save(raw, 'cellosaurus_str', url), 'result': raw,
                'note': 'Similarity depends on loci and scoring settings. A match alone does not authenticate a sample.'}

    def import_ctd(self, path, table_name, source_version):
        original = self.store.contained_file(path)
        opener = gzip.open if original.suffix.lower() == '.gz' else open
        target = self.store.root / 'incoming' / f'ctd_normalized_{uuid.uuid4().hex}.tsv'
        fields = None
        header_next = False
        comments = []
        size = 0
        try:
            with opener(original, 'rt', encoding='utf-8') as source, target.open('x', encoding='utf-8', newline='') as out:
                writer = csv.writer(out, delimiter='\t', lineterminator='\n')
                for line in source:
                    size += len(line.encode('utf-8'))
                    if size > self.store.max_import_bytes:
                        raise DataError('CTD decompressed data exceeds import size limit.')
                    if line.startswith('#'):
                        comments.append(line.rstrip()) if fields is None else None
                        if header_next and '\t' in line:
                            fields = line.lstrip('# ').rstrip('\r\n').split('\t')
                            writer.writerow(fields)
                            header_next = False
                        elif line.strip() == '# Fields:':
                            header_next = True
                        continue
                    if not line.strip():
                        continue
                    if fields is None:
                        raise DataError('CTD file is missing its official commented Fields header.')
                    if len(line.rstrip('\r\n').split('\t')) != len(fields):
                        raise DataError('CTD data row does not match the official field list.')
                    writer.writerow(line.rstrip('\r\n').split('\t'))
            result = self.store.import_table(str(target), table_name, '\t', 'utf-8', source_version)
            receipt = {'original_file': str(original), 'original_sha256': file_hash(original), 'normalized_file': str(target), 'official_header': comments,
                       'fields': fields, 'import_result': result, 'terms_url': 'https://ctdbase.org/about/legal.jsp'}
            saved = self.save(receipt, 'ctd_import', 'https://ctdbase.org/downloads/')
            return {**receipt, **saved}
        except Exception:
            target.unlink(missing_ok=True)
            raise


def register_research(app, store, read, write):
    service = Research(store)
    if store.provider == 'hgnc':
        @app.tool(annotations=write)
        def search_hgnc(field: str, value: str, max_rows: int = 20) -> dict:
            """Search official HGNC indexed fields (symbol, alias_symbol, prev_symbol, name, entrez_id etc.). Search returns identifiers; fetch complete records separately. Raw JSON saved locally."""
            return service.hgnc('search', field, value, max_rows)
        @app.tool(annotations=write)
        def fetch_hgnc(field: str, value: str, max_rows: int = 20) -> dict:
            """Fetch complete HGNC nomenclature/ID records using an exact documented field; does not collapse ambiguous aliases."""
            return service.hgnc('fetch', field, value, max_rows)
        @app.tool(annotations=read)
        def hgnc_service_info() -> dict:
            """Discover currently supported HGNC fields and service metadata from official /info."""
            return service.request('https://rest.genenames.org/info')
        @app.tool(annotations=read)
        def list_hgnc_files(prefix: str = 'hgnc/tsv/tsv/', cursor: str = '', limit: int = 100) -> dict:
            """List live HGNC official bucket files, sizes/ETags and cursor. Use returned URLs with download_file. No VGNC/HCOP claims."""
            return service.hgnc_files(prefix, cursor, limit)
    if store.provider == 'chea3':
        @app.tool(annotations=write)
        def rank_transcription_factors(genes: list[str], query_name: str = 'OpenScience', top_n: int = 20) -> dict:
            """Rank TFs using actual ChEA3 enrichment API. Genes sent to public upstream. Returns per-library ranking and full response path; recognized gene list remains unknown."""
            return service.chea3(genes, query_name, top_n)
        @app.tool(annotations=read)
        def list_chea3_libraries() -> dict:
            """Discover official downloadable GMT libraries from ChEA3 page; primary and benchmarking libraries may differ. Download returned URL with download_file."""
            return service.files_from_page('https://maayanlab.cloud/chea3/', r'\.gmt$')
    if store.provider == 'biodbnet':
        @app.tool(annotations=write)
        def list_input_types() -> dict:
            """Get official bioDBnet supported identifier types."""
            return service.biodbnet('getinputs', {})
        @app.tool(annotations=write)
        def list_output_types(input_type: str) -> dict:
            """Get output types reachable from this input node; use exact official names."""
            return service.biodbnet('getoutputsforinput', {'input': input_type})
        @app.tool(annotations=write)
        def list_pathways(taxon_id: int = 9606, databases: str = '1') -> dict:
            """Get official pathway catalog for a species; saved full result, at most 100 displayed rows."""
            return service.biodbnet('getpathways', {'pathways': databases, 'taxonId': taxon_id})
        @app.tool(annotations=write)
        def convert_ids(input_type: str, values: list[str], outputs: list[str], taxon_id: int = 9606) -> dict:
            """bioDBnet db2db ID conversion; preserve unmapped and multiple matches."""
            return service.biodbnet('db2db', {'input': input_type, 'inputValues': service.ids(values), 'outputs': service.ids(outputs), 'taxonId': taxon_id, 'format': 'row'})
        @app.tool(annotations=write)
        def identifier_report(input_type: str, values: list[str], taxon_id: int = 9606) -> dict:
            """bioDBnet dbReport retrieves all possible output types for given identifiers."""
            return service.biodbnet('dbreport', {'input': input_type, 'inputValues': service.ids(values), 'taxonId': taxon_id, 'format': 'row'})
        @app.tool(annotations=write)
        def recognize_ids(values: list[str], output_type: str = 'geneid', taxon_id: int = 9606) -> dict:
            """bioDBnet dbFind recognizes mixed identifier inputs and converts to selected output."""
            return service.biodbnet('dbfind', {'inputValues': service.ids(values), 'output': output_type, 'taxonId': taxon_id, 'format': 'row'})
        @app.tool(annotations=write)
        def map_orthologs(input_type: str, values: list[str], input_taxon: int = 9606, output_taxon: int = 10090, output_type: str = 'genesymbol') -> dict:
            """bioDBnet dbOrtho species-to-species mapping; absence of mapping is not absence of biological homology."""
            return service.biodbnet('dbortho', {'input': input_type, 'inputValues': service.ids(values), 'inputTaxon': input_taxon, 'outputTaxon': output_taxon, 'output': output_type, 'format': 'row'})
        @app.tool(annotations=write)
        def annotate_ids(values: list[str], annotations: list[str], taxon_id: int = 9606) -> dict:
            """bioDBnet dbAnnot for Genes, Drugs, Diseases, GO Terms, Pathways or Protein Interactors. No dbWalk/SOAP/dbOrg."""
            allowed = {'Genes', 'Drugs', 'Diseases', 'GO Terms', 'Pathways', 'Protein Interactors'}
            if not annotations or any(a not in allowed for a in annotations):
                raise DataError('Use documented annotation categories.')
            return service.biodbnet('dbannot', {'inputValues': service.ids(values), 'annotations': ','.join(annotations), 'taxonId': taxon_id, 'format': 'row'})
    if store.provider == 'cellosaurus-extra':
        @app.tool(annotations=write)
        def query_knowledge_graph(query: str, max_rows: int = 100) -> dict:
            """Run a bounded read-only Cellosaurus SPARQL SELECT; max 500 rows, no federation or updates. Preserve PREFIX declarations."""
            return service.cellosaurus_sparql(query, max_rows)
        @app.tool(annotations=write)
        def get_rdf(accession: str, format: str = 'ttl') -> dict:
            """Dereference one official Cellosaurus cell-line RDF entity in ttl/rdf/jsonld/n3."""
            return service.cellosaurus_rdf(accession, format)
        @app.tool(annotations=read)
        def list_cellosaurus_files() -> dict:
            """Discover current Cellosaurus FTP-over-HTTPS data and RDF download links; use download_file, never auto-download ontology."""
            data = service.files_from_page('https://ftp.expasy.org/databases/cellosaurus/', r'\.(?:txt|xml|json|gz)$')
            rdf = service.files_from_page('https://api.cellosaurus.org/rdf-downloads', r'\.(?:ttl|gz)$')
            return {'sources': [data['source_url'], rdf['source_url']], 'files': data['files'] + rdf['files']}
        @app.tool(annotations=write)
        def search_str_similarity(markers: dict[str, str], species: str = 'human', algorithm: int = 1, scoring_mode: int = 1, score_filter: int = 70, min_markers: int = 8, max_results: int = 20) -> dict:
            """Query official CLASTR STR similarity for comma-separated marker alleles. Returns scoring configuration and official matches, not authentication certification."""
            return service.cellosaurus_str(markers, species, algorithm, scoring_mode, score_filter, min_markers, max_results)
    if store.provider == 'ctd':
        @app.tool(annotations=read)
        def list_ctd_files() -> dict:
            """List maintained CTD official report URLs verified when this connector was released; not a live/exhaustive directory. Revalidate on download; never bypass a human verification page."""
            return {'source_url': 'https://ctdbase.org/downloads/', 'catalog_scope': 'maintained_subset',
                    'verified_at_release': '2026-10-14', 'live_verified': False,
                    'files': store.config['known_files'], 'terms_url': 'https://ctdbase.org/about/legal.jsp',
                    'note': 'Large relationship files may exceed local import limits; use a prepared subset. Cite CTD and follow source terms.'}
        @app.tool(annotations=read)
        def discover_ctd_directory() -> dict:
            """Try the current official CTD directory. On challenge/access errors stop; not an empty catalog."""
            return service.files_from_page('https://ctdbase.org/downloads/', r'/reports/.*\.(?:gz|csv|tsv)')
        @app.tool(annotations=write)
        def import_ctd_report(path: str, table_name: str, source_version: str = '') -> dict:
            """Import authorized official CTD TSV/TSV.GZ with commented Fields header, retaining source/license header. Query chemical/gene/disease/pathway/phenotype/GO/exposure relations through query_local; not web All queries."""
            return store.submit('ctd_import', service.import_ctd, path, table_name, source_version)
