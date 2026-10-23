"""Opt-in small live checks. No private accounts, credentials or research cohorts required."""
from concurrent.futures import ThreadPoolExecutor, as_completed
import json
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / 'resources' / 'medical-data'))
from core import Store, DataError
from research import Research

QA = ROOT / 'test-output' / 'builtin-medical-data' / 'live-public'


def check(provider):
    store = Store(provider, QA)
    service = Research(store)
    try:
        if provider == 'nhanes':
            listing = store.nhanes_files(2017)
            item = next(f for f in listing['files'] if f['filename'].upper() == 'DEMO_J.XPT')
            path = store.root / 'downloads' / item['filename']
            cached = path.exists()
            if not cached:
                store.download(item['url'], item['filename'])
            if 'live_demo_j' not in {t['table'] for t in store.list_tables()['tables']}:
                store.import_table(path, 'live_demo_j', source_version='2017-2018')
            assert store.query('SELECT count(*) FROM live_demo_j')['rows'] == [[9254]]
            return {'scope': 'public discovery, XPT download/import, SQL', 'cached_file': cached}
        if provider in {'mimic', 'eicu'}:
            directory, name = ('https://physionet.org/files/mimic-iv-demo/2.2/hosp/', 'patients.csv.gz') if provider == 'mimic' else ('https://physionet.org/files/eicu-crd-demo/2.0/', 'patient.csv.gz')
            files = store.physionet_files(directory)['files']
            item = next(f for f in files if f['url'].endswith('/' + name))
            path = store.root / 'downloads' / name
            cached = path.exists()
            if not cached:
                store.download(item['url'], name)
            if 'live_patients' not in {t['table'] for t in store.list_tables()['tables']}:
                store.import_table(path, 'live_patients', source_version='public-demo')
            result = store.query('SELECT count(*) FROM live_patients')
            assert result['returned_rows'] == 1 and 'rows' not in result
            return {'scope': 'public demo discovery, CSV.GZ download/import, masked SQL', 'cached_file': cached, 'credentialed_data_tested': False}
        if provider == 'europepmc':
            result = store.europepmc_search('TP53 AND liver fibrosis', 2)
            assert result['returned_count'] > 0 and result['total_count'] > 0
            return {'scope': 'live core literature search', 'returned_count': result['returned_count']}
        if provider == 'faers':
            listing = store.faers_downloads(2)
            result = store.faers_query(count='patient.reaction.reactionmeddrapt.exact', limit=2)
            assert listing['partition_count'] >= 2 and len(result['results']) == 2
            return {'scope': 'live openFDA bulk manifest and aggregate query'}
        if provider == 'hgnc':
            result = service.hgnc('fetch', 'symbol', 'TP53', 2)
            assert result['records'][0]['symbol'] == 'TP53'
            assert service.hgnc_files(limit=2)['files']
            return {'scope': 'live HGNC gene record and official file index'}
        if provider == 'chea3':
            result = service.chea3(['FOXM1', 'SMAD9', 'MYC', 'SMAD3', 'STAT1', 'STAT3'], 'public-smoke', 2)
            assert result['libraries']
            return {'scope': 'live transcription-factor enrichment', 'libraries': len(result['libraries'])}
        if provider == 'biodbnet':
            result = service.biodbnet('db2db', {'input': 'genesymbol', 'inputValues': 'TP53', 'outputs': 'geneid', 'taxonId': 9606, 'format': 'row'})
            assert result['result'] and '7157' in json.dumps(result['result'])
            return {'scope': 'live TP53 Gene Symbol to Gene ID conversion'}
        if provider == 'cellosaurus-extra':
            result = service.cellosaurus_rdf('CVCL_0030', 'ttl')
            assert result
            return {'scope': 'live RDF dereference; STR and knowledge graph not asserted here'}
        if provider == 'ctd':
            item = next(f for f in store.config['known_files'] if f['filename'] == 'CTD_pathways.tsv.gz')
            path = store.root / 'downloads' / item['filename']
            cached = path.exists()
            if not cached:
                store.download(item['url'], item['filename'])
            if 'live_pathways' not in {t['table'] for t in store.list_tables()['tables']}:
                service.import_ctd(path, 'live_pathways', 'current-official-file')
            assert store.query('SELECT count(*) FROM live_pathways')['rows'][0][0] > 0
            return {'scope': 'official pathways download, CTD header import, SQL', 'cached_file': cached}
        raise ValueError('No live public check defined')
    finally:
        store.executor.shutdown(wait=True)


def main():
    QA.mkdir(parents=True, exist_ok=True)
    providers = ['nhanes', 'mimic', 'eicu', 'europepmc', 'faers', 'hgnc', 'chea3', 'biodbnet', 'cellosaurus-extra', 'ctd']
    results = []
    with ThreadPoolExecutor(max_workers=4) as pool:
        pending = {pool.submit(check, provider): provider for provider in providers}
        for future in as_completed(pending):
            provider = pending[future]
            try:
                result = {'provider': provider, 'status': 'passed', **future.result()}
            except DataError as error:
                result = {'provider': provider, 'status': 'failed', 'message': str(error)}
            except Exception as error:
                result = {'provider': provider, 'status': 'failed', 'message': type(error).__name__}
            results.append(result)
            print(json.dumps(result), flush=True)
    for provider in ['charls', 'chns', 'seer', 'gbd']:
        results.append({'provider': provider, 'status': 'not_tested', 'scope': 'Requires an approved file/account or browser export; no private credential was used.'})
    (QA / 'live-validation.json').write_text(json.dumps(results, indent=2) + '\n', encoding='utf-8')
    return int(any(r['status'] == 'failed' for r in results))


if __name__ == '__main__':
    raise SystemExit(main())
