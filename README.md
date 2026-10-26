# North Wildwood Roads at Risk

Static GitHub Pages app for drawing road and cross-section profiles through the North Wildwood municipal DEM.

The interface follows the North Wildwood Roads at Risk reference: threshold presets, NAVD88/MLLW conversion, terrain and hillshade views, saved multi-line cross sections, flood-history and future-frequency charts, and CSV/Shapefile exports.

Municipal constants:

- Observations: USGS 01411360, Stone Harbor
- PETSS / NOAA station: 8535581
- NAVD88 thresholds: 3.25 ft minor, 4.25 ft moderate, 5.25 ft major
- MLLW thresholds: 6 ft minor, 7 ft moderate, 8 ft major
- MLLW = NAVD88 + 2.75 ft

Terrain source: USGS 3DEP Bare Earth DEM Dynamic ImageServer, clipped to the North Wildwood boundary at 5-foot resolution.

## Drawing and map controls

Draw, Clear, and Finish Line are in the top Map box. Aerial and Streets are the available basemaps; Aerial is the default. Low, Intermediate, and High scenario controls are below Observed History. Map zoom reaches 21; overzoom does not improve the source imagery or elevation resolution.

The initial profile follows the connected West / East 16th Avenue centerline across central North Wildwood, from its western road end to its eastern road end (about 5,033 feet). It follows the complete municipal road geometry rather than a straight latitude line. Its two numbered endpoints remain draggable, and Draw adds further profiles normally. Reset line restores this same avenue. Startup waits for terrain and road loading, preserves a profile or unfinished drawing started during loading, and identifies a freehand sample visibly if the avenue is unavailable.

Snap to roads uses NJOGIS NG911 centerlines from `north_wildwood_road_centerlines.geojson`. The roads are clipped to this application's existing municipal boundary for display, snapping, and routing. A missing boundary or road dataset disables road snapping; users can explicitly choose freehand mode. These profiles are not safe-driving directions or surveyed bridge-deck elevations.

The snapping checkbox stays available while drawing. Turning it off retains the draft control points and joins them directly. Turning it on snaps a connectable draft to roads; an incompatible draft stays freehand with an explanation. Completed profiles and the existing browser storage key are preserved. Saved and exported road profiles retain their traced geometry.

Saved profiles have no fixed count limit. If browser storage is full or unavailable, Save and Delete show an error and preserve the previous saved list. Help and tutorial dialogs keep keyboard focus inside while open and return it to the initiating control when closed.

Road data source: NJ Office of GIS NG911 Road Centerlines, retrieved September 4, 2026 from https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Tran_road/FeatureServer/0 . Queries use the existing municipal boundary envelope in WGS84, preserve OBJECTID and source elevation-level fields, paginate in OBJECTID order, and validate the returned feature count. Runtime clipping prevents routes from leaving and re-entering the municipality.

Run deterministic default-profile checks with `node --test tests/default-road.test.mjs`.

## Calculation behavior

The town's paired stage presets define the configured display offset (currently MLLW = NAVD88 + 2.75 ft). The application validates those pairs and any explicit offset, instead of using another town's fallback. This makes its own presets equivalent; it is not an independent revalidation of the physical local datum or tidal epoch.

Profile length includes the full traced geometry. Elevation coverage includes only consecutive sample intervals with two finite DEM values. Unknown spans break flooded runs and are reported separately. Flooded length uses linear threshold crossings shared by the summary, map, and chart. When coverage is incomplete, the starred percentage is explicitly the share of covered length. Line Shapefiles retain the original traced route; elevation points retain missing samples.

Archive counts and average flood-day spacing use the unadjusted recorded daily peaks. This spacing is not a storm-event return period. Historical bars show missing years as gaps and partial years in gold, with days available in the tooltip. Future curves retain the existing 2026 baseline, trend adjustment, and fixed sea-level pathways. The displayed 90% band is conditional binomial count variability; it does not include DEM error, sea-level pathway uncertainty, calibration error, or correlated consecutive flood days. Prepared distributions are cached once per dataset/baseline/trend.

The datum epoch and sea-level pathway provenance still require follow-up before interpreting outputs as calibrated risk estimates.

Run all deterministic checks with `node --test tests/*.test.mjs`.

## Archive audit and repair — October 26, 2026

