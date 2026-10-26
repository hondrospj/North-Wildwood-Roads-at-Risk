import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';
import {DEFAULT_ROAD_NAMES, selectDefaultRoadProfile} from '../default-road.mjs';
import {municipalRoads} from '../municipal-roads.mjs';

const root = new URL('../', import.meta.url);
const [source, boundary, html] = await Promise.all([
  readFile(new URL('north_wildwood_road_centerlines.geojson', root), 'utf8').then(JSON.parse),
  readFile(new URL('north_wildwood_boundary.geojson', root), 'utf8').then(JSON.parse),
  readFile(new URL('index.html', root), 'utf8')
]);
const {roads, contains} = municipalRoads(source, boundary);
const road = selectDefaultRoadProfile(roads, {contains});
const coordinateKey = point => point.map(value => value.toFixed(9)).join(',');
const edgeKey = (a,b) => [coordinateKey(a), coordinateKey(b)].sort().join('|');

function appFunction(name){
  const start = html.indexOf(`    function ${name}(`);
  const asyncStart = html.indexOf(`    async function ${name}(`);
  const at = start >= 0 ? start : asyncStart;
  assert.ok(at >= 0, `${name} remains an application function`);
  return html.slice(at, html.indexOf('\n    }', at) + 6);
}

test('the first profile follows all of connected West/East 16th Avenue inside town', () => {
  assert.ok(road);
  const selected = roads.features.filter(feature => DEFAULT_ROAD_NAMES.includes(feature.properties.PRIMENAME));
  assert.deepEqual([...new Set(selected.map(feature => feature.properties.PRIMENAME))].sort(), [...DEFAULT_ROAD_NAMES].sort());
  const sourceEdges = new Set(selected.flatMap(feature => feature.geometry.coordinates.slice(1)
    .map((point,index) => edgeKey(feature.geometry.coordinates[index], point))));
  const tracedEdges = new Set(road.coordinates.slice(1).map((point,index) => edgeKey(road.coordinates[index], point)));
  assert.deepEqual(tracedEdges, sourceEdges, 'traces the avenue itself without a shortcut or another road');
  assert.equal(road.waypoints.length, 2);
  assert.ok(road.lengthM > 1500 && road.lengthM < 1600, 'covers the approximately 5,033-foot cross-town avenue');
  assert.ok(road.waypoints[0][0] < road.waypoints[1][0], 'controls are ordered west to east');
  for(let index=1; index<road.coordinates.length; index++){
    const a = road.coordinates[index-1], b = road.coordinates[index];
    // Check the interiors as well as endpoints, including the long western leg.
    for(let step=0; step<=20; step++){
      const t=step/20;
      assert.ok(contains([a[0]+(b[0]-a[0])*t, a[1]+(b[1]-a[1])*t]), 'no segment leaves the municipality');
    }
  }
});

test('a missing or disconnected avenue falls back instead of taking unrelated streets', () => {
  assert.equal(selectDefaultRoadProfile({type:'FeatureCollection',features:[]}, {contains}), null);
  const disconnected = {...roads, features:roads.features.filter(feature => feature.properties.OBJECTID !== 311623)};
  assert.equal(selectDefaultRoadProfile(disconnected, {contains}), null);
});

function drawingHarness(defaultRoadProfile, {desktop=true}={}){
  const markers=[], lines=[], profiles=[], notices=[], fits=[];
  const mapRect = {left:0,top:0,right:1440,bottom:900,width:1440,height:900};
  const overlayRects = {
    '.rightStack':{left:806,top:220,right:1426,bottom:886,width:620,height:666},
    '.mapControl':{left:806,top:14,right:1426,bottom:206,width:620,height:192},
    '.titleBar':{left:100,top:20,right:530,bottom:104,width:430,height:84}
  };
  const context = {
    state:{defaultRoadProfile, nextEndpointNumber:1, comparisonSections:[]},
    SECTION_COLORS:['#22d3ee'],
    map:{
      getContainer:()=>({getBoundingClientRect:()=>mapRect}),
      fitBounds:(bounds,options)=>fits.push({bounds,options})
    },
    document:{querySelector:selector=>({getBoundingClientRect:()=>overlayRects[selector]})},
    desktopWorkspaceTabs:()=>desktop,
    clearSection(){}, renderSavedLines(){}, markerIcon(){return {};},
    setText(id,text){notices.push({id,text});},
    runProfile(points){profiles.push(points);},
    polylineVertexDistances(points){
      const distances=[0];
      for(let index=1; index<points.length; index++) distances.push(distances.at(-1)+Math.hypot(points[index].lat-points[index-1].lat,points[index].lng-points[index-1].lng));
      return distances;
    },
    L:{
      latLng:(lat,lng) => ({lat,lng}),
      latLngBounds:points=>({points}),
      marker(point,options){
        const marker={point,options,addTo(){return this;},on(){return this;},getLatLng(){return this.point;}};
        markers.push(marker);
        return marker;
      },
      polyline(points,options){
        const line={points,options,addTo(){return this;},on(){return this;}};
        lines.push(line);
        return line;
      }
    }
  };
  vm.createContext(context);
  vm.runInContext(`${appFunction('fitSectionBounds')}\n${appFunction('drawSection')}\n${appFunction('defaultSection')}`,context);
  context.defaultSection();
  return {context,markers,lines,profiles,notices,fits};
}

