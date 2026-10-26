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

Road data source: NJ Office of GIS NG911 Road Centerlines, retrieved September 4, 2026 from https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Tran_road/FeatureServer/0 . Queries use the existing municipal boundary envelope in WGS84, preserve OBJECTID and source elevation-level fields, paginate in OBJECTID order, and validate the returned feature count. Runtime clipping prevents routes from leaving and re-entering the municipality.

Run deterministic default-profile checks with `node --test tests/default-road.test.mjs`.

## Calculation behavior

The town's paired stage presets define the configured display offset (currently MLLW = NAVD88 + 2.75 ft). The application validates those pairs and any explicit offset, instead of using another town's fallback. This makes its own presets equivalent; it is not an independent revalidation of the physical local datum or tidal epoch.

Profile length includes the full traced geometry. Elevation coverage includes only consecutive sample intervals with two finite DEM values. Unknown spans break flooded runs and are reported separately. Flooded length uses linear threshold crossings shared by the summary, map, and chart. When coverage is incomplete, the starred percentage is explicitly the share of covered length. Line Shapefiles retain the original traced route; elevation points retain missing samples.

Archive counts and average flood-day spacing use the unadjusted recorded daily peaks. This spacing is not a storm-event return period. Historical bars show missing years as gaps and partial years in gold, with days available in the tooltip. Future curves retain the existing 2026 baseline, trend adjustment, and fixed sea-level pathways. The displayed 90% band is conditional binomial count variability; it does not include DEM error, sea-level pathway uncertainty, calibration error, or correlated consecutive flood days. Prepared distributions are cached once per dataset/baseline/trend.

The supplied archive is not rebuilt in this change. A separate October 26, 2026 official-source comparison identified stored daily-peak discrepancies (including August 10, 2026), and the datum epoch and sea-level pathway provenance require follow-up before interpreting outputs as calibrated risk estimates.

Run all deterministic checks with `node --test tests/*.test.mjs`.
