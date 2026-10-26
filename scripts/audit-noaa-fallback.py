"""Read-only NOAA verified-hourly fallback audit for unresolved USGS days."""
import argparse
import collections
import concurrent.futures
import datetime as dt
import hashlib
import json
import math
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path
from zoneinfo import ZoneInfo

ROOT = Path(__file__).resolve().parent
RAW = ROOT / 'noaa-raw'
NY = ZoneInfo('America/New_York')
UTC = dt.timezone.utc
BIAS_FT = 0.066
API = 'https://api.tidesandcurrents.noaa.gov/api/prod/datagetter'
DOCS = ['https://api.tidesandcurrents.noaa.gov/api/prod/',
        'https://api.tidesandcurrents.noaa.gov/api/prod/responseHelp.html']


def bounds(date):
    day = dt.date.fromisoformat(date)
    start = dt.datetime.combine(day, dt.time(), NY).astimezone(UTC)
    end = dt.datetime.combine(day + dt.timedelta(days=1), dt.time(), NY).astimezone(UTC)
    return start, end


def fetch_year(year, dates):
    begin = bounds(min(dates))[0]
    end = bounds(max(dates))[1] - dt.timedelta(hours=1)
    query = {'station': '8557380', 'product': 'hourly_height', 'datum': 'NAVD',
             'units': 'english', 'time_zone': 'gmt', 'format': 'json',
             'begin_date': begin.strftime('%Y%m%d %H:%M'),
             'end_date': end.strftime('%Y%m%d %H:%M'), 'application': 'RoadRisk-unresolved-day-audit'}
    url = API + '?' + urllib.parse.urlencode(query)
    path = RAW / f'8557380-hourly-NAVD-gmt-{year}-{min(dates)}-{max(dates)}.json'
    cache = path.exists()
    error = None
    if cache:
        data = path.read_bytes()
    else:
        data = None
        for attempt in range(2):
            try:
                request = urllib.request.Request(url, headers={'User-Agent': 'RoadRisk-coverage-audit/20261026'})
                with urllib.request.urlopen(request, timeout=55) as response:
                    data = response.read()
                path.write_bytes(data)
                break
            except (urllib.error.URLError, TimeoutError) as exc:
                error = str(exc)
                if attempt == 0:
                    time.sleep(1)
        if data is None:
            return {'year': year, 'url': url, 'cache': cache, 'error': error, 'dates': dates, 'rows': []}
    try:
        document = json.loads(data)
        rows = document.get('data', [])
        if 'error' in document:
            error = str(document['error'])
        if not isinstance(rows, list):
            rows = []; error = 'NOAA data field is not an array.'
        station = str(document.get('metadata', {}).get('id', ''))
        if station != '8557380' and not error:
            error = 'NOAA response metadata did not confirm station 8557380.'
        return {'year': year, 'url': url, 'cache': cache, 'error': error, 'dates': dates,
                'rows': rows, 'metadata': document.get('metadata'),
                'cache_file': str(path), 'sha256': hashlib.sha256(data).hexdigest(), 'bytes': len(data),
                'sourceRetrievedAt': dt.datetime.fromtimestamp(path.stat().st_mtime, UTC).isoformat()}
    except (ValueError, AttributeError) as exc:
        return {'year': year, 'url': url, 'cache': cache, 'error': str(exc), 'dates': dates, 'rows': []}


def analyze(result):
    by_day = collections.defaultdict(list)
    malformed = 0
    flags = collections.Counter()
    qualities = collections.Counter()
    for row in result['rows']:
        try:
            instant = dt.datetime.strptime(row['t'], '%Y-%m-%d %H:%M').replace(tzinfo=UTC)
        except (KeyError, TypeError, ValueError):
            malformed += 1
            continue
        flags[str(row.get('f'))] += 1
        qualities[str(row.get('q', '[absent for verified hourly product]'))] += 1
        by_day[instant.astimezone(NY).date().isoformat()].append((instant, row))
    days = {}
    for date in result['dates']:
        start, end = bounds(date)
        expected = set()
        instant = start
        while instant < end:
            expected.add(instant)
            instant += dt.timedelta(hours=1)
        values = {}
        duplicate_count = 0
        invalid_count = 0
        nonzero_flag_count = 0
        unknown_flag_count = 0
        unexpected_quality_count = 0
        off_grid_count = 0
        seen = set()
        for instant, row in by_day[date]:
            if instant in seen:
                duplicate_count += 1
            seen.add(instant)
            try:
                text = row.get('v')
                value = float(text) if isinstance(text, str) and text.strip() else float('nan')
            except (TypeError, ValueError):
                value = float('nan')
            if not math.isfinite(value):
                invalid_count += 1
                continue
            if instant not in expected:
                off_grid_count += 1
                continue
            raw_flags = row.get('f')
            parts = [part.strip() for part in raw_flags.split(',')] if isinstance(raw_flags, str) else []
            if len(parts) != 2 or any(part not in {'0', '1'} for part in parts):
                unknown_flag_count += 1
                continue
            if any(part == '1' for part in parts):
                nonzero_flag_count += 1
                continue
            if row.get('q') not in {None, 'v'}:
                unexpected_quality_count += 1
                continue
            values[instant] = value
        missing = sorted(expected - set(values))
        reasons = []
        if result['error']:
            reasons.append('source-fetch-or-metadata-error')
        if malformed:
            reasons.append('malformed-timestamps-in-source-response')
        if missing:
            reasons.append('incomplete-hourly-local-day')
        for count, reason in [(duplicate_count, 'duplicate-timestamps'), (invalid_count, 'invalid-values'),
                              (nonzero_flag_count, 'inferred-or-limit-flagged'),
                              (unknown_flag_count, 'unknown-quality-flags'),
                              (unexpected_quality_count, 'unverified-quality'),
                              (off_grid_count, 'off-hour-timestamps')]:
            if count:
                reasons.append(reason)
        complete = not reasons and set(values) == expected
        raw_max = max(values.values()) if values else None
        adjusted = raw_max + BIAS_FT if complete else None
        days[date] = {
            'complete': complete, 'maximumFt': adjusted, 'maxFt': adjusted,
            'rawMaxFt': raw_max, 'biasFt': BIAS_FT,
            'quality': 'verified-hourly-complete-unflagged' if complete else 'rejected',
            'validCount': len(values), 'expected': len(expected), 'reasons': reasons,
            'firstExpectedUtc': start.isoformat(), 'lastExpectedUtc': (end - dt.timedelta(hours=1)).isoformat(),
            'firstValidUtc': min(values).isoformat() if values else None,
            'lastValidUtc': max(values).isoformat() if values else None,
            'missingUtc': [instant.isoformat() for instant in missing],
            'duplicateCount': duplicate_count, 'invalidValueCount': invalid_count,
            'nonzeroFlagCount': nonzero_flag_count, 'unknownFlagCount': unknown_flag_count,
            'unexpectedQualityCount': unexpected_quality_count, 'offGridCount': off_grid_count,
            'source': 'NOAA 8557380 Lewes verified hourly NAVD88', 'sourceUrl': result['url']
        }
    return days, {'year': result['year'], 'requestedDates': len(result['dates']),
                  'rows': len(result['rows']), 'rawFlagCounts': dict(flags), 'rawQualityCounts': dict(qualities),
                  'malformedTimestamps': malformed,
                  **{key: result[key] for key in ['url', 'cache', 'error', 'metadata', 'cache_file', 'sha256', 'bytes', 'sourceRetrievedAt'] if key in result}}


