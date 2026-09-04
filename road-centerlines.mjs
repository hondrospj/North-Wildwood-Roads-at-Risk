// Geometry-only centerline tracing, not turn-by-turn or safe-driving routing.
// Coordinates are [longitude, latitude] in WGS84.
export function buildRoadNetwork(collection, {contains=null}={}){
  const first = collection.features?.find(f => ['LineString','MultiLineString'].includes(f.geometry?.type))?.geometry;
  const origin = first?.type === 'MultiLineString' ? first.coordinates[0]?.[0] : first?.coordinates[0];
  if(!origin) throw new Error('No road centerlines available');
  const xScale = 6371008.8 * Math.PI / 180 * Math.cos(origin[1] * Math.PI / 180);
  const yScale = 6371008.8 * Math.PI / 180;
  const project = p => [(p[0] - origin[0]) * xScale, (p[1] - origin[1]) * yScale];
  const unproject = p => [p[0] / xScale + origin[0], p[1] / yScale + origin[1]];
  const nodes = new Map();
  const edges = [];
  const distance = (a,b) => Math.hypot(a[0]-b[0], a[1]-b[1]);
  function addNode(id, coordinate){
    if(!nodes.has(id)) nodes.set(id, {coordinate:coordinate.slice(0,2), links:[]});
    return id;
  }
  for(const [featureIndex, feature] of collection.features.entries()){
    const geometry = feature.geometry;
    const parts = geometry?.type === 'LineString' ? [geometry.coordinates]
      : geometry?.type === 'MultiLineString' ? geometry.coordinates : [];
    for(const [partIndex, coordinates] of parts.entries()){
      if(coordinates.length < 2 || coordinates.some(p => !Number.isFinite(p[0]) || !Number.isFinite(p[1]))) continue;
      const ids = coordinates.map((p,i) => {
        // Connect only source endpoints, not arbitrary crossing/bridge vertices.
        const endpoint = i === 0 || i === coordinates.length-1;
        const level = i === 0 ? feature.properties?.ELEVTYP_F : feature.properties?.ELEVTYP_T;
        const clipped = i===0 ? feature.properties?.CLIPPED_F : feature.properties?.CLIPPED_T;
        const id = endpoint && clipped ? `clip:${featureIndex}:${partIndex}:${i}`
          : endpoint ? `${p[0].toFixed(7)},${p[1].toFixed(7)},${level ?? 0}`
          : `shape:${featureIndex}:${partIndex}:${i}`;
        return addNode(id, p);
      });
      for(let i=1; i<coordinates.length; i++){
        const a = project(coordinates[i-1]), b = project(coordinates[i]);
        const length = distance(a,b);
        const edge = {a,b,length,from:ids[i-1],to:ids[i],name:feature.properties?.PRIMENAME || 'Road'};
        // Repeated and very close vertices still connect consecutive source
        // nodes. Only zero-length geometry is excluded from snap projection.
        nodes.get(edge.from).links.push({id:edge.to,length});
        nodes.get(edge.to).links.push({id:edge.from,length});
        if(length > 0) edges.push(edge);
      }
    }
  }
  if(!edges.length) throw new Error('No usable road segments');

  function nearest(coordinate, maxDistanceM=25){
    if(contains && !contains(coordinate)) return null;
    const p = project(coordinate);
    let best = null;
    for(const edge of edges){
      const dx=edge.b[0]-edge.a[0], dy=edge.b[1]-edge.a[1];
      const t=Math.max(0,Math.min(1,((p[0]-edge.a[0])*dx+(p[1]-edge.a[1])*dy)/(edge.length**2)));
      const xy=[edge.a[0]+t*dx,edge.a[1]+t*dy];
      const d=distance(p,xy);
      if(d <= maxDistanceM && (!best || d < best.distanceM)) best={edge,t,coordinate:unproject(xy),distanceM:d};
    }
    return best;
  }

  function between(start,end){
    if(start.edge === end.edge) return [start.coordinate,end.coordinate];
    const costs=new Map(), previous=new Map(), queue=[];
    function push(id,cost){
      let i=queue.length;
      queue.push({id,cost});
      while(i){
        const parent=(i-1)>>1;
        if(queue[parent].cost <= cost) break;
        [queue[i],queue[parent]]=[queue[parent],queue[i]]; i=parent;
      }
    }
    function pop(){
      const first=queue[0], tail=queue.pop();
      if(queue.length){
        queue[0]=tail; let i=0;
        while(true){
          let child=i*2+1;
          if(child >= queue.length) break;
          if(child+1 < queue.length && queue[child+1].cost < queue[child].cost) child++;
          if(queue[i].cost <= queue[child].cost) break;
          [queue[i],queue[child]]=[queue[child],queue[i]]; i=child;
        }
      }
      return first;
    }
    for(const [id,cost] of [[start.edge.from,start.t*start.edge.length],[start.edge.to,(1-start.t)*start.edge.length]]){
      if(!costs.has(id) || cost < costs.get(id)){costs.set(id,cost); push(id,cost);}
    }
    const targets=new Map([[end.edge.from,end.t*end.edge.length],[end.edge.to,(1-end.t)*end.edge.length]]);
    let best=Infinity, finish=null;
    while(queue.length){
      const {id,cost}=pop();
      if(cost !== costs.get(id)) continue;
      if(cost > best) break;
      if(targets.has(id) && cost+targets.get(id) < best){best=cost+targets.get(id);finish=id;}
      for(const link of nodes.get(id).links){
        const next=cost+link.length;
        if(next < (costs.get(link.id) ?? Infinity)){
          costs.set(link.id,next); previous.set(link.id,id); push(link.id,next);
        }
      }
    }
    if(finish === null) return null;
    const middle=[];
    for(let id=finish; id !== undefined; id=previous.get(id)) middle.push(nodes.get(id).coordinate);
    return [start.coordinate,...middle.reverse(),end.coordinate];
  }

  function route(coordinates,maxDistanceM=25){
    const snaps=coordinates.map(p => nearest(p,maxDistanceM));
    if(snaps.some(p => !p)) return null;
    const path=[], waypointDistancesM=[], waypointIndices=[];
    let total=0;
    function append(p){
      if(path.length){
        const d=distance(project(path[path.length-1]),project(p));
        if(d < .001) return;
        total+=d;
      }
      path.push(p);
    }
    for(let i=0;i<snaps.length;i++){
      const part=i ? between(snaps[i-1],snaps[i]) : [snaps[i].coordinate];
      if(!part) return null;
      part.forEach(append);
      waypointDistancesM.push(total);
      waypointIndices.push(path.length-1);
    }
    return {coordinates:path,waypoints:snaps.map(p => p.coordinate),waypointDistancesM,waypointIndices,lengthM:total};
  }
  return {nearest,route,segmentCount:edges.length};
}
