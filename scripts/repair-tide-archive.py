#!/usr/bin/env python3
"""Audit stored USGS daily peaks against complete local-calendar IV records.

Only existing U rows may change. NOAA fills and official crest overrides are
preserved. Raw, checksum-verified snapshots live outside the published app.
Uses Python's standard library; --fetch is optional for an offline replay.
"""
import argparse
import collections
import concurrent.futures
import copy
import datetime as dt
import gzip
import hashlib
import json
import math
import pathlib
import statistics
import urllib.parse
import urllib.request
from zoneinfo import ZoneInfo

ZONE = ZoneInfo('America/New_York')
UTC = dt.timezone.utc
STATION = '01411360'
PARAMETER = '72279'
VERSION = '20261026-usgs-calendar-day-audit-v1'


def local_bounds(day):
    date = dt.date.fromisoformat(day)
    start = dt.datetime.combine(date, dt.time(), ZONE)
    end = dt.datetime.combine(date + dt.timedelta(days=1), dt.time(), ZONE)
    return int(start.timestamp()), int(end.timestamp())


def fetch_snapshots(cache_dir, start, end):
    """Fetch calendar-year chunks including the next midnight as an overlap.

    Overlapping observations are merged before calendar-day aggregation. A
    chunk endpoint alone can never overwrite an already complete daily peak.
    """
    cache_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = cache_dir / 'manifest.json'
    manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {
        'station': STATION, 'parameter': PARAMETER, 'chunks': [], 'errors': []}
    existing = {(c['start'], c['end']): c for c in manifest['chunks']}
    ranges = []
    for year in range(start.year, end.year + 1):
        a, b = max(start, dt.date(year, 1, 1)), min(end, dt.date(year, 12, 31))
        ranges.append((a, b))

    def fetch(pair):
        a, b = pair
        if (str(a), str(b)) in existing:
            return existing[(str(a), str(b))]
        stamp = lambda day: dt.datetime.combine(day, dt.time(), ZONE).isoformat()
        query = {'format': 'json', 'sites': STATION, 'parameterCd': PARAMETER,
                 'siteStatus': 'all', 'startDT': stamp(a),
                 'endDT': stamp(b + dt.timedelta(days=1))}
        url = 'https://waterservices.usgs.gov/nwis/iv/?' + urllib.parse.urlencode(query)
        req = urllib.request.Request(url, headers={
            'Accept-Encoding': 'gzip', 'User-Agent': 'RoadRisk-archive-audit/1.0'})
        with urllib.request.urlopen(req, timeout=90) as response:
            raw = response.read()
            if response.headers.get('Content-Encoding') == 'gzip':
                raw = gzip.decompress(raw)
        document = json.loads(raw)
        if not document.get('value', {}).get('timeSeries'):
            raise ValueError(f'No instantaneous series for {a} through {b}')
        name = f'{a}_{b}.json.gz'
        (cache_dir / name).write_bytes(gzip.compress(raw, compresslevel=6, mtime=0))
        return {'start': str(a), 'end': str(b), 'url': url, 'path': name,
                'sha256': hashlib.sha256(raw).hexdigest(), 'bytes': len(raw),
                'retrievedAt': dt.datetime.now(UTC).isoformat()}

    errors = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        futures = {pool.submit(fetch, pair): pair for pair in ranges}
        for future in concurrent.futures.as_completed(futures):
            try:
                chunk = future.result()
                existing[(chunk['start'], chunk['end'])] = chunk
            except Exception as exc:
                errors.append({'range': [str(x) for x in futures[future]], 'error': str(exc)})
    manifest['chunks'] = sorted(existing.values(), key=lambda item: item['start'])
    manifest['errors'] = errors
    manifest_path.write_text(json.dumps(manifest, indent=2) + '\n')
    return manifest