def main():
    global ROOT, RAW
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--audit-dir', type=Path, required=True, help='Folder with initial differences.json; holds source snapshots and audit outputs')
    args = parser.parse_args()
    ROOT = args.audit_dir.resolve()
    RAW = ROOT / 'noaa-raw'
    RAW.mkdir(parents=True, exist_ok=True)
    unresolved = json.loads((ROOT / 'differences.json').read_text())['unresolved']
    grouped = collections.defaultdict(list)
    for row in unresolved:
        grouped[int(row['date'][:4])].append(row['date'])
    days = {}
    requests = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        jobs = {pool.submit(fetch_year, year, sorted(dates)): year for year, dates in grouped.items()}
        for job in concurrent.futures.as_completed(jobs):
            result = job.result()
            output, request = analyze(result)
            days.update(output); requests.append(request)
            print(json.dumps({'year': result['year'], 'requested': len(output),
                              'complete': sum(row['complete'] for row in output.values()),
                              'error': result['error'], 'rows': len(result['rows'])}), flush=True)
    days = dict(sorted(days.items()))
    (ROOT / 'noaa-fallback.json').write_text(json.dumps(days, indent=2) + '\n')
    raw_manifest = [{'year': row['year'], **{key: row[key] for key in
                     ['url', 'cache_file', 'sha256', 'bytes', 'sourceRetrievedAt'] if key in row}}
                    for row in sorted(requests, key=lambda row: row['year'])]
    raw_manifest_bytes = (json.dumps(raw_manifest, indent=2) + '\n').encode()
    (ROOT / 'noaa-raw-manifest.json').write_bytes(raw_manifest_bytes)
    summary = {
        'checkedUtc': dt.datetime.now(UTC).isoformat(), 'auditRunAt': dt.datetime.now(UTC).isoformat(),
        'rawManifestSha256': hashlib.sha256(raw_manifest_bytes).hexdigest(),
        'fallbackDataSha256': hashlib.sha256((ROOT / 'noaa-fallback.json').read_bytes()).hexdigest(),
        'rawManifestFile': str(ROOT / 'noaa-raw-manifest.json'),
        'station': '8557380', 'product': 'hourly_height', 'datum': 'NAVD', 'units': 'english',
        'time_zone': 'gmt', 'grouping_time_zone': 'America/New_York', 'bias_ft': BIAS_FT,
        'policy': 'Finite verified hourly values with documented I/L flags both zero; exact UTC hourly positions within each NY local day; duplicate/unknown-quality days rejected. Hourly proxy plus existing bias, not a local six-minute gauge maximum.',
        'requestedDays': len(days), 'completeDays': sum(row['complete'] for row in days.values()),
        'rejectedDays': [date for date, row in days.items() if not row['complete']],
        'expectedHourlyCounts': dict(collections.Counter(row['expected'] for row in days.values())),
        'rejectionReasonCounts': dict(collections.Counter(reason for row in days.values() for reason in row['reasons'])),
        'officialDocumentation': DOCS, 'requests': sorted(requests, key=lambda row: row['year']),
        'appFilesModified': False
    }
    (ROOT / 'noaa-fallback-summary.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps({key: summary[key] for key in ['requestedDays', 'completeDays', 'rejectedDays', 'expectedHourlyCounts', 'rejectionReasonCounts']}), flush=True)


if __name__ == '__main__':
    main()
