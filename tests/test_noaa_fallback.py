import datetime as dt
import unittest
import importlib.util
from pathlib import Path
_spec = importlib.util.spec_from_file_location('noaa_audit', Path(__file__).resolve().parents[1] / 'scripts/audit-noaa-fallback.py')
_module = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_module)
analyze, bounds = _module.analyze, _module.bounds


def fixture(date):
    start, end = bounds(date)
    rows = []
    instant = start
    while instant < end:
        rows.append({'t': instant.strftime('%Y-%m-%d %H:%M'), 'v': str(len(rows) / 10), 'f': '0,0'})
        instant += dt.timedelta(hours=1)
    return {'year': int(date[:4]), 'url': 'https://api.tidesandcurrents.noaa.gov/example',
            'cache': True, 'error': None, 'dates': [date], 'rows': rows}


class NoaaFallbackTest(unittest.TestCase):
    def test_spring_day_has_exactly_23_distinct_hourly_positions(self):
        days, _ = analyze(fixture('2026-03-08'))
        day = days['2026-03-08']
        self.assertTrue(day['complete'])
        self.assertEqual(day['validCount'], 23)
        self.assertEqual(day['expected'], 23)
        self.assertAlmostEqual(day['maxFt'], 2.2 + 0.066)

    def test_fall_day_preserves_both_repeated_local_hours_as_25_distinct_utc_positions(self):
        days, _ = analyze(fixture('2026-11-01'))
        day = days['2026-11-01']
        self.assertTrue(day['complete'])
        self.assertEqual(day['validCount'], 25)
        self.assertEqual(day['expected'], 25)
        self.assertEqual(day['duplicateCount'], 0)

    def test_normal_day_and_missing_first_or_last_hour(self):
        source = fixture('2026-01-01')
        days, _ = analyze(source)
        self.assertTrue(days['2026-01-01']['complete'])
        self.assertEqual(days['2026-01-01']['expected'], 24)
        for index in [0, -1]:
            source = fixture('2026-01-01')
            source['rows'].pop(index)
            days, _ = analyze(source)
            self.assertFalse(days['2026-01-01']['complete'])
            self.assertIsNone(days['2026-01-01']['maxFt'])
            self.assertEqual(len(days['2026-01-01']['missingUtc']), 1)

    def test_inferred_limit_unknown_flags_and_unverified_quality_are_rejected(self):
        for fields, reason in [({'f': '1,0'}, 'inferred-or-limit-flagged'),
                               ({'f': '0,1'}, 'inferred-or-limit-flagged'),
                               ({'f': 'unknown'}, 'unknown-quality-flags'),
                               ({'q': 'p'}, 'unverified-quality')]:
            source = fixture('2026-01-01')
            source['rows'][3].update(fields)
            days, _ = analyze(source)
            day = days['2026-01-01']
            self.assertFalse(day['complete'])
            self.assertIn(reason, day['reasons'])
            self.assertEqual(day['validCount'], 23)
            self.assertIsNone(day['maximumFt'])

    def test_duplicate_utc_hour_and_invalid_value_cannot_establish_completeness(self):
        source = fixture('2026-01-01')
        source['rows'].append(dict(source['rows'][3]))
        days, _ = analyze(source)
        self.assertFalse(days['2026-01-01']['complete'])
        self.assertIn('duplicate-timestamps', days['2026-01-01']['reasons'])
        source = fixture('2026-01-01')
        source['rows'][3]['v'] = ''
        days, _ = analyze(source)
        self.assertFalse(days['2026-01-01']['complete'])
        self.assertIn('invalid-values', days['2026-01-01']['reasons'])


if __name__ == '__main__':
    unittest.main()