def merge_document(document, days, wanted=None):
    """Merge individual observations by UTC instant; flag conflicting duplicates."""
    found = False
    for series in document.get('value', {}).get('timeSeries', []):
        codes = {str(v['value']) for v in series['variable']['variableCode']}
        sites = {str(v['value']) for v in series['sourceInfo']['siteCode']}
        if PARAMETER not in codes or STATION not in sites:
            continue
        if series['variable']['unit']['unitCode'] != 'ft':
            raise ValueError('Expected NAVD88 feet; refusing implicit conversion')
        if 'NAVD88' not in series['variable']['variableName']:
            raise ValueError('Series does not identify NAVD88')
        found = True
        nodata = float(series['variable']['noDataValue'])
        for group in series['values']:
            for row in group['value']:
                moment = dt.datetime.fromisoformat(row['dateTime'].replace('Z', '+00:00'))
                if moment.tzinfo is None:
                    raise ValueError('Instantaneous observation has no timezone')
                day = moment.astimezone(ZONE).date().isoformat()
                if wanted is not None and day not in wanted:
                    continue
                try:
                    value = float(row['value'])
                except (TypeError, ValueError):
                    continue
                if not math.isfinite(value) or value == nodata:
                    continue
                qualifiers = tuple(sorted(set(row.get('qualifiers', []))))
                target = days.setdefault(day, {'values': {}, 'conflicts': set()})
                instant = int(moment.timestamp())
                previous = target['values'].get(instant)
                if previous is not None and previous[0] != value:
                    target['conflicts'].add(instant)
                # Qualifiers are combined; one unknown qualifier cannot disappear
                # simply because a duplicate observation arrived in another chunk.
                if previous is not None:
                    qualifiers = tuple(sorted(set(previous[1]) | set(qualifiers)))
                target['values'][instant] = (value, qualifiers)
    if not found:
        raise ValueError('Snapshot contains no requested station/parameter series')


def daily_summary(day, record, interval_seconds=360):
    start, end = local_bounds(day)
    values = record.get('values', {})
    times = sorted(t for t in values if start <= t < end)
    expected = (end - start) // interval_seconds
    flags = sorted({q for t in times for q in values[t][1]})
    unknown = sorted(set(flags) - {'A', 'P', 'e'})
    ungraded = sum(not (set(values[t][1]) & {'A', 'P'}) for t in times)
    trusted_times = [t for t in times if set(values[t][1]) <= {'A', 'P', 'e'}
                     and set(values[t][1]) & {'A', 'P'}
                     and t not in record.get('conflicts', set())]
    gaps = [b - a for a, b in zip(times, times[1:])]
    first_gap = times[0] - start if times else end - start
    last_gap = end - times[-1] if times else end - start
    complete = (len(times) == expected and first_gap == 0
                and last_gap == interval_seconds
                and max(gaps, default=0) <= interval_seconds
                and not record.get('conflicts') and not unknown and not ungraded)
    reasons = []
    if len(times) != expected or first_gap or last_gap != interval_seconds or max(gaps, default=0) > interval_seconds:
        reasons.append('incomplete-calendar-day')
    if record.get('conflicts'):
        reasons.append('conflicting-observations')
    if unknown or ungraded or not set(flags) & {'A', 'P'}:
        reasons.append('unrecognized-quality')
    return {'date': day, 'complete': complete, 'samples': len(times),
            'expectedSamples': expected, 'durationHours': (end - start) / 3600,
            'firstGapSeconds': first_gap, 'lastGapSeconds': last_gap,
            'maximumInternalGapSeconds': max(gaps, default=0), 'qualifiers': flags,
            'ungradedSamples': ungraded,
            'maximumFt': max((values[t][0] for t in times), default=None),
            'trustedMaximumFt': max((values[t][0] for t in trusted_times), default=None),
            'reasons': reasons}


def load_summaries(cache_dir, wanted):
    manifest = json.loads((cache_dir / 'manifest.json').read_text())
    days = {}
    for chunk in manifest['chunks']:
        raw = gzip.decompress((cache_dir / chunk['path']).read_bytes())
        if hashlib.sha256(raw).hexdigest() != chunk['sha256']:
            raise ValueError(f"Snapshot checksum mismatch: {chunk['path']}")
        merge_document(json.loads(raw), days, wanted)
    return {day: daily_summary(day, days.get(day, {})) for day in sorted(wanted)}, manifest


def classify(value, thresholds):
    for level in ('major', 'moderate', 'minor'):
        if value >= thresholds[level]:
            return level
    return 'none'


