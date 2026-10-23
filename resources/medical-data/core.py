"""Provider-scoped downloads and local tables. No application credentials are read."""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import closing
from datetime import datetime, timezone
from hashlib import sha256
from html.parser import HTMLParser
from pathlib import Path
from threading import Lock, Timer
from urllib.parse import urljoin, urlsplit, urlunsplit, unquote, parse_qs
import json
import math
import os
import re
import time
import uuid
import zipfile

import duckdb
import httpx
import pandas as pd
import pyreadstat

PROVIDERS = json.loads((Path(__file__).parent / 'providers.json').read_text(encoding='utf-8'))
SAFE_NAME = re.compile(r'[a-z][a-z0-9_]{0,62}\Z')
FORMATS = {'.csv', '.tsv', '.txt', '.xpt', '.dta', '.sas7bdat', '.parquet', '.json', '.jsonl', '.ndjson'}


class DataError(ValueError):
    """An actionable error without response bodies or secret values."""


def now():
    return datetime.now(timezone.utc).isoformat()


def clean_url(url):
    p = urlsplit(url)
    return urlunsplit((p.scheme, p.netloc, p.path, '', ''))


def file_hash(path):
    digest = sha256()
    with Path(path).open('rb') as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b''):
            digest.update(block)
    return digest.hexdigest()


