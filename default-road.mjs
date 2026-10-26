import { buildRoadNetwork } from './road-centerlines.mjs?v=topology-2';

export const DEFAULT_ROAD_NAMES = Object.freeze(['West 16th Avenue', 'East 16th Avenue']);

// Use only the connected, named avenue for the first profile. Restricting the
// network prevents a gap in that avenue from silently detouring onto other roads.
export function selectDefaultRoadProfile(collection, {contains=null}={}){
  const features = (collection?.features || [])
    .filter(feature => DEFAULT_ROAD_NAMES.includes(feature.properties?.PRIMENAME));
  const coordinates = features.flatMap(feature => feature.geometry?.type === 'LineString'
    ? feature.geometry.coordinates : feature.geometry?.type === 'MultiLineString'
      ? feature.geometry.coordinates.flat() : []);
  if(coordinates.length < 2) return null;
  const west = coordinates.reduce((a,b) => b[0] < a[0] ? b : a);
  const east = coordinates.reduce((a,b) => b[0] > a[0] ? b : a);
  const network = buildRoadNetwork({type:'FeatureCollection', features}, {contains});
  const route = network.route([west,east], .25);
  if(!route || route.coordinates.length < 2 || route.lengthM <= 0) return null;
  if(contains && route.coordinates.some(point => !contains(point))) return null;
  return {name:'West / East 16th Avenue', ...route};
}