def derive_statistics(stats):
    """Recalculate published aggregates from the exact canonical runtime rows.

    Annual minor/moderate/major fields are cumulative threshold exceedances;
    archive.classificationCounts are mutually exclusive categories.
    """
    rows = stats['dailyPeakCompact']
    thresholds = stats['thresholds']['navd88']
    classifications = collections.Counter({'none': 0, 'minor': 0, 'moderate': 0, 'major': 0})
    annual, monthly, water_max = {}, {}, {}
    source_counts = collections.Counter()
    for date, hundredths, source in rows:
        value = hundredths / 100
        classifications[classify(value, thresholds)] += 1
        source_counts[source] += 1
        year, month = int(date[:4]), int(date[5:7])
        water_year = year + (month >= 10)
        water_max[water_year] = max(value, water_max.get(water_year, -math.inf))
        for target, key in ((annual, year), (monthly, date[:7])):
            counter = target.setdefault(key, {'minor': 0, 'moderate': 0, 'major': 0, 'days': 0})
            counter['days'] += 1
            for level, threshold in thresholds.items():
                counter[level] += value >= threshold
    archive = dict(stats['archive'])
    archive.update(startDate=rows[0][0], endDate=rows[-1][0], days=len(rows),
                   years=round(len(rows) / 365.2425, 2),
                   classificationCounts=dict(classifications), sourceCounts=dict(source_counts))
    offsets = {stats['thresholds']['mllw'][level] - value for level, value in thresholds.items()}
    if len(offsets) != 1:
        raise ValueError('Configured datum presets disagree')
    offset = offsets.pop()
    names = {'U': 'primary-usgs-continuous', 'N': 'bias-corrected-noaa',
             'C': 'official-usgs-storm-tide-crest'}
    events = []
    for rank, (date, hundredths, source) in enumerate(sorted(rows, key=lambda row: (-row[1], row[0]))[:25], 1):
        date_obj = dt.date.fromisoformat(date)
        events.append({'rank': rank, 'date': date,
                       'displayDate': f'{date_obj:%b} {date_obj.day}, {date_obj.year}',
                       'heightNavd88Ft': hundredths / 100,
                       'heightMllwFt': round(hundredths / 100 + offset, 2),
                       'classification': classify(hundredths / 100, thresholds),
                       'source': names[source],
                       'stationId': stats['station']['noaaGaugeId'] if source == 'N' else STATION})
    maxima = list(water_max.values())
    scale = statistics.stdev(maxima) * math.sqrt(6) / math.pi
    location = statistics.mean(maxima) - 0.5772156649015329 * scale
    # Retain the original finite plotting-position convention at T=1.
    # For all T>1, use the standard annual-max Gumbel quantile F=1-1/T.
    levels = [{'years': item['years'], 'navd88Ft': round(
        location - scale * math.log(-math.log(max(1 / (len(maxima) + 1), 1 - 1 / item['years']))), 4)}
        for item in stats['returnIntervals']['levels']]
    fit = {'method': stats['returnIntervals']['method'], 'sampleYears': len(maxima),
           'locationFt': round(location, 5), 'scaleFt': round(scale, 5), 'levels': levels,
           'inputPrecision': 'Canonical dailyPeakCompact values, hundredths of a NAVD88 foot',
           'standardDeviation': 'sample (n-1)',
           'oneYearQuantileConvention': 'F=max(1/(sampleYears+1),1-1/T)',
           'coverageCaveat': 'Includes partial water years as in the original fit; not a revalidated engineering frequency model.'}
    return {'archive': archive,
            'annualCounts': [dict(year=year, **annual[year]) for year in sorted(annual)],
            'topEvents': events, 'returnIntervals': fit,
            'waterYearMaximaAudit': [{'waterYear': year, 'maximumFt': water_max[year]} for year in sorted(water_max)],
            'monthlyAudit': [dict(month=month, **monthly[month]) for month in sorted(monthly)]}


