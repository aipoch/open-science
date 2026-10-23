import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / 'resources' / 'medical-data'))

"""Meaningful offline behavior tests; no clinical data or credentials required."""
from pathlib import Path
import hashlib
import json
import time
import zipfile

import duckdb
import httpx
import pandas as pd
import pytest
import pyreadstat

from core import Store, PROVIDERS, DataError



@pytest.fixture
def store(tmp_path):
    return Store('nhanes', tmp_path)


def source(store, name='sample.csv'):
    path = store.root / 'incoming' / name
    path.write_text('SEQN,age,sex\n1,40,F\n2,60,M\n3,50,F\n', encoding='utf-8')
    return path


def test_import_describe_aggregate_and_export(store):
    file = source(store)
    result = store.import_table(file, 'demographics', source_version='fixture')
    assert result['rows'] == 3
    assert store.describe_table('demographics')['columns'][1]['name'] == 'age'
    assert store.list_tables()['tables'][0]['source_sha256'] == hashlib.sha256(file.read_bytes()).hexdigest()
    result = store.query('WITH adults AS (SELECT * FROM demographics WHERE age>=50) SELECT sex,count(*) AS n FROM adults GROUP BY sex ORDER BY sex', export_csv=True)
    assert result['rows'] == [['F', 1], ['M', 1]]
    assert Path(result['csv_path']).is_file()
    capped = store.query('select * from demographics order by SEQN', 2)
    assert capped['truncated'] and len(capped['rows']) == 2
    with pytest.raises(DataError, match='already exists'):
        store.import_table(file, 'demographics')


@pytest.mark.parametrize('sql', ["DROP TABLE demographics", "SELECT 1; SELECT 2", "COPY (SELECT 1) TO 'out.csv'", "ATTACH 'other.db' AS other", "INSTALL httpfs", "SET enable_external_access=true", "SELECT * FROM read_csv('private.csv')", "SELECT * FROM 'private.parquet'"])
def test_query_cannot_mutate_or_read_external_files(store, sql):
    store.import_table(source(store), 'demographics')
    with pytest.raises((DataError, duckdb.Error)):
        store.query(sql)
    assert store.query('select count(*) from demographics')['rows'] == [[3]]


def test_import_scope_and_sql_identifiers(store, tmp_path):
    outside = tmp_path / 'outside.csv'
    outside.write_text('x\n1\n', encoding='utf-8')
    with pytest.raises(DataError, match='incoming'):
        store.import_table(outside, 'sample')
    with pytest.raises(DataError, match='Table name'):
        store.import_table(source(store), 'foo"; DROP TABLE _datasets;--')


def test_failed_import_rolls_back(store):
    bad = store.root / 'incoming' / 'bad.txt'
    bad.write_text('x$y\n1$2', encoding='utf-8')
    with pytest.raises(DataError, match='delimiter'):
        store.import_table(bad, 'broken')
    assert store.list_tables()['tables'] == []
    store.import_table(source(store), 'working')


def test_stata_labels_and_sas_format_support(store):
    file = store.root / 'incoming' / 'fixture.dta'
    pd.DataFrame({'age': [40, 50]}).to_stata(file, write_index=False, variable_labels={'age': 'Age in years'})
    store.import_table(file, 'stata')
    assert store.describe_table('stata')['columns'][0]['label'] == 'Age in years'
    assert store.query('SELECT avg(age) FROM stata')['rows'] == [[45.0]]


def test_xpt_zeros_missing_and_labels_are_preserved(store):
    file = store.root / 'incoming' / 'fixture.xpt'
    pyreadstat.write_xport(pd.DataFrame({'age': [0.0, 40.0, float('nan')]}), str(file),
                          file_format_version=5, column_labels={'age': 'Age in years'})
    store.import_table(file, 'xport')
    assert store.query('SELECT min(age), count(*) FILTER (WHERE age=0),count(*) FILTER (WHERE age IS NULL) FROM xport')['rows'] == [[0.0, 1, 1]]
    assert store.describe_table('xport')['columns'][0]['label'] == 'Age in years'


def test_archive_selected_member_and_traversal(store):
    file = store.root / 'incoming' / 'fixture.zip'
    with zipfile.ZipFile(file, 'w') as archive:
        archive.writestr('data/a.csv', 'x\n1\n')
        archive.writestr('../escape.csv', 'x\n1\n')
    assert store.inspect_archive(file)['member_count'] == 2
    output = store.extract_member(file, 'data/a.csv')
    assert Path(output['path']).name == 'a.csv'
    with pytest.raises(DataError, match='Unsafe'):
        store.extract_member(file, '../escape.csv')


def test_patient_results_remain_local_by_default(tmp_path):
    restricted = Store('mimic', tmp_path)
    restricted.import_table(source(restricted), 'patients')
    result = restricted.query('select * from patients')
    assert 'rows' not in result and not result['raw_rows_returned_to_model']
    assert pd.read_csv(result['csv_path']).shape == (3, 3)
    enabled = Store('mimic', tmp_path, return_rows=True)
    assert enabled.query('select count(*) from patients')['rows'] == [[3]]


