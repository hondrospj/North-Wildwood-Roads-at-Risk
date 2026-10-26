"""Scientific-data repair regressions; no network access is required."""
import copy
import datetime as dt
import importlib.util
import pathlib
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('tide_repair', ROOT / 'scripts/repair-tide-archive.py')
repair = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(repair)


def document(rows):
    return {'value': {'timeSeries': [{
        'sourceInfo': {'siteCode': [{'value': '01411360'}]},
        'variable': {'variableCode': [{'value': '72279'}], 'unit': {'unitCode': 'ft'},
                     'variableName': 'Tidal elevation, NOS-averaged, NAVD88, feet',
                     'noDataValue': -999999}, 'values': [{'value': rows}]}]}}


def complete_rows(day, peak=3.39):
    start, end = repair.local_bounds(day)
    return [{'dateTime': dt.datetime.fromtimestamp(t, repair.UTC).isoformat(),
             'value': str(peak if i == 120 else -1.56), 'qualifiers': ['P']}
            for i, t in enumerate(range(start, end, 360))]


def fixture():
    return {'generatedAt': 'old', 'thresholds': {
        'navd88': {'minor': 3.25, 'moderate': 4.25, 'major': 5.25},
        'mllw': {'minor': 6, 'moderate': 7, 'major': 8}},
        'archive': {}, 'station': {'noaaGaugeId': '8557380'}, 'provenance': {},
        'tideModel': {'trendFtPerYear': .01202106},
        'dailyPeakCompact': [['2025-08-10', 100, 'N'], ['2025-08-11', 573, 'C'],
                             ['2026-08-10', -156, 'U']],
        'annualCounts': [], 'topEvents': [],
        'returnIntervals': {'method': 'Gumbel method-of-moments fit to water-year maxima',
                            'levels': [{'years': 1}, {'years': 2}, {'years': 100}]}}


def fallback_fixture(day, maximum=3.39):
    start, end = repair.local_bounds(day)
    stamp = lambda t: dt.datetime.fromtimestamp(t, repair.UTC).isoformat()
    return {'complete': True, 'maximumFt': maximum, 'rawMaxFt': maximum - .066,
            'biasFt': .066, 'quality': 'verified-hourly-complete-unflagged',
            'validCount': (end-start)//3600, 'expected': (end-start)//3600,
            'nonzeroFlagCount': 0, 'unknownFlagCount': 0, 'unexpectedQualityCount': 0,
            'offGridCount': 0, 'duplicateCount': 0, 'invalidValueCount': 0,
            'missingUtc': [], 'reasons': [], 'firstExpectedUtc': stamp(start),
            'firstValidUtc': stamp(start), 'lastExpectedUtc': stamp(end-3600),
            'lastValidUtc': stamp(end-3600)}


class CalendarAggregationTests(unittest.TestCase):
    def summarize(self, day, rows):
        days = {}
        repair.merge_document(document(rows), days)
        return repair.daily_summary(day, days.get(day, {}))

    def test_partial_chunk_endpoint_cannot_overwrite_a_full_day(self):
        day = '2026-08-10'
        rows = complete_rows(day)
        days = {}
        repair.merge_document(document(rows), days)
        repair.merge_document(document(rows[:1]), days)
        result = repair.daily_summary(day, days[day])
        self.assertTrue(result['complete'])
        self.assertEqual(result['samples'], 240)
        self.assertEqual(result['maximumFt'], 3.39)

    def test_merge_chunk_order_is_irrelevant(self):
        day = '2026-08-10'
        rows = complete_rows(day)
        days = {}
        repair.merge_document(document(rows[:1]), days)
        repair.merge_document(document(rows), days)
        self.assertEqual(repair.daily_summary(day, days[day])['maximumFt'], 3.39)

    def test_one_midnight_sample_is_incomplete(self):
        result = self.summarize('2026-08-10', complete_rows('2026-08-10')[:1])
        self.assertFalse(result['complete'])
        self.assertIn('incomplete-calendar-day', result['reasons'])

    def test_dst_days_have_230_and_250_six_minute_samples(self):
        for day, count, hours in [('2026-03-08', 230, 23), ('2026-11-01', 250, 25)]:
            result = self.summarize(day, complete_rows(day))
            self.assertTrue(result['complete'])
            self.assertEqual(result['expectedSamples'], count)
            self.assertEqual(result['durationHours'], hours)

    def test_calendar_midnight_is_assigned_only_to_the_next_day(self):
        rows = complete_rows('2026-08-10')
        rows += complete_rows('2026-08-11')[:1]
        rows[-1]['value'] = '9.99'
        result = self.summarize('2026-08-10', rows)
        self.assertEqual(result['maximumFt'], 3.39)
        self.assertEqual(result['samples'], 240)

    def test_missing_and_nodata_observations_reject_correction(self):
        day = '2026-08-10'
        for nodata in [None, '-999999']:
            rows = complete_rows(day)
            if nodata is None:
                del rows[120]
            else:
                rows[120]['value'] = nodata
            self.assertFalse(self.summarize(day, rows)['complete'])

    def test_conflicting_duplicates_and_unrecognized_quality_are_rejected(self):
        day = '2026-08-10'
        rows = complete_rows(day)
        rows.append(dict(rows[0], value='8'))
        result = self.summarize(day, rows)
        self.assertFalse(result['complete'])
        self.assertIn('conflicting-observations', result['reasons'])
        rows = complete_rows(day)
        rows[1]['qualifiers'] = ['Eqp']
        self.assertFalse(self.summarize(day, rows)['complete'])

    def test_units_and_datum_must_be_explicit(self):
        data = document(complete_rows('2026-08-10'))
        data['value']['timeSeries'][0]['variable']['unit']['unitCode'] = 'm'
        with self.assertRaises(ValueError):
            repair.merge_document(data, {})

    def test_one_ungraded_observation_is_not_hidden_by_other_approved_values(self):
        rows = complete_rows('2026-08-10')
        rows[100]['qualifiers'] = []
        result = self.summarize('2026-08-10', rows)
        self.assertFalse(result['complete'])
        self.assertEqual(result['ungradedSamples'], 1)