def noaa_fallback_peak(day, fallback, bias):
    """Validate the separately audited, complete verified-hourly fallback."""
    if not fallback or not fallback.get('complete'):
        return None
    start, end = local_bounds(day)
    expected = (end - start) // 3600
    expected_start = dt.datetime.fromtimestamp(start, UTC).isoformat()
    expected_end = dt.datetime.fromtimestamp(end - 3600, UTC).isoformat()
    if (fallback.get('validCount') != expected or fallback.get('expected') != expected
            or fallback.get('quality') != 'verified-hourly-complete-unflagged'
            or any(fallback.get(key, 1) for key in ('nonzeroFlagCount', 'unknownFlagCount',
                                                   'unexpectedQualityCount', 'offGridCount',
                                                   'duplicateCount', 'invalidValueCount'))
            or fallback.get('reasons')
            or fallback.get('missingUtc')
            or fallback.get('firstExpectedUtc') != expected_start
            or fallback.get('lastExpectedUtc') != expected_end
            or fallback.get('firstExpectedUtc') != fallback.get('firstValidUtc')
            or fallback.get('lastExpectedUtc') != fallback.get('lastValidUtc')):
        raise ValueError(f'NOAA fallback completeness contract failed: {day}')
    raw_max = fallback.get('rawMaxFt')
    if raw_max is None or not math.isfinite(raw_max) or abs(fallback.get('biasFt', math.inf) - bias) > 1e-12:
        raise ValueError(f'NOAA fallback units/bias contract failed: {day}')
    maximum = raw_max + bias
    if abs(fallback.get('maximumFt', math.inf) - maximum) > 1e-10:
        raise ValueError(f'NOAA fallback maximum contract failed: {day}')
    return int(round(maximum * 100))


def validate_noaa_manifest(path, configured_bias):
    summary_path = path.with_name('noaa-fallback-summary.json')
    summary = json.loads(summary_path.read_text())
    if hashlib.sha256(path.read_bytes()).hexdigest() != summary.get('fallbackDataSha256'):
        raise ValueError('NOAA derived fallback map checksum mismatch')
    expected = {'station': '8557380', 'product': 'hourly_height', 'datum': 'NAVD',
                'units': 'english', 'time_zone': 'gmt',
                'grouping_time_zone': 'America/New_York', 'bias_ft': configured_bias}
    if any(summary.get(key) != value for key, value in expected.items()):
        raise ValueError('NOAA audit station/product/datum/timezone/bias contract failed')
    manifest_path = path.with_name('noaa-raw-manifest.json')
    raw_manifest = manifest_path.read_bytes()
    if hashlib.sha256(raw_manifest).hexdigest() != summary['rawManifestSha256']:
        raise ValueError('NOAA raw manifest checksum mismatch')
    manifest = json.loads(raw_manifest)
    for item in manifest:
        raw_path = pathlib.Path(item['cache_file'])
        if not raw_path.exists():
            raw_path = path.parent / 'noaa-raw' / raw_path.name
        if hashlib.sha256(raw_path.read_bytes()).hexdigest() != item['sha256']:
            raise ValueError(f'NOAA raw snapshot checksum mismatch: {raw_path}')
    return {'summary': summary, 'rawManifest': manifest,
            'fallbackInputSha256': hashlib.sha256(path.read_bytes()).hexdigest()}