def test_download_checksum_no_overwrite_and_html(store):
    body = b'x,y\n1,2\n'
    store.transport = httpx.MockTransport(lambda _: httpx.Response(200, content=body, headers={'Content-Type': 'text/csv'}))
    url = 'https://wwwn.cdc.gov/files/test.csv'
    result = store.download(url, 'download.csv', hashlib.sha256(body).hexdigest())
    assert Path(result['path']).read_bytes() == body and result['checksum_verified_against_source']
    with pytest.raises(DataError, match='already exists'):
        store.download(url, 'download.csv')
    with pytest.raises(DataError, match='checksum'):
        store.download(url, 'wrong.csv', '0'*64)
    assert not (store.root/'downloads/wrong.csv').exists()
    store.transport = httpx.MockTransport(lambda _: httpx.Response(200, text='<html>login</html>', headers={'Content-Type': 'text/html'}))
    with pytest.raises(DataError, match='webpage'):
        store.download(url, 'html.csv')
    with pytest.raises(DataError, match='credential-bearing'):
        store.download(url+'?token=private', 'signed.csv')


def test_redirect_cannot_send_secrets_to_another_host(tmp_path, monkeypatch):
    monkeypatch.setenv('PHYSIONET_USERNAME', 'dummy-user')
    monkeypatch.setenv('PHYSIONET_PASSWORD', 'dummy-password')
    requests = []
    def handler(request):
        requests.append(request)
        return httpx.Response(302, headers={'Location': 'https://evil.invalid/steal'})
    store = Store('mimic', tmp_path, transport=httpx.MockTransport(handler))
    with pytest.raises(DataError, match='outside'):
        store.download('https://physionet.org/files/mimiciv/3.1/hosp/patients.csv.gz', 'patients.csv.gz')
    assert len(requests) == 1 and requests[0].url.host == 'physionet.org'


def test_physionet_missing_auth_and_provider_scope(tmp_path, monkeypatch):
    monkeypatch.delenv('PHYSIONET_USERNAME', raising=False)
    monkeypatch.delenv('PHYSIONET_PASSWORD', raising=False)
    store = Store('mimic', tmp_path)
    with pytest.raises(DataError, match='Configure'):
        store.auth('https://physionet.org/files/mimiciv/3.1/hosp/patients.csv.gz')
    assert store.auth('https://physionet.org/files/mimic-iv-demo/2.2/hosp/patients.csv.gz')[1] is None
    with pytest.raises(DataError, match='provider'):
        store.allowed_url('https://physionet.org/files/eicu-crd/2.0/patient.csv.gz')


def test_jobs_persist_and_interruption_is_not_success(store):
    result = store.submit('test', lambda: {'done': True})
    for _ in range(100):
        final = store.get_job(result['job_id'])
        if final['status'] == 'ready':
            break
        time.sleep(.01)
    assert final['result'] == {'done': True}
    reconstructed = Store('nhanes', store.root.parent)
    assert reconstructed.get_job(result['job_id'])['status'] == 'ready'
    store.set_job('a'*32, {'status': 'running'})
    assert reconstructed.get_job('a'*32)['status'] == 'interrupted'


def test_faers_envelope_import_and_empty_search(tmp_path):
    store = Store('faers', tmp_path)
    file = store.root / 'incoming' / 'event.json'
    file.write_text(json.dumps({'meta': {}, 'results': [{'safetyreportid': '1', 'patient': {'patientsex': '1'}}, {'safetyreportid': '2', 'patient': {'patientsex': '2'}}]}), encoding='utf-8')
    assert store.import_table(file, 'events')['rows'] == 2
    assert store.query('SELECT patient.patientsex FROM events ORDER BY safetyreportid')['rows'] == [['1'], ['2']]
    store.transport = httpx.MockTransport(lambda _: httpx.Response(404, json={'error': {'code': 'NOT_FOUND'}}))
    assert store.faers_query('anything')['total'] == 0



def test_europepmc_search_preserves_provenance_and_pagination(tmp_path):
    store = Store('europepmc', tmp_path)
    def handler(request):
        assert request.url.params['query'] == 'TP53 AND PUB_YEAR:[2022 TO 2026]'
        assert request.url.params['resultType'] == 'core'
        return httpx.Response(200, json={'hitCount': 30, 'nextCursorMark': 'next-page', 'resultList': {'result': [{'pmid': '123', 'title': 'Synthetic record', 'abstractText': 'Synthetic abstract'}]}})
    store.transport = httpx.MockTransport(handler)
    result = store.europepmc_search('TP53 AND PUB_YEAR:[2022 TO 2026]', 1)
    assert result['source'] == 'europepmc' and result['total_count'] == 30 and result['has_more']
    assert result['records'][0]['abstractText'] == 'Synthetic abstract'
    with pytest.raises(DataError): store.europepmc_search('', 1)
