import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {performance} from 'node:perf_hooks';
import {configuredMllwOffset, analyzeProfile} from '../profile-math.mjs';
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
const floodStats = JSON.parse(fs.readFileSync(new URL('../flood_stats.json', import.meta.url), 'utf8'));
function source(name){
  const match = html.match(new RegExp(`^    function ${name}\\([\\s\\S]*?^    }`, 'm'));
  assert.ok(match, `source function ${name}`);
  return match[0];
}
const scenarios = html.match(/    const PROJECTION_SCENARIOS = \{[\s\S]*?^    };/m)[0];
function calculations(){
  const state={floodStats,datum:'navd88',thresholdFt:3.25,projectionScenario:'intermediate',floodBucketCache:new Map()};
  const text={};
  const names=['clamp','fmtLen','activeScenario','activeDatum','datumLabel','datumOffsetFt','toDisplayDatum','fromDisplayDatum','fmtDatumFt','activeDatumThresholds','projectionBaseYear','scenarioDeltaFt','datumTrendFtPerYear','decimalYear','lowerBound','dateParts','doyIndex','snapStageBucket','archiveData','dailyArchive','rawPeakDistribution','presentRebasedArchive','presentPeakDistribution','empiricalExceedance','archiveYearRange','binomialRange','projectionForThreshold','buildBucketStats','countDailyExceedances','recurrenceText','updateStats','riskSegments'];
  const api = new Function('state','setText','configuredMllwOffset','analyzeProfile', `${scenarios}\nconst MONTH_STARTS=[0,31,59,90,120,151,181,212,243,273,304,334];\n${names.map(source).join('\n')}\nreturn {${names.join(',')}};`)(state,(id,value)=>text[id]=value,configuredMllwOffset,analyzeProfile);
  return {...api,state,text};
}
test('switching datums and clicking any preset preserves the configured physical stage',()=>{
  const c=calculations();c.state.datum='mllw';
  for(const level of ['minor','moderate','major']){
    const navd=floodStats.thresholds.navd88[level];
    assert.equal(c.toDisplayDatum(navd),floodStats.thresholds.mllw[level]);
    assert.equal(c.fromDisplayDatum(c.activeDatumThresholds()[level]),navd);
  }
  assert.ok(Number.isNaN(c.fromDisplayDatum('')));
});
test('summary, map, and interpolated geometry agree for an isolated low sample',()=>{
  const c=calculations();const p=[4,3,4].map((e,i)=>({elevationFt:e,distanceFt:i*5,lat:0,lng:i}));
  c.updateStats(p);assert.equal(c.text.exposedPct,'25%');
  const segments=c.riskSegments(p);assert.equal(segments.length,1);assert.equal(segments[0].length,3);
  assert.equal(segments[0][0][1],.75);assert.equal(segments[0].at(-1)[1],1.25);
});
test('unknown intervals retain route length and never become flooded geometry',()=>{
  const c=calculations();c.updateStats([2,null,2].map((e,i)=>({elevationFt:e,distanceFt:i*50,lat:0,lng:i})));
  assert.equal(c.text.profileLen,'100 ft');assert.equal(c.text.exposedPct,'-');assert.match(c.text.profileCoverage,/100 ft has no elevation data/);
});
test('recorded counts equal the annual bars; missing years and partial coverage are explicit',()=>{
  const c=calculations();const b=c.buildBucketStats(3.3);
  assert.equal(c.countDailyExceedances(3.3),1401);assert.equal(b.total,1401);
  assert.equal(b.annualRows.reduce((s,r)=>s+(r.count||0),0),b.total);
  assert.equal(b.annualRows.find(r=>r.year===1930).count,null);
  assert.deepEqual(b.annualRows.find(r=>r.year===2026),{year:2026,count:27,coverageDays:243,calendarDays:365,complete:false});
  assert.equal(b.annualRows.find(r=>r.year===1920).coverageDays,5);
});
test('caching reuses the prepared distribution without changing the existing projection model',()=>{
  const c=calculations();const cache=c.archiveData();const distribution=c.presentPeakDistribution();
  const t=performance.now();const b=c.buildBucketStats(3.3);const elapsedMs=performance.now()-t;
  assert.equal(c.archiveData(),cache);assert.equal(c.presentPeakDistribution(),distribution);
  assert.ok(Math.abs(b.projection2100.mean-364.55713275746336)<1e-9);
  c.state.projectionScenario='high';c.buildBucketStats(4.3);
  assert.equal(c.presentPeakDistribution(),distribution);
  console.log(JSON.stringify({coldBucketMs:elapsedMs.toFixed(2),archiveDays:distribution.length}));
});
test('leading unknown samples and original shapefile endpoints are preserved',()=>{
  const names=['interpolatePoint','polylineVertexDistances','buildProfilePath','shapefileGeoJson'];
  const api=new Function('sampleDem','haversineFeet',`${names.map(source).join('\n')}\nreturn {buildProfilePath,shapefileGeoJson};`)((lat,lng)=>lng<5?null:4,(a,b)=>Math.abs(b.lng-a.lng));
  const points=[{lat:0,lng:0},{lat:0,lng:10}];const profile=api.buildProfilePath(points);
  assert.equal(profile[0].elevationFt,null);assert.equal(profile[0].distanceFt,0);
  const out=api.shapefileGeoJson([{id:'a',name:'a',points,thresholdFt:3.25,createdAt:''}]);
  assert.deepEqual(out.features[0].geometry.coordinates,[[0,0],[10,0]]);assert.equal(out.features[0].properties.length_ft,10);
  assert.equal(out.features[1].properties.elev_ft,null);
});
test('an active saved section exports once and uses its current water stage',()=>{
  const points=[{lat:0,lng:0},{lat:0,lng:10}];
  const state={comparisonSections:[],activeSavedLineId:'saved',activeVertexLabels:[1,2],thresholdFt:4.25,savedLines:[{id:'saved',name:'My road',points,thresholdFt:3.25}]};
  const fn=new Function('state','currentLineLatLngs','profileNumberLabel','L',`${source('exportLineRecords')}\nreturn exportLineRecords;`)(state,()=>points,labels=>labels.join('-'),{latLng:(lat,lng)=>({lat,lng})});
  const records=fn();assert.equal(records.length,1);assert.equal(records[0].id,'saved');assert.equal(records[0].thresholdFt,4.25);
});