class Links(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        if tag == 'a':
            href = dict(attrs).get('href')
            if href:
                self.links.append(href)


class Store:
    def __init__(self, provider, data_root, return_rows=False, transport=None):
        if provider not in PROVIDERS:
            raise DataError('Unknown provider.')
        self.provider = provider
        self.config = PROVIDERS[provider]
        self.root = (Path(data_root).expanduser().resolve() / provider)
        self.root.mkdir(parents=True, exist_ok=True)
        for folder in ['incoming', 'downloads', 'exports', 'receipts', 'jobs']:
            (self.root / folder).mkdir(exist_ok=True)
        self.database = self.root / 'data.duckdb'
        self.return_rows = return_rows or self.config['access'] == 'public' or provider == 'gbd'
        self.transport = transport
        self.lock = Lock()
        self.job_lock = Lock()
        self.jobs = {}
        self.executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix=f'{provider}-data')
        self.max_download_bytes = 5 * 1024 ** 3
        self.max_import_bytes = 20 * 1024 ** 3
        # Do not retain a writable connection between tools or interfere with query isolation.
        with duckdb.connect(str(self.database)) as con:
            con.execute('CREATE TABLE IF NOT EXISTS _datasets (table_name VARCHAR PRIMARY KEY, metadata VARCHAR)')

    def info(self):
        return {'provider': self.provider, **{k: self.config[k] for k in ['label', 'access', 'docs', 'portal', 'download', 'notes']},
                'data_root': str(self.root), 'incoming_directory': str(self.root / 'incoming'),
                'formats': sorted(FORMATS), 'return_row_data_to_model': self.return_rows,
                'download_file_limit_bytes': self.max_download_bytes,
                'import_file_limit_bytes': self.max_import_bytes,
                'query_result_limit_rows': 1000, 'query_timeout_seconds': 20,
                'bulk_download_resume': False, 'automatic_access_application': False}

    def allowed_url(self, url):
        p = urlsplit(url)
        if p.scheme != 'https' or p.username or p.password or p.port not in (None, 443):
            raise DataError('Only HTTPS official download URLs without embedded credentials are supported.')
        if p.hostname not in self.config['hosts']:
            raise DataError('The URL host is outside this provider. Use the official portal or import an already downloaded file.')
        if self.provider == 'hgnc' and p.hostname == 'storage.googleapis.com':
            if p.path != '/public-download-files' and not p.path.startswith('/public-download-files/hgnc/'):
                raise DataError('Only the official HGNC public-download-files bucket and HGNC prefix are allowed.')
        if self.config.get('file_projects') and p.path.startswith('/files/'):
            parts = p.path.split('/')
            if len(parts) < 4 or parts[2] not in self.config['file_projects']:
                raise DataError('PhysioNet file URL is not for this connector provider.')
        return url

    def auth(self, url):
        headers = {'User-Agent': 'OpenScience-MedicalDataMCP/0.1 (research data access)'}
        p = urlsplit(url)
        auth = None
        # Secrets are forwarded only to the exact authority that receives the data request.
        if self.config.get('file_projects') and p.hostname == 'physionet.org' and p.path.startswith('/files/'):
            project = p.path.split('/')[2]
            if not project.endswith('-demo'):
                username = os.environ.get('PHYSIONET_USERNAME')
                password = os.environ.get('PHYSIONET_PASSWORD')
                if not username or not password:
                    raise DataError('Configure PHYSIONET_USERNAME and PHYSIONET_PASSWORD in connector secrets after obtaining personal data access, or use a public demo.')
                auth = (username, password)
        cookie_name = self.config.get('cookie_env')
        if cookie_name and os.environ.get(cookie_name):
            cookie_host = self.config['hosts'][0]
            if p.hostname == cookie_host:
                headers['Cookie'] = os.environ[cookie_name]
        if self.provider == 'chns' and p.hostname == 'dataverse.unc.edu' and os.environ.get('DATAVERSE_API_TOKEN'):
            headers['X-Dataverse-key'] = os.environ['DATAVERSE_API_TOKEN']
        return headers, auth

    def open_response(self, client, url):
        for _ in range(6):
            self.allowed_url(url)
            headers, auth = self.auth(url)
            response = client.send(client.build_request('GET', url, headers=headers), auth=auth, stream=True)
            if response.status_code in {301, 302, 303, 307, 308}:
                location = response.headers.get('location')
                response.close()
                if not location:
                    raise DataError('Download redirect has no location.')
                url = urljoin(url, location)
                continue
            if response.status_code >= 400:
                status = response.status_code
                response.close()
                if status in (401, 403):
                    raise DataError(f'HTTP {status}: access or website policy denied the request. Complete official access or import the browser-downloaded file.')
                raise DataError(f'Official service returned HTTP {status}.')
            return response
        raise DataError('Too many redirects; use the official file URL.')

    def remote_text(self, url, json_result=False):
        try:
            with httpx.Client(timeout=30, transport=self.transport, follow_redirects=False) as client:
                response = self.open_response(client, url)
                with closing(response):
                    blocks, total = [], 0
                    for chunk in response.iter_bytes():
                        total += len(chunk)
                        if total > 8 * 1024 ** 2:
                            raise DataError('Metadata response exceeds 8 MiB.')
                        blocks.append(chunk)
                    text = b''.join(blocks).decode('utf-8', errors='replace')
                    return json.loads(text) if json_result else text
        except (httpx.HTTPError, json.JSONDecodeError) as exc:
            raise DataError('Official metadata could not be retrieved or parsed; no automatic retry was made.') from None

    def submit(self, operation, function, *args):
        job_id = uuid.uuid4().hex
        self.set_job(job_id, {'job_id': job_id, 'operation': operation, 'status': 'queued', 'created_at': now()})
        def run():
            self.set_job(job_id, {'status': 'running'})
            try:
                result = function(*args)
                self.set_job(job_id, {'status': 'ready', 'result': result, 'finished_at': now()})
            except DataError as exc:
                self.set_job(job_id, {'status': 'error', 'message': str(exc), 'finished_at': now()})
            except Exception:
                self.set_job(job_id, {'status': 'error', 'message': 'Operation failed. Check file format, resource limits, and official data access. No response body or credentials were logged.', 'finished_at': now()})
        self.executor.submit(run)
        return {'job_id': job_id, 'status': 'queued', 'next_tool': 'get_job'}

    def set_job(self, job_id, patch):
        with self.job_lock:
            value = {**self.jobs.get(job_id, {}), **patch}
            self.jobs[job_id] = value
            target = self.root / 'jobs' / f'{job_id}.json'
            temp = target.with_suffix('.tmp')
            temp.write_text(json.dumps(value, ensure_ascii=False, default=str), encoding='utf-8')
            temp.replace(target)

    def get_job(self, job_id):
        if not re.fullmatch(r'[a-f0-9]{32}', job_id):
            raise DataError('Invalid job identifier.')
        with self.job_lock:
            if job_id in self.jobs:
                return json.loads(json.dumps(self.jobs[job_id], default=str))
        path = self.root / 'jobs' / f'{job_id}.json'
        if not path.is_file():
            raise DataError('Job not found for this provider.')
        result = json.loads(path.read_text(encoding='utf-8'))
        if result['status'] in {'running', 'queued'}:
            result.update(status='interrupted', message='Server restarted; this job is not running. Review partial artifacts before starting a new job.')
        return result

    def download(self, url, filename, expected_sha256=''):
        if not self.config['download']:
            raise DataError('This provider uses official software exports. Import a file obtained through the official process.')
        self.allowed_url(url)
        sensitive_keys = {'token', 'accesstoken', 'apikey', 'password', 'signature', 'credential', 'authorization', 'secret', 'xamzsignature', 'xamzcredential', 'xgoogsignature', 'xgoogcredential'}
        if any(re.sub(r'[^a-z0-9]', '', key.lower()) in sensitive_keys for key in parse_qs(urlsplit(url).query)):
            raise DataError('Do not pass signed or credential-bearing URLs through tool arguments. Download in the browser and import the local file.')
        if not filename or Path(filename).name != filename or re.search(r'[<>:"/\\|?*]', filename) or filename.endswith((' ', '.')):
            raise DataError('Use a plain filename without paths or reserved characters.')
        if expected_sha256 and not re.fullmatch(r'[0-9a-fA-F]{64}', expected_sha256):
            raise DataError('Expected checksum must be a 64-character SHA256.')
        final = self.root / 'downloads' / filename
        if final.exists():
            raise DataError('Download target already exists; choose a new filename.')
        temp = final.with_name(final.name + '.' + uuid.uuid4().hex + '.part')
        total, digest = 0, sha256()
        started = time.monotonic()
        try:
            with httpx.Client(timeout=60, transport=self.transport, follow_redirects=False) as client:
                response = self.open_response(client, url)
                with closing(response):
                    if 'text/html' in response.headers.get('content-type', '').lower():
                        raise DataError('The site returned a webpage rather than data; use the real download link or browser export.')
                    length = response.headers.get('content-length')
                    if length and int(length) > self.max_download_bytes:
                        raise DataError('File exceeds the configured download size limit; download locally using official tools.')
                    with temp.open('xb') as output:
                        for chunk in response.iter_bytes(1024 * 1024):
                            total += len(chunk)
                            if total > self.max_download_bytes or time.monotonic() - started > 1800:
                                raise DataError('Download exceeded the file-size or 30-minute limit. Use the official bulk-download tool.')
                            if output.tell() == 0 and chunk.lstrip()[:32].lower().startswith((b'<!doctype html', b'<html')):
                                raise DataError('Downloaded content is an HTML access page, not a dataset.')
                            output.write(chunk)
                            digest.update(chunk)
            if total == 0:
                raise DataError('Downloaded file is empty.')
            checksum = digest.hexdigest()
            if expected_sha256 and checksum != expected_sha256.lower():
                raise DataError('Downloaded file checksum does not match the supplied checksum.')
            # A hard link publishes without replacing a file created by another process.
            os.link(temp, final)
            receipt = {'provider': self.provider, 'source_url_without_query': clean_url(url),
                       'path': str(final), 'bytes': total, 'sha256': checksum, 'downloaded_at': now(),
                       'checksum_verified_against_source': bool(expected_sha256)}
            (self.root / 'receipts' / f'{uuid.uuid4().hex}.json').write_text(json.dumps(receipt, ensure_ascii=False), encoding='utf-8')
            return receipt
        except httpx.HTTPError:
            raise DataError('Network download failed; no automatic retry was made.') from None
        finally:
            temp.unlink(missing_ok=True)

    def contained_file(self, path):
        value = Path(path).expanduser().resolve(strict=True)
        roots = [self.root / 'incoming', self.root / 'downloads']
        if not value.is_file() or not any(value.is_relative_to(p.resolve()) for p in roots):
            raise DataError('Copy authorized files into this provider incoming directory, or use a connector download. Other local paths are not read.')
        if value.stat().st_size > self.max_import_bytes:
            raise DataError('Import file exceeds 20 GiB; prepare a smaller authorized file locally.')
        return value

    def extract_member(self, archive_path, member):
        archive_path = self.contained_file(archive_path)
        with zipfile.ZipFile(archive_path) as archive:
            info = archive.getinfo(member)
            member_path = Path(member)
            if info.is_dir() or member_path.is_absolute() or '..' in member_path.parts or re.search(r'[:\\]', member):
                raise DataError('Unsafe archive member path.')
            if info.file_size > self.max_import_bytes or info.file_size / max(1, info.compress_size) > 1000:
                raise DataError('Archive member exceeds extraction limits.')
            target = self.root / 'incoming' / member_path.name
            if target.exists():
                raise DataError('Extraction target already exists.')
            # A fresh name ensures failed extractions cannot be mistaken for complete files.
            temp = target.with_name(target.name + '.' + uuid.uuid4().hex + '.part')
            try:
                with archive.open(info) as source, temp.open('xb') as output:
                    total = 0
                    for block in iter(lambda: source.read(1024 * 1024), b''):
                        total += len(block)
                        if total > self.max_import_bytes:
                            raise DataError('Archive member exceeds extraction size limit.')
                        output.write(block)
                os.link(temp, target)
            finally:
                temp.unlink(missing_ok=True)
        return {'path': str(target), 'bytes': target.stat().st_size, 'member': member, 'sha256': file_hash(target)}

    def inspect_archive(self, path, limit=200):
        path = self.contained_file(path)
        with zipfile.ZipFile(path) as archive:
            members = archive.infolist()
            return {'member_count': len(members), 'truncated': len(members) > limit,
                    'members': [{'name': m.filename, 'bytes': m.file_size} for m in members[:limit]]}

    def import_table(self, path, table_name, delimiter='', encoding='utf-8', source_version=''):
        if not SAFE_NAME.fullmatch(table_name) or table_name.startswith('_'):
            raise DataError('Table name must start with a lowercase letter and contain only letters, digits and underscores.')
        path = self.contained_file(path)
        suffix = path.suffix.lower()
        if suffix == '.gz':
            suffix = path.with_suffix('').suffix.lower()
        if suffix not in FORMATS:
            raise DataError('Unsupported format. Extract a selected ZIP member first; supported formats are listed by provider_info.')
        if delimiter and (len(delimiter) != 1 or delimiter in '\r\n\x00'):
            raise DataError('Delimiter must be one non-newline character.')
        metadata = {'provider': self.provider, 'source_path': str(path), 'source_sha256': file_hash(path),
                    'source_version': source_version, 'format': suffix, 'imported_at': now(), 'variable_labels': {}}
        with self.lock, duckdb.connect(str(self.database)) as con:
            con.execute("SET memory_limit = '1GB'")
            con.execute('BEGIN TRANSACTION')
            try:
                if con.execute('SELECT count(*) FROM information_schema.tables WHERE table_name=?', [table_name]).fetchone()[0]:
                    raise DataError('Table already exists; choose a new table name. Existing research tables are not overwritten.')
                if suffix in {'.csv', '.tsv', '.txt'}:
                    if suffix == '.txt' and not delimiter:
                        raise DataError('TXT requires an explicit delimiter; FAERS ASCII commonly uses $.')
                    sep = delimiter or ('\t' if suffix == '.tsv' else ',')
                    con.execute(f'CREATE TABLE "{table_name}" AS SELECT * FROM read_csv(?, delim=?, header=true, encoding=?)', [str(path), sep, encoding])
                elif suffix == '.parquet':
                    con.execute(f'CREATE TABLE "{table_name}" AS SELECT * FROM read_parquet(?)', [str(path)])
                elif suffix in {'.json', '.jsonl', '.ndjson'}:
                    fields = con.execute('DESCRIBE SELECT * FROM read_json_auto(?)', [str(path)]).fetchall()
                    if self.provider == 'faers' and any(f[0] == 'results' and '[]' in f[1] for f in fields):
                        con.execute(f'CREATE TABLE "{table_name}" AS SELECT r.* FROM (SELECT unnest(results) AS r FROM read_json_auto(?))', [str(path)])
                    else:
                        con.execute(f'CREATE TABLE "{table_name}" AS SELECT * FROM read_json_auto(?)', [str(path)])
                else:
                    reader = {'.dta': pyreadstat.read_dta, '.xpt': pyreadstat.read_xport,
                              '.sas7bdat': pyreadstat.read_sas7bdat}[suffix]
                    chunks = pyreadstat.read_file_in_chunks(reader, str(path), chunksize=100000, encoding=encoding)
                    created = False
                    for frame, source_metadata in chunks:
                        metadata['variable_labels'] = source_metadata.column_names_to_labels
                        metadata['value_labels'] = source_metadata.variable_value_labels
                        if frame.empty:
                            continue
                        con.register('_chunk', frame)
                        if not created:
                            con.execute(f'CREATE TABLE "{table_name}" AS SELECT * FROM _chunk')
                            created = True
                        else:
                            con.execute(f'INSERT INTO "{table_name}" SELECT * FROM _chunk')
                        con.unregister('_chunk')
                    if not created:
                        raise DataError('The source contains no data rows.')
                rows = con.execute(f'SELECT count(*) FROM "{table_name}"').fetchone()[0]
                metadata['rows'] = rows
                con.execute('INSERT INTO _datasets VALUES (?, ?)', [table_name, json.dumps(metadata, ensure_ascii=False)])
                con.execute('COMMIT')
            except Exception:
                con.execute('ROLLBACK')
                raise
        return {'table': table_name, 'rows': rows, 'source_version': source_version, 'source_sha256': metadata['source_sha256']}

    def list_tables(self):
        with self.lock, duckdb.connect(str(self.database), read_only=True) as con:
            return {'tables': [{'table': name, **json.loads(metadata)} for name, metadata in con.execute('SELECT * FROM _datasets ORDER BY table_name').fetchall()]}

    def describe_table(self, table_name):
        if not SAFE_NAME.fullmatch(table_name):
            raise DataError('Invalid table name.')
        with self.lock, duckdb.connect(str(self.database), read_only=True) as con:
            result = con.execute('SELECT metadata FROM _datasets WHERE table_name=?', [table_name]).fetchone()
            if not result:
                raise DataError('Table not found.')
            metadata = json.loads(result[0])
            fields = con.execute(f'DESCRIBE "{table_name}"').fetchall()
            return {'table': table_name, 'rows': metadata['rows'], 'source_version': metadata['source_version'],
                    'columns': [{'name': row[0], 'type': row[1], 'nullable': row[2],
                                 'label': metadata.get('variable_labels', {}).get(row[0], ''),
                                 'value_labels': metadata.get('value_labels', {}).get(row[0], {})} for row in fields]}

    def query(self, sql, max_rows=100, export_csv=False):
        if not 1 <= max_rows <= 1000 or len(sql) > 20000:
            raise DataError('Use 1–1000 result rows and at most 20000 SQL characters.')
        with self.lock, duckdb.connect(str(self.database), read_only=True,
                                       config={'enable_external_access': False, 'memory_limit': '1GB', 'threads': 2}) as con:
            statements = con.extract_statements(sql)
            if len(statements) != 1 or statements[0].type != duckdb.StatementType.SELECT:
                raise DataError('Only one read-only SELECT or WITH query is allowed.')
            timer = Timer(20, con.interrupt)
            timer.start()
            try:
                cursor = con.execute(sql)
                columns = [d[0] for d in cursor.description]
                fetched = cursor.fetchmany(max_rows + 1)
            finally:
                timer.cancel()
        truncated = len(fetched) > max_rows
        rows = [list(row) for row in fetched[:max_rows]]
        payload = {'columns': columns, 'returned_rows': len(rows), 'truncated': truncated,
                   'raw_rows_returned_to_model': self.return_rows}
        if self.return_rows:
            # Serialize values consistently (dates, Decimal, non-finite floats, bytes).
            safe = [[None if isinstance(v, float) and not math.isfinite(v) else v.hex() if isinstance(v, bytes) else v for v in row] for row in rows]
            text = json.dumps(safe, ensure_ascii=False, default=str)
            if len(text.encode('utf-8')) > 100000:
                raise DataError('Query response exceeds 100 KiB; select fewer columns or fewer rows.')
            payload['rows'] = json.loads(text)
        if export_csv or not self.return_rows:
            target = self.root / 'exports' / f'query-{uuid.uuid4().hex}.csv'
            pd.DataFrame(rows, columns=columns).to_csv(target, index=False, encoding='utf-8-sig')
            payload['csv_path'] = str(target)
            payload['sha256'] = file_hash(target)
        return payload

    def nhanes_files(self, cycle_begin_year, component='Demographics'):
        if self.provider != 'nhanes':
            raise DataError('This tool is NHANES-only.')
        components = {'Demographics', 'Dietary', 'Examination', 'Laboratory', 'Questionnaire'}
        if component not in components or not 1999 <= cycle_begin_year <= 2100:
            raise DataError('Use a valid NHANES component and cycle start year.')
        url = f'https://wwwn.cdc.gov/nchs/nhanes/search/datapage.aspx?Component={component}&CycleBeginYear={cycle_begin_year}'
        links = Links()
        links.feed(self.remote_text(url))
        files = []
        for href in links.links:
            if urlsplit(href).path.lower().endswith('.xpt'):
                target = urljoin(url, href)
                self.allowed_url(target)
                documentation = next((urljoin(url, h) for h in links.links if
                    urlsplit(urljoin(url, h)).path.lower() == urlsplit(target).path[:-4].lower() + '.htm'), None)
                files.append({'filename': Path(unquote(urlsplit(target).path)).name, 'url': target,
                              'documentation_url': documentation})
        return {'cycle_begin_year': cycle_begin_year, 'component': component, 'files': files,
                'warning': 'Use official documentation to verify variable definitions and survey weights; files are not automatically merged.'}

    def physionet_files(self, directory_url):
        if self.provider not in {'mimic', 'eicu'} or not urlsplit(directory_url).path.startswith('/files/') or not directory_url.endswith('/'):
            raise DataError('Provide a PhysioNet /files/project/version/directory/ URL for this provider.')
        self.allowed_url(directory_url)
        links = Links()
        links.feed(self.remote_text(directory_url))
        files = []
        for href in links.links:
            target = urljoin(directory_url, href)
            if target.startswith(directory_url) and target != directory_url and not href.startswith(('?', '#')):
                self.allowed_url(target)
                files.append({'name': href, 'url': target, 'directory': target.endswith('/')})
        return {'files': files[:300], 'truncated': len(files) > 300}

    def faers_query(self, search='', count='', limit=10, skip=0):
        if self.provider != 'faers' or not 1 <= limit <= 1000 or not 0 <= skip <= 25000:
            raise DataError('FAERS-only; use limit 1–1000 and skip 0–25000.')
        params = {'limit': limit}
        if search:
            params['search'] = search
        if count:
            params['count'] = count
        else:
            params['skip'] = skip
        if os.environ.get('OPENFDA_API_KEY'):
            params['api_key'] = os.environ['OPENFDA_API_KEY']
        url = str(httpx.URL('https://api.fda.gov/drug/event.json', params=params))
        try:
            payload = self.remote_text(url, True)
        except DataError as exc:
            if 'HTTP 404' in str(exc):
                return {'results': [], 'total': 0, 'source': 'openFDA drug/event'}
            raise
        # Return a bounded result; do not report a paginated page as the full database.
        target = self.root / 'downloads' / f'faers-query-{uuid.uuid4().hex}.json'
        target.write_text(json.dumps(payload, ensure_ascii=False), encoding='utf-8')
        results = payload.get('results', [])
        return {'meta': payload.get('meta', {}), 'results': results[:min(limit, 20)],
                'display_truncated': len(results) > 20, 'json_path': str(target),
                'sha256': file_hash(target), 'warning': 'Reports are not incidence, prevalence, or proof of causation.'}

    def faers_downloads(self, limit=50):
        if self.provider != 'faers' or not 1 <= limit <= 200:
            raise DataError('FAERS-only; use a limit from 1 to 200.')
        payload = self.remote_text('https://api.fda.gov/download.json', True)
        partitions = payload['results']['drug']['event']['partitions']
        return {'partition_count': len(partitions), 'files': partitions[:limit], 'truncated': len(partitions) > limit,
                'note': 'This is the official openFDA bulk JSON partition manifest, not the FDA quarterly ASCII table format.'}

    def europepmc_search(self, query, page_size=20, cursor='*'):
        if self.provider != 'europepmc':
            raise DataError('This tool is Europe PMC-only.')
        if not isinstance(query, str) or not query.strip() or len(query) > 12000:
            raise DataError('Provide a nonempty literature query of at most 12000 characters.')
        if not 1 <= page_size <= 100 or not cursor or len(cursor) > 4096:
            raise DataError('Use page_size 1–100 and a valid returned cursor.')
        params = {'query': query, 'format': 'json', 'resultType': 'core', 'pageSize': page_size, 'cursorMark': cursor}
        payload = self.remote_text(str(httpx.URL('https://www.ebi.ac.uk/europepmc/webservices/rest/search', params=params)), True)
        records = payload.get('resultList', {}).get('result', [])
        if not isinstance(records, list) or 'hitCount' not in payload:
            raise DataError('Europe PMC did not return the expected search envelope.')
        next_cursor = payload.get('nextCursorMark')
        return {'source': 'europepmc', 'query': query, 'total_count': payload['hitCount'],
                'returned_count': len(records), 'records': records,
                'cursor': cursor, 'next_cursor': next_cursor,
                'has_more': bool(records and next_cursor and next_cursor != cursor and payload['hitCount'] > len(records)),
                'retrieved_at': now(), 'support_level': 'abstract'}