def repair(stats, summaries, audited_at, source_retrieved_at=None,
           noaa_fallback=None, exclude_unresolved=False):
    result = copy.deepcopy(stats)
    changes, unresolved, exclusions, fallback_dates, contradictory_dates = [], [], [], [], []
    removed_dates = set()
    bias = stats.get('provenance', {}).get('noaaBiasCorrectionFt')
    for row in result['dailyPeakCompact']:
        if row[2] != 'U':
            continue  # NOAA fills and official crest overrides are deliberately protected.
        summary = summaries.get(row[0])
        if not summary or not summary['complete']:
            primary = summary or {'date': row[0], 'reasons': ['not-audited']}
            fallback = (noaa_fallback or {}).get(row[0])
            if fallback is not None and bias is None:
                raise ValueError('NOAA bias is not explicitly configured')
            replacement = noaa_fallback_peak(row[0], fallback, bias) if fallback else None
            trusted_lower_bound = primary.get('trustedMaximumFt')
            contradiction = (replacement is not None and trusted_lower_bound is not None
                             and replacement / 100 < trusted_lower_bound - 1e-10)
            if contradiction:
                contradictory_dates.append(row[0])
                replacement = None
            if replacement is not None:
                changes.append(dict(date=row[0], oldFt=row[1] / 100, newFt=replacement / 100,
                                    differenceFt=round((replacement - row[1]) / 100, 2),
                                    oldSource='U', newSource='N', quality=fallback,
                                    reason='USGS day does not qualify; complete verified NOAA hourly day plus existing bias'))
                row[1], row[2] = replacement, 'N'
                fallback_dates.append(row[0])
            else:
                unresolved.append(dict(primary, noaaFallback=fallback,
                                       proxyBelowTrustedObservation=contradiction))
                if exclude_unresolved:
                    if fallback is None:
                        raise ValueError(f'No NOAA audit supplied for unresolved day {row[0]}')
                    reason = ('Complete NOAA proxy is below a trusted finite USGS observation'
                              if contradiction else 'Neither source qualifies for a complete daily maximum')
                    exclusions.append(dict(date=row[0], oldFt=row[1] / 100, oldSource='U',
                                           trustedLowerBoundFt=trusted_lower_bound,
                                           reason=reason,
                                           usgs=primary, noaa=fallback))
                    removed_dates.add(row[0])
            continue
        new_hundredths = int(round(summary['maximumFt'] * 100))
        if new_hundredths != row[1]:
            changes.append(dict(date=row[0], oldFt=row[1] / 100, newFt=new_hundredths / 100,
                                differenceFt=round((new_hundredths - row[1]) / 100, 2),
                                oldSource='U', newSource='U',
                                quality=summary,
                                reason='Current complete USGS local-calendar maximum differs from stored U peak'))
            row[1] = new_hundredths
    result['dailyPeakCompact'] = [row for row in result['dailyPeakCompact'] if row[0] not in removed_dates]
    result_by_date = {row[0]: row for row in result['dailyPeakCompact']}
    if any(result_by_date.get(row[0]) != row for row in stats['dailyPeakCompact'] if row[2] in {'N', 'C'}):
        raise ValueError('Protected original NOAA fill or crest override changed')
    before, after = derive_statistics(stats), derive_statistics(result)
    old_maxima = {r['waterYear']: r['maximumFt'] for r in before['waterYearMaximaAudit']}
    new_maxima = {r['waterYear']: r['maximumFt'] for r in after['waterYearMaximaAudit']}
    maximum_changes = [dict(waterYear=year, oldMaximumFt=old_maxima.get(year),
                            maximumFt=new_maxima.get(year))
                       for year in sorted(set(old_maxima) | set(new_maxima))
                       if old_maxima.get(year) != new_maxima.get(year)]
    for key in ('archive', 'annualCounts'):
        result[key] = after[key]
    if 'highTideCount' in result.get('tideModel', {}):
        result['tideModel']['highTideCount'] = len(result['dailyPeakCompact'])
    if maximum_changes:
        result['returnIntervals'] = after['returnIntervals']
    # Preserve existing authority/source metadata for unchanged ranked events.
    old_events = {(row['date'], row['heightNavd88Ft'], row['source']): row
                  for row in stats['topEvents']}
    result['topEvents'] = [dict(old_events.get((row['date'], row['heightNavd88Ft'], row['source']), row),
                                rank=row['rank']) for row in after['topEvents']]
    result['generatedAt'] = audited_at
    result['provenance']['archiveRepair'] = {
        'version': VERSION, 'auditedAt': audited_at,
        'sourceRetrievedAt': source_retrieved_at,
        'scope': 'Audit existing U rows; replace incomplete U days only with qualifying NOAA fallback, otherwise omit as unknown when explicitly requested. Existing N fills and C crests preserved.',
        'dayDefinition': 'America/New_York local calendar [00:00,next00:00), DST-aware',
        'completeDayRequirement': 'Every expected six-minute instant, both day edges, no internal gaps or conflicting/unknown-quality observations',
        'storedUsgsDays': sum(row[2] == 'U' for row in stats['dailyPeakCompact']),
        'completeUsgsDaysAudited': sum(s.get('complete', False) for s in summaries.values()),
        'correctedUsgsDays': sum(c['newSource'] == 'U' for c in changes),
        'noaaFallbackDays': len(fallback_dates),
        'unresolvedUsgsDays': len(unresolved), 'excludedUnknownDays': len(exclusions),
        'excludedDates': sorted(removed_dates),
        'proxyContradictions': len(contradictory_dates),
        'trustedObservationPolicy': 'Finite A or P observations, including A/P+e estimated values; unknown flags, ungraded values and conflicting instants excluded from lower bounds.',
        'proxyPolicy': 'A rounded NOAA proxy must not fall below any trusted finite local USGS observation; no hybrid/max estimate is invented.',
        'auditDocument': 'data-quality/archive-repair-20261026.json',
        'preserved': ['NOAA bias correction', 'tideModel/trend coefficients and source metadata',
                      'configured datum thresholds', 'NOAA fills', 'official USGS crest overrides'],
        'aggregatePolicy': 'Counts rebuilt from canonical hundredth-foot runtime rows; unchanged event authority metadata retained; Gumbel refitted only when water-year maxima change. Original full-precision fit inputs are unavailable.'}
    report = {'version': VERSION, 'generatedAt': audited_at,
              'scope': result['provenance']['archiveRepair'], 'changes': changes,
              'waterYearMaximumChanges': maximum_changes,
              'publishedReturnIntervalsRefitted': bool(maximum_changes),
              'unresolved': unresolved, 'exclusions': exclusions,
              'noaaFallbackDates': fallback_dates,
              'contradictoryProxyDates': contradictory_dates,
              'auditDays': [[day, s['samples'], s['expectedSamples'], s['complete'], s['maximumFt'], s['qualifiers']]
                            for day, s in sorted(summaries.items())],
              'auditDayColumns': ['date', 'validSamples', 'expectedSamples', 'complete', 'maximumFt', 'qualifiers'],
              'beforePublished': {key: stats[key] for key in ('archive', 'annualCounts', 'topEvents', 'returnIntervals')},
              'beforeCanonical': before, 'afterCanonical': after,
              'caveats': ['Current USGS provisional values and approved revisions may differ from original retrievals; no particular upstream cause is asserted.',
                          'Only original U rows are audited. Existing NOAA-filled days and pre-2007 history are not certified by this audit.',
                          'Nonqualifying USGS days use a full verified hourly NOAA proxy plus the existing bias only if it does not contradict a trusted local observation; all other days are explicitly unknown, never invented.',
                          'Daily Tidal High-High statistic 00021 is not substituted for a calendar-day maximum. Maximum statistic 00001 is unavailable at this station.',
                          'Return-interval fit is only recomputed using its existing water-year Gumbel method, not independently scientifically validated.'],
              'primaryDocumentation': ['https://waterservices.usgs.gov/docs/dv-service/daily-values-service-details/',
                                       'https://help.waterdata.usgs.gov/parameter_cd?group_cd=PHY',
                                       'https://pubs.usgs.gov/of/2003/ofr03123/3.overview.pdf']}
    if any(c['date'] == '2016-01-23' for c in changes):
        report['historicalStormCrossCheck'] = {
            'date': '2016-01-23', 'station': STATION, 'verifiedNavd88Ft': 6.22,
            'primaryMunicipalSource': 'https://stoneharbornj.org/wp-content/uploads/2022/04/Flood-Mitigation-and-Storm-Sewer-Presentation.pdf',
            'note': 'Stone Harbor municipal presentation independently lists this station peak as 6.22 ft; North Wildwood city-gauge peaks are a different location.'}
    return result, report


