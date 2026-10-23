import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'resources' / 'medical-data'))

import json
import gzip
import httpx
import pytest
from core import Store, DataError
from research import Research


def test_hgnc_ambiguous_matches_preserved(tmp_path):
    def handle(request):
        assert request.headers['accept'] == 'application/json'
        assert request.url.path == '/fetch/alias_symbol/X'
        return httpx.Response(200, json={'response': {'numFound': 2, 'docs': [{'symbol': 'A'}, {'symbol': 'B'}]}})
    result = Research(Store('hgnc', tmp_path, transport=httpx.MockTransport(handle))).hgnc('fetch', 'alias_symbol', 'X', 1)
    assert result['num_found'] == 2 and result['truncated']
    assert json.loads(__import__('pathlib').Path(result['raw_response_path']).read_text())['response']['docs'][1]['symbol'] == 'B'


def test_hgnc_bucket_scope(tmp_path):
    store = Store('hgnc', tmp_path)
    with pytest.raises(DataError):
        store.allowed_url('https://storage.googleapis.com/another-bucket/foo')
    with pytest.raises(DataError):
        store.allowed_url('https://storage.googleapis.com/public-download-files/vgnc/file')
    store.allowed_url('https://storage.googleapis.com/public-download-files/hgnc/tsv/tsv/withdrawn.txt')


def test_chea3_input_dedup_and_recognized_unknown(tmp_path):
    def handle(request):
        assert json.loads(request.content)['gene_set'] == ['TP53', 'MYC']
        return httpx.Response(200, json={'Integrated--meanRank': [{'TF': 'TP53'}, {'TF': 'MYC'}]})
    result = Research(Store('chea3', tmp_path, transport=httpx.MockTransport(handle))).chea3(['TP53', 'MYC', 'TP53'], 'test', 1)
    assert result['recognized_gene_count'] is None
    assert result['libraries']['Integrated--meanRank']['truncated']


def test_api_html_error_is_not_empty_data(tmp_path):
    store = Store('chea3', tmp_path, transport=httpx.MockTransport(lambda r: httpx.Response(200, text='<html>challenge</html>')))
    with pytest.raises(DataError, match='unavailable or invalid'):
        Research(store).chea3(['TP53'], 'test', 1)


def test_sparql_prefix_and_bounds(tmp_path):
    def handle(request):
        query = request.url.params['query']
        assert query.startswith('PREFIX cello: <https://purl.expasy.org/cellosaurus/rdf/ontology/>')
        assert query.endswith('LIMIT 3')
        return httpx.Response(200, json={'head': {'vars': ['x']}, 'results': {'bindings': [{'x': {'value': str(i)}} for i in range(3)]}})
    service = Research(Store('cellosaurus-extra', tmp_path, transport=httpx.MockTransport(handle)))
    result = service.cellosaurus_sparql('PREFIX cello: <https://purl.expasy.org/cellosaurus/rdf/ontology/> SELECT ?x WHERE {?x a cello:CancerCellLine}', 2)
    assert result['truncated'] and len(result['records']) == 2
    with pytest.raises(DataError):
        service.cellosaurus_sparql('SELECT ?x WHERE {SERVICE <https://example.com> {?x ?p ?v}}', 10)
    with pytest.raises(DataError):
        service.cellosaurus_sparql('DELETE WHERE {?x ?y ?z}', 10)


def test_ctd_commented_header_and_first_row_preserved(tmp_path):
    store = Store('ctd', tmp_path)
    source = store.root / 'incoming' / 'CTD_test.tsv.gz'
    with gzip.open(source, 'wt', encoding='utf-8') as stream:
        stream.write('# CTD copyright\n# Report created: test\n# Fields:\n# ChemicalName\tChemicalID\n#\nA "quoted" chemical\tMESH:1\nB\tMESH:2\n')
    result = Research(store).import_ctd(str(source), 'chemicals', 'test')
    rows = store.query('SELECT * FROM chemicals ORDER BY ChemicalID', 10, False)
    assert rows['rows'][0][0] == 'A "quoted" chemical'
    assert len(rows['rows']) == 2
    assert result['fields'] == ['ChemicalName', 'ChemicalID']
    assert '# CTD copyright' in result['official_header']


def test_ctd_rejects_non_ctd_file(tmp_path):
    store = Store('ctd', tmp_path)
    source = store.root / 'incoming' / 'not_ctd.tsv'
    source.write_text('a\tb\n1\t2\n')
    with pytest.raises(DataError, match='Fields header'):
        Research(store).import_ctd(str(source), 'fake', '')
    assert not list((store.root / 'incoming').glob('ctd_normalized_*'))


def test_biodbnet_large_annotation_preview_preserves_raw(tmp_path):
    payload = [{'InputValue': '7157', 'VeryLongAnnotation': 'A' * 10000}]
    service = Research(Store('biodbnet', tmp_path, transport=httpx.MockTransport(lambda r: httpx.Response(200, json=payload))))
    result = service.biodbnet('dbreport', {'input': 'geneid', 'inputValues': '7157'})
    assert result['truncated'] and len(result['result'][0]['VeryLongAnnotation']) < 2100
    assert json.loads(__import__('pathlib').Path(result['raw_response_path']).read_text()) == payload
