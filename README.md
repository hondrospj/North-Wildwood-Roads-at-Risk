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