The [public repair audit](data-quality/archive-repair-20261026.json) records the changed rows, quarantined original rows, trusted local lower bounds, source URLs and SHA-256 checksums, and aggregate impacts. All 6,668 originally stored USGS-source days were checked against 20 official instantaneous-value snapshots covering October 2007 through August 2026. A qualifying local day contains every expected six-minute reading: 240 normally, 230 at the spring daylight-saving transition, and 250 at the autumn transition. Observations are merged across download chunks before daily aggregation; an isolated midnight endpoint cannot replace a complete day's maximum. Dates use `America/New_York`, with each day spanning local midnight through, but excluding, the next midnight.

Of those days, 6,236 had qualifying complete USGS coverage; 263 stored maxima were corrected to current official values. This includes August 10, 2026 (−1.56 to +3.39 ft NAVD88), June 26 and 29, 2026, and January 23, 2016 (6.69 to 6.22 ft). The 2016 Stone Harbor value is independently listed in the borough's [official flood mitigation presentation](https://stoneharbornj.org/wp-content/uploads/2022/04/Flood-Mitigation-and-Storm-Sewer-Presentation.pdf). A different town's tide-gauge record is not substituted for this station's record. Most other corrections are current USGS revisions of 0.01 ft; the audit does not assume every discrepancy had the same upstream cause.

For the 432 nonqualifying USGS days, verified NOAA Lewes hourly data were checked against complete 23/24/25-hour local-day grids. A proxy uses the existing `max(hourly NAVD88) + 0.066 ft` calibration only when its canonical hundredth-foot value is at least as high as every trusted finite local USGS observation. This permits 94 explicitly identified NOAA proxy fills. Another 338 days are omitted from the qualified archive and retained in the audit as unknown: 323 proxies contradicted a higher trusted local reading, and 15 NOAA days also failed quality/coverage checks. No hybrid estimate is invented. Original NOAA-filled rows and all official crest overrides are preserved.

Trusted local observations require approved (`A`) or provisional (`P`) agency status; documented estimated values (`A/P` plus `e`) are included and identified. Unknown flags, ungraded values, conflicting readings and nodata are excluded from trusted lower bounds. NOAA inferred/limit flags and unverified or incomplete hourly days cannot establish a proxy. Current incomplete coverage does not prove the original retrieval was incomplete; records can subsequently be revised or removed.

The qualified archive now has 29,995 daily maxima (82.12 effective observation years). Classification counts, cumulative annual counts, ranked events, and the archive sample count are recomputed from the exact canonical hundredth-foot rows used by the app. This also resolves legacy aggregate differences caused by rounding data before publishing it. Four water-year maxima changed, so the existing Gumbel table was refitted from canonical values with its existing water-year method; this is not a new validation of extreme-event return periods. NOAA bias, trend coefficients/source metadata, scenario coefficients, `drawsPerYear`, and `predictionRows` remain unchanged. Original NOAA-filled history and pre-2007 data are outside this audit's certification scope.

The reusable tools use Python's standard library. Raw snapshots, the original archive backup, and the full per-day report stay outside the runtime application. To replay from the original release, prepare the baseline and run the two source audits before applying the repair:

```bash
git show e6c3dee340d3580a8bbeb3562ff092085fdbde77:flood_stats.json > ../original-flood_stats.json
python3 scripts/repair-tide-archive.py --baseline ../original-flood_stats.json --cache-dir ../tide-archive-audit-20261026/raw --fetch --report ../tide-archive-audit-20261026/differences.json
python3 scripts/audit-noaa-fallback.py --audit-dir ../tide-archive-audit-20261026
python3 scripts/repair-tide-archive.py --baseline ../original-flood_stats.json --cache-dir ../tide-archive-audit-20261026/raw --noaa-fallback ../tide-archive-audit-20261026/noaa-fallback.json --exclude-unresolved --report ../tide-archive-audit-20261026/full-differences.json --apply
python3 -m unittest discover -s tests -p 'test_*.py'
```

Without `--fetch`, the USGS auditor verifies and reuses cached raw checksums. NOAA responses are also cached and accompanied by their checksums. New official revisions may change a future replay; source retrieval time is recorded separately from audit execution time. Published daily tidal-high statistic `00021` is deliberately not used as a calendar-day maximum; daily maximum statistic `00001` is unavailable for this station/parameter.