test('the real default draw call creates two draggable controls and profiles the full trace', () => {
  const {context,markers,lines,profiles,notices}=drawingHarness(road);
  assert.equal(markers.length,2, 'source shape vertices do not become extra endpoint controls');
  assert.ok(markers.every(marker => marker.options.draggable === true));
  assert.equal(context.state.activeRoadSnapped,true);
  assert.equal(lines[0].points.length,road.coordinates.length);
  assert.deepEqual(JSON.parse(JSON.stringify(profiles[0])),road.coordinates.map(([lng,lat])=>({lat,lng})));
  assert.equal(context.state.activeVertexDistances.length,2);
  assert.ok(context.state.activeVertexDistances[1]>0);
  assert.equal(notices.at(-1).text, '');
});

test('unavailable road data leaves an explicitly labeled editable freehand sample', () => {
  const {context,markers,lines,notices}=drawingHarness(null);
  assert.equal(context.state.activeRoadSnapped,false);
  assert.equal(markers.length,2);
  assert.ok(markers.every(marker => marker.options.draggable === true));
  assert.equal(lines[0].points.length,2);
  assert.match(notices.at(-1).text,/editable freehand sample/);
});

test('the initial road is fit beside the desktop rail and below the brand', () => {
  const {fits}=drawingHarness(road);
  assert.equal(fits.length,1, 'fits once rather than locking the map to the profile');
  assert.equal(fits[0].bounds.points.length,road.coordinates.length);
  assert.deepEqual(Array.from(fits[0].options.paddingTopLeft),[28,132]);
  assert.deepEqual(Array.from(fits[0].options.paddingBottomRight),[662,28]);
  assert.equal(fits[0].options.animate,false);
});

test('mobile fits use the full map area without reserving the separate tool stack', () => {
  const {fits}=drawingHarness(road,{desktop:false});
  assert.deepEqual(Array.from(fits[0].options.paddingTopLeft),[28,28]);
  assert.deepEqual(Array.from(fits[0].options.paddingBottomRight),[28,28]);
});

function startupHarness(){
  let resolveTerrain,resolveRoads,currentLine=null,defaults=0;
  const profiled=[];
  const context={
    state:{drawMode:false,pendingPoints:[]},
    loadApp:()=>new Promise(resolve=>{resolveTerrain=resolve;}),
    loadRoadCenterlines:()=>new Promise(resolve=>{resolveRoads=resolve;}),
    currentLineLatLngs:()=>currentLine,
    runProfile:points=>profiled.push(points),
    defaultSection:()=>{defaults++;}
  };
  vm.createContext(context);
  vm.runInContext(appFunction('initializeProfiles'),context);
  const ready=context.initializeProfiles();
  return {context,ready,profiled,setLine:points=>{currentLine=points;},finish:()=>{resolveTerrain();resolveRoads();},defaults:()=>defaults};
}

test('finishing a user line during downloads cannot be overwritten by initial default', async () => {
  const startup=startupHarness();
  const userLine=[{lat:39.001,lng:-74.805},{lat:39.002,lng:-74.806}];
  startup.setLine(userLine);
  startup.finish();
  await startup.ready;
  assert.equal(startup.defaults(),0);
  assert.equal(startup.profiled[0],userLine);
});

test('startup preserves an unfinished drawing and defaults only an idle empty view', async () => {
  const drawing=startupHarness();
  drawing.context.state.drawMode=true;
  drawing.context.state.pendingPoints=[{lat:39.001,lng:-74.805}];
  drawing.finish();
  await drawing.ready;
  assert.equal(drawing.defaults(),0);
  const idle=startupHarness();
  assert.equal(idle.defaults(),0,'waits for both downloads');
  idle.finish();
  await idle.ready;
  assert.equal(idle.defaults(),1);
});