class RepairTests(unittest.TestCase):
    def test_only_complete_primary_rows_change_and_crests_are_protected(self):
        source = fixture()
        summaries = {day: {'complete': True, 'maximumFt': 3.39, 'date': day,
                          'samples': 240, 'expectedSamples': 240, 'qualifiers': ['P']}
                     for day in ['2025-08-10', '2025-08-11', '2026-08-10']}
        # The real workflow requests summaries only for existing U rows.
        result, report = repair.repair(source, {'2026-08-10': summaries['2026-08-10']}, 'now')
        self.assertEqual(result['dailyPeakCompact'], [
            ['2025-08-10', 100, 'N'], ['2025-08-11', 573, 'C'], ['2026-08-10', 339, 'U']])
        self.assertEqual(source['dailyPeakCompact'][-1][1], -156)
        self.assertEqual(len(report['changes']), 1)
        self.assertEqual(result['tideModel'], source['tideModel'])
        self.assertEqual(result['thresholds'], source['thresholds'])

    def test_incomplete_days_remain_unchanged_and_unresolved(self):
        source = fixture()
        result, report = repair.repair(source, {
            '2026-08-10': {'date': '2026-08-10', 'complete': False, 'maximumFt': -1.56,
                          'samples': 1, 'expectedSamples': 240, 'qualifiers': ['P'],
                          'reasons': ['incomplete-calendar-day']}}, 'now')
        self.assertEqual(result['dailyPeakCompact'], source['dailyPeakCompact'])
        self.assertEqual(len(report['unresolved']), 1)

    def test_aggregates_use_the_same_canonical_rows_as_the_app(self):
        source = fixture()
        source['dailyPeakCompact'] += [['2026-08-11', 325, 'U'], ['2026-08-12', 425, 'U']]
        derived = repair.derive_statistics(source)
        self.assertEqual(derived['archive']['classificationCounts'],
                         {'none': 2, 'minor': 1, 'moderate': 1, 'major': 1})
        self.assertEqual(derived['annualCounts'][-1],
                         {'year': 2026, 'minor': 2, 'moderate': 1, 'major': 0, 'days': 3})
        self.assertEqual(derived['monthlyAudit'][-1]['minor'], 2)
        self.assertEqual(derived['topEvents'][0]['source'], 'official-usgs-storm-tide-crest')
        self.assertEqual(derived['topEvents'][0]['heightMllwFt'], 8.48)
        self.assertEqual(derived['returnIntervals']['sampleYears'], 2)
        self.assertTrue(all(item['navd88Ft'] is not None for item in derived['returnIntervals']['levels']))

    def test_unchanged_water_year_maxima_preserve_published_fit_exactly(self):
        source = fixture()
        source['dailyPeakCompact'].append(['2026-08-11', 425, 'U'])
        result, report = repair.repair(source, {
            '2026-08-10': {'date': '2026-08-10', 'complete': True, 'maximumFt': 3.39,
                          'samples': 240, 'expectedSamples': 240, 'qualifiers': ['P']},
            '2026-08-11': {'date': '2026-08-11', 'complete': True, 'maximumFt': 4.25,
                          'samples': 240, 'expectedSamples': 240, 'qualifiers': ['P']}},
            'audit-now', 'source-then')
        self.assertEqual(result['returnIntervals'], source['returnIntervals'])
        self.assertFalse(report['publishedReturnIntervalsRefitted'])
        self.assertEqual(result['provenance']['archiveRepair']['sourceRetrievedAt'], 'source-then')

    def test_complete_noaa_fallback_uses_existing_bias_and_preserves_other_sources(self):
        source = fixture()
        source['provenance']['noaaBiasCorrectionFt'] = .066
        result, report = repair.repair(source, {
            '2026-08-10': {'date': '2026-08-10', 'complete': False, 'maximumFt': 1.0,
                          'samples': 1, 'expectedSamples': 240, 'qualifiers': ['P']}},
            'now', noaa_fallback={'2026-08-10': fallback_fixture('2026-08-10')})
        self.assertEqual(result['dailyPeakCompact'][:2], source['dailyPeakCompact'][:2])
        self.assertEqual(result['dailyPeakCompact'][-1], ['2026-08-10', 339, 'N'])
        self.assertEqual(report['noaaFallbackDates'], ['2026-08-10'])

    def test_both_nonqualifying_sources_can_be_explicitly_omitted_as_unknown(self):
        source = fixture()
        source['provenance']['noaaBiasCorrectionFt'] = .066
        # Add another water-year observation so excluding the only 2026 day
        # does not make this tiny synthetic Gumbel fixture degenerate.
        source['dailyPeakCompact'].append(['2026-08-11', 300, 'N'])
        summary = {'date': '2026-08-10', 'complete': False, 'samples': 1,
                   'expectedSamples': 240, 'maximumFt': -1.56, 'qualifiers': ['P']}
        result, report = repair.repair(source, {'2026-08-10': summary}, 'now',
            noaa_fallback={'2026-08-10': {'complete': False, 'reasons': ['flagged']}},
            exclude_unresolved=True)
        self.assertNotIn('2026-08-10', [row[0] for row in result['dailyPeakCompact']])
        self.assertEqual(len(report['exclusions']), 1)
        self.assertEqual(result['archive']['days'], 3)

    def test_noaa_contract_rejects_flags_missing_edges_and_wrong_bias(self):
        for key, value in [('nonzeroFlagCount', 1), ('duplicateCount', 1),
                           ('firstValidUtc', None), ('biasFt', .45)]:
            record = fallback_fixture('2026-08-10')
            record[key] = value
            with self.assertRaises(ValueError):
                repair.noaa_fallback_peak('2026-08-10', record, .066)

    def test_proxy_cannot_erase_a_higher_trusted_local_observation(self):
        source = fixture()
        source['provenance']['noaaBiasCorrectionFt'] = .066
        source['dailyPeakCompact'].append(['2026-08-11', 300, 'N'])
        summary = {'date': '2026-08-10', 'complete': False, 'samples': 120,
                   'expectedSamples': 240, 'maximumFt': 4.0, 'trustedMaximumFt': 3.5,
                   'qualifiers': ['P', 'e']}
        result, report = repair.repair(source, {'2026-08-10': summary}, 'now',
            noaa_fallback={'2026-08-10': fallback_fixture('2026-08-10', 3.39)},
            exclude_unresolved=True)
        self.assertNotIn('2026-08-10', [row[0] for row in result['dailyPeakCompact']])
        self.assertEqual(report['contradictoryProxyDates'], ['2026-08-10'])
        self.assertEqual(report['exclusions'][0]['trustedLowerBoundFt'], 3.5)

    def test_lower_bound_accepts_provisional_and_estimated_values_but_not_unknown_flags(self):
        rows = complete_rows('2026-08-10')
        rows[120]['qualifiers'] = ['P', 'e']
        rows[121]['qualifiers'] = ['A', 'R']
        rows[121]['value'] = '9.99'
        days = {}
        repair.merge_document(document(rows), days)
        summary = repair.daily_summary('2026-08-10', days['2026-08-10'])
        self.assertFalse(summary['complete'])
        self.assertEqual(summary['maximumFt'], 9.99)
        self.assertEqual(summary['trustedMaximumFt'], 3.39)

    def test_omitting_an_entire_water_year_requires_a_fit_input_change(self):
        source = fixture()
        source['provenance']['noaaBiasCorrectionFt'] = .066
        source['dailyPeakCompact'].insert(0, ['2024-08-10', 250, 'U'])
        summaries = {
            '2024-08-10': {'date': '2024-08-10', 'complete': False, 'samples': 1,
                          'expectedSamples': 240, 'maximumFt': 2.5, 'qualifiers': ['P']},
            '2026-08-10': {'date': '2026-08-10', 'complete': True, 'samples': 240,
                          'expectedSamples': 240, 'maximumFt': 3.39, 'qualifiers': ['P']}}
        result, report = repair.repair(source, summaries, 'now',
            noaa_fallback={'2024-08-10': {'complete': False, 'reasons': ['flagged']}},
            exclude_unresolved=True)
        self.assertIn({'waterYear': 2024, 'oldMaximumFt': 2.5, 'maximumFt': None},
                      report['waterYearMaximumChanges'])
        self.assertTrue(report['publishedReturnIntervalsRefitted'])
        self.assertEqual(result['returnIntervals']['sampleYears'], 2)


if __name__ == '__main__':
    unittest.main()
