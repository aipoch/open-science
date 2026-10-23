"""Access guidance reports presence only; it cannot verify project approval."""
from functools import wraps
import os
from core import DataError

POLICIES = {
    'charls': ('data_permission', 'Register and obtain personal CHARLS data access before downloading approved files. A cookie does not establish approval.', 'https://charls.pku.edu.cn/Faq/cjwt.htm', ['CHARLS_COOKIE']),
    'chns': ('conditional_data_permission', 'Household/individual longitudinal files are distributed through UNC Dataverse. Community-level data requires a separately approved data use agreement. A token is needed only for files requiring authentication; public files and local import do not require it.', 'https://chns.cpc.unc.edu/data/datasets/', ['DATAVERSE_API_TOKEN']),
    'seer': ('data_permission', 'Apply for personal SEER access and check product/geographic eligibility. Export CSV/TSV using SEER*Stat before local import. There is no automated research-database download here.', 'https://seer.cancer.gov/data/access.html', []),
    'gbd': ('portal_account', 'Use the official results tool account and terms to export CSV before import. This engine does not create online export tasks. The optional cookie is only forwarded to supported approved download hosts.', 'https://vizhub.healthdata.org/gbd-results/', ['GBD_COOKIE']),
    'faers': ('recommended_api_key', 'A free openFDA API key is recommended for online queries. Anonymous requests remain subject to current official quotas. Public bulk downloads and local imports do not require a key.', 'https://open.fda.gov/apis/authentication/', ['OPENFDA_API_KEY']),
}
for provider, project in [('mimic', 'mimiciv'), ('eicu', 'eicu-crd')]:
    POLICIES[provider] = ('credentialed_data_permission', 'Public demo data needs no account. Complete PhysioNet personal credentialing, required training and the project data use agreement before using the full dataset. Configured credentials do not establish project approval.', f'https://physionet.org/content/{project}/', ['PHYSIONET_USERNAME', 'PHYSIONET_PASSWORD'])


def access_guidance(provider, include_related_services=False):
    policy = POLICIES.get(provider)
    result = {
        'provider': provider,
        'kind': policy[0] if policy else 'public',
        'message': policy[1] if policy else 'Public functionality does not require an API key. Official limits and access challenges still apply.',
        'permission_status': 'not_verified' if policy else 'public_scope_only',
        'credentials': {name: {'configured': bool(os.environ.get(name))} for name in policy[3]} if policy else {},
        'credential_instructions': 'Credentials are supplied by the host environment, never tool arguments or chat. Presence is not a check of validity or data authorization.',
    }
    if policy:
        result['application_url'] = policy[2]
    if include_related_services:
        result['related_credentials_status'] = 'not_checked_managed_by_host_app'
        result['related_builtin_services'] = [
            {'source': 'OpenAlex', 'application_url': 'https://help.openalex.org/api/authentication/', 'message': 'A free activated key is needed for cursor paging beyond the first page.'},
            {'source': 'NCBI', 'application_url': 'https://support.nlm.nih.gov/kbArticle/?pn=KA-05317', 'message': 'An optional key increases E-utilities throughput.'},
            {'source': 'openFDA', 'application_url': 'https://open.fda.gov/apis/authentication/', 'message': 'A free key is recommended for regular online queries.'},
        ]
    return result


def access_tool(app, store):
    def tool(*args, **kwargs):
        def decorate(function):
            @wraps(function)
            def invoke(*call_args, **call_kwargs):
                try:
                    result = function(*call_args, **call_kwargs)
                except DataError as exc:
                    policy = POLICIES.get(store.provider)
                    if policy:
                        raise DataError(f'{exc}\nAccess: {policy[1]}\nOfficial application: {policy[2]}') from None
                    raise
                if isinstance(result, dict) and store.provider in POLICIES:
                    result = {**result, 'access_guidance': access_guidance(store.provider)}
                return result
            if store.provider in POLICIES:
                invoke.__doc__ = (function.__doc__ or '') + '\nAccess: ' + POLICIES[store.provider][1]
            return app.tool(*args, **kwargs)(invoke)
        return decorate
    return tool
