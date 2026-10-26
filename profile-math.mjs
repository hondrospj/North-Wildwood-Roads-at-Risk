const STAGE_NAMES = ["minor", "moderate", "major"];
const DATUM_TOLERANCE_FT = 1e-8;

/**
 * Return MLLW minus NAVD88, in feet, from this town's configuration.
 * A supplied numeric datum offset must agree with supplied threshold pairs.
 * Without an explicit offset, all three paired flood stages are required.
 */
export function configuredMllwOffset(floodStats) {
  if (!floodStats || typeof floodStats !== "object") {
    throw new TypeError("Flood statistics are required to resolve the MLLW datum offset.");
  }
  const datum = floodStats.datum;
  const hasExplicit = datum && typeof datum === "object" &&
    Object.hasOwn(datum, "mllwOffsetFromNavd88Ft");
  const explicit = hasExplicit ? datum.mllwOffsetFromNavd88Ft : null;
  if (hasExplicit && !Number.isFinite(explicit)) {
    throw new TypeError("The configured MLLW datum offset must be a finite number in feet.");
  }

  const navd88 = floodStats.thresholds?.navd88;
  const mllw = floodStats.thresholds?.mllw;
  let derived = null;
  if (navd88 !== undefined || mllw !== undefined || !hasExplicit) {
    const offsets = STAGE_NAMES.map(name => {
      if (!Number.isFinite(navd88?.[name]) || !Number.isFinite(mllw?.[name])) {
        throw new TypeError("Complete numeric NAVD88 and MLLW flood-stage pairs are required.");
      }
      return mllw[name] - navd88[name];
    });
    derived = offsets[0];
    if (offsets.some(offset => !Number.isFinite(offset) ||
      Math.abs(offset - derived) > DATUM_TOLERANCE_FT)) {
      throw new RangeError("NAVD88 and MLLW flood-stage pairs specify inconsistent datum offsets.");
    }
    if (hasExplicit && Math.abs(explicit - derived) > DATUM_TOLERANCE_FT) {
      throw new RangeError("The configured MLLW datum offset disagrees with the flood-stage pairs.");
    }
  }
  return hasExplicit ? explicit : derived;
}

function crossingPoint(start, end, fraction, thresholdFt) {
  if (fraction <= 0) return { ...start };
  if (fraction >= 1) return { ...end };
  const interpolate = key => Number.isFinite(start[key]) && Number.isFinite(end[key])
    ? start[key] + fraction * (end[key] - start[key]) : null;
  return {
    distanceFt: interpolate("distanceFt"),
    lat: interpolate("lat"),
    lng: interpolate("lng"),
    elevationFt: thresholdFt
  };
}

/**
 * Analyze a piecewise-linear, distance-ordered elevation profile in feet.
 * Only original consecutive pairs with two finite elevations are covered.
 * Unknown terrain breaks exposed runs; it is never connected across a gap.
 * exposedSegments includes interpolated water-stage crossings for both map
 * and chart rendering. Input points and their order are left unchanged.
 */
export function analyzeProfile(profile, thresholdFt) {
  if (!Array.isArray(profile)) throw new TypeError("A profile array is required.");
  if (!Number.isFinite(thresholdFt)) throw new TypeError("The water threshold must be finite.");

  let minElevationFt = null;
  for (let i = 0; i < profile.length; i++) {
    const point = profile[i];
    if (!point || !Number.isFinite(point.distanceFt) ||
      (i > 0 && point.distanceFt < profile[i - 1].distanceFt)) {
      throw new RangeError("Profile distances must be finite and nondecreasing.");
    }
    if (Number.isFinite(point.elevationFt)) {
      minElevationFt = minElevationFt === null
        ? point.elevationFt : Math.min(minElevationFt, point.elevationFt);
    }
  }

  const totalLengthFt = profile.length > 1
    ? profile.at(-1).distanceFt - profile[0].distanceFt : 0;
  let coveredLengthFt = 0;
  let exposedLengthFt = 0;
  let longestExposedLengthFt = 0;
  const exposedSegments = [];
  let activeSegment = null;
  let activeLengthFt = 0;

  for (let i = 1; i < profile.length; i++) {
    const start = profile[i - 1];
    const end = profile[i];
    const intervalLength = end.distanceFt - start.distanceFt;
    if (!Number.isFinite(start.elevationFt) || !Number.isFinite(end.elevationFt)) {
      activeSegment = null;
      activeLengthFt = 0;
      continue;
    }
    coveredLengthFt += intervalLength;
    if (intervalLength === 0) continue;

    const startExposed = start.elevationFt <= thresholdFt;
    const endExposed = end.elevationFt <= thresholdFt;
    if (!startExposed && !endExposed) {
      activeSegment = null;
      activeLengthFt = 0;
      continue;
    }
    let from = 0;
    let to = 1;
    if (startExposed !== endExposed) {
      const fraction = (thresholdFt - start.elevationFt) /
        (end.elevationFt - start.elevationFt);
      if (startExposed) to = fraction;
      else from = fraction;
    }
    const exposedIntervalLength = intervalLength * (to - from);
    if (exposedIntervalLength <= 0) {
      activeSegment = null;
      activeLengthFt = 0;
      continue;
    }
    const exposedStart = crossingPoint(start, end, from, thresholdFt);
    const exposedEnd = crossingPoint(start, end, to, thresholdFt);
    if (from !== 0 || !activeSegment ||
      activeSegment.at(-1).distanceFt !== exposedStart.distanceFt) {
      activeSegment = [exposedStart];
      exposedSegments.push(activeSegment);
      activeLengthFt = 0;
    }
    activeSegment.push(exposedEnd);
    activeLengthFt += exposedIntervalLength;
    exposedLengthFt += exposedIntervalLength;
    longestExposedLengthFt = Math.max(longestExposedLengthFt, activeLengthFt);
    if (to !== 1) {
      activeSegment = null;
      activeLengthFt = 0;
    }
  }

  return {
    minElevationFt,
    totalLengthFt,
    coveredLengthFt,
    unknownLengthFt: Math.max(0, totalLengthFt - coveredLengthFt),
    exposedLengthFt,
    longestExposedLengthFt,
    exposedSegments
  };
}
