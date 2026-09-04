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

Snap to roads uses NJOGIS NG911 centerlines from `north_wildwood_road_centerlines.geojson`. The roads are clipped to this application's existing municipal boundary for display, snapping, and routing. A missing boundary or road dataset disables road snapping; users can explicitly choose freehand mode. These profiles are not safe-driving directions or surveyed bridge-deck elevations.

The snapping checkbox stays available while drawing. Turning it off retains the draft control points and joins them directly. Turning it on snaps a connectable draft to roads; an incompatible draft stays freehand with an explanation. Completed profiles and the existing browser storage key are preserved. Saved and exported road profiles retain their traced geometry.

Road data source: NJ Office of GIS NG911 Road Centerlines, retrieved September 4, 2026 from https://services2.arcgis.com/XVOqAjTOJ5P6ngMu/arcgis/rest/services/Tran_road/FeatureServer/0 . Queries use the existing municipal boundary envelope in WGS84, preserve OBJECTID and source elevation-level fields, paginate in OBJECTID order, and validate the returned feature count. Runtime clipping prevents routes from leaving and re-entering the municipality.
