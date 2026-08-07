# North Wildwood Roads at Risk

Static GitHub Pages app for drawing road and cross-section profiles through a municipal 5-foot North Wildwood DEM.

The interface and features match the Seaside Heights Roads at Risk platform: threshold presets, NAVD88/MLLW conversion, terrain and hillshade views, saved multi-line cross sections, flood-history and future-frequency charts, and CSV/Shapefile exports.

Municipal constants:

- Observations: USGS 01411360, Great Channel at Stone Harbor
- PETSS / NOAA station: 8535581, Cape May Harbor
- NAVD88 thresholds: 3.25 ft minor, 4.25 ft moderate, 5.25 ft major
- MLLW thresholds: 6.00 ft minor, 7.00 ft moderate, 8.00 ft major
- MLLW = NAVD88 + 2.75 ft

Terrain source: USGS 3DEP Bare Earth DEM Dynamic ImageServer, clipped to the North Wildwood boundary and resampled to 1.524 m / 5 ft pixels.