def compact_public_report(report):
    """Public accountability without raw IV arrays or private cache paths."""
    source_manifest = [dict(provider='USGS', **{key: row[key] for key in
                       ('start', 'end', 'url', 'sha256', 'retrievedAt')})
                       for row in report['snapshots']['chunks']]
    noaa = report.get('noaaFallbackProvenance')
    if noaa:
        source_manifest += [dict(provider='NOAA', **{key: row[key] for key in
                            ('year', 'url', 'sha256', 'sourceRetrievedAt')})
                            for row in noaa['rawManifest']]
    changes = [{key: row[key] for key in ('date', 'oldFt', 'newFt', 'differenceFt',
                                         'oldSource', 'newSource', 'reason')}
               for row in report['changes']]
    quarantined = [dict(date=row['date'], originalRow=[row['date'], int(round(row['oldFt'] * 100)), 'U'],
                       trustedLowerBoundFt=row['trustedLowerBoundFt'], reason=row['reason'],
                       noaaProxyFt=row['noaa'].get('maximumFt'),
                       usgsSamples=row['usgs'].get('samples'),
                       usgsExpectedSamples=row['usgs'].get('expectedSamples'),
                       noaaReasons=row['noaa'].get('reasons')) for row in report['exclusions']]
    return {'version': report['version'], 'auditedAt': report['generatedAt'],
            'scope': report['scope'], 'inputSha256': report['inputSha256'],
            'outputSha256': report['outputSha256'], 'changes': changes,
            'quarantinedRows': quarantined, 'sourceManifest': source_manifest,
            'beforePublishedArchive': report['beforePublished']['archive'],
            'beforeCanonicalArchive': report['beforeCanonical']['archive'],
            'afterCanonicalArchive': report['afterCanonical']['archive'],
            'waterYearMaximumChanges': report['waterYearMaximumChanges'],
            'publishedReturnIntervalsRefitted': report['publishedReturnIntervalsRefitted'],
            'beforePublishedReturnIntervals': report['beforePublished']['returnIntervals'],
            'afterCanonicalReturnIntervals': report['afterCanonical']['returnIntervals'],
            'historicalStormCrossCheck': report.get('historicalStormCrossCheck'),
            'caveats': report['caveats'], 'primaryDocumentation': report['primaryDocumentation'],
            'protectedOriginalNAndCUnchanged': True,
            'fullEvidence': 'Full per-day audit, original archive backup and raw checksum snapshots retained separately from the runtime application.'}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--archive', type=pathlib.Path, default=pathlib.Path('flood_stats.json'))
    parser.add_argument('--baseline', type=pathlib.Path,
                        help='Optional original JSON or JSON.gz input; --archive remains the output target')
    parser.add_argument('--cache-dir', type=pathlib.Path, required=True)
    parser.add_argument('--report', type=pathlib.Path, required=True)
    parser.add_argument('--compact-report', type=pathlib.Path,
                        default=pathlib.Path('data-quality/archive-repair-20261026.json'))
    parser.add_argument('--fetch', action='store_true')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--noaa-fallback', type=pathlib.Path,
                        help='Reproducible complete-hourly NOAA fallback map from audit-noaa-fallback.py')
    parser.add_argument('--exclude-unresolved', action='store_true',
                        help='Omit days failing both source checks; requires the NOAA audit map')
    args = parser.parse_args()
    raw = (args.baseline or args.archive).read_bytes()
    if args.baseline and args.baseline.suffix == '.gz':
        raw = gzip.decompress(raw)
    stats = json.loads(raw)
    wanted = {row[0] for row in stats['dailyPeakCompact'] if row[2] == 'U'}
    if args.fetch:
        fetch_snapshots(args.cache_dir, dt.date.fromisoformat(min(wanted)),
                        dt.date.fromisoformat(stats['archive']['endDate']))
    summaries, manifest = load_summaries(args.cache_dir, wanted)
    source_retrieved = max((c['retrievedAt'] for c in manifest['chunks']), default=None)
    if args.exclude_unresolved and not args.noaa_fallback:
        parser.error('--exclude-unresolved requires --noaa-fallback')
    noaa_map = json.loads(args.noaa_fallback.read_text()) if args.noaa_fallback else None
    noaa_provenance = validate_noaa_manifest(args.noaa_fallback, stats['provenance']['noaaBiasCorrectionFt']) if args.noaa_fallback else None
    if noaa_provenance:
        source_retrieved = max([source_retrieved] + [c['sourceRetrievedAt'] for c in noaa_provenance['rawManifest']])
    result, report = repair(stats, summaries, dt.datetime.now(UTC).isoformat(), source_retrieved,
                            noaa_map, args.exclude_unresolved)
    if args.noaa_fallback:
        report['noaaFallbackProvenance'] = noaa_provenance
    report['inputSha256'] = hashlib.sha256(raw).hexdigest()
    report['snapshots'] = manifest
    output = (json.dumps(result, separators=(',', ':')) + '\n').encode()
    report['outputSha256'] = hashlib.sha256(output).hexdigest()
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, indent=2) + '\n')
    if args.apply:
        backup = args.report.with_suffix('.original.json.gz')
        if not backup.exists():
            backup.write_bytes(gzip.compress(raw, mtime=0))
        temporary = args.archive.with_suffix(args.archive.suffix + '.repair-tmp')
        temporary.write_bytes(output)
        temporary.replace(args.archive)
        args.compact_report.parent.mkdir(parents=True, exist_ok=True)
        args.compact_report.write_text(json.dumps(compact_public_report(report), indent=2) + '\n')
    print(json.dumps({'correctedDays': len(report['changes']),
                      'unresolvedDays': len(report['unresolved']),
                      'report': str(args.report), 'applied': args.apply}))


if __name__ == '__main__':
    main()
