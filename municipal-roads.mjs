// Clip WGS84 road lines to the same polygon used for the city's red outline.
// Splitting at every boundary crossing prevents routes from leaving and
// re-entering the city, even when both original road endpoints are inside.
export function municipalRoads(collection, boundary){
  const polygons=[];
  function collect(value){
    if(value?.type==='FeatureCollection') value.features.forEach(collect);
    else if(value?.type==='Feature') collect(value.geometry);
    else if(value?.type==='Polygon') polygons.push(value.coordinates);
    else if(value?.type==='MultiPolygon') polygons.push(...value.coordinates);
  }
  collect(boundary);
  if(!polygons.length) throw new Error('Municipal boundary is missing');
  const epsilon=1e-10;
  // Allow sub-millimetre rounding when snapping to an already clipped road.
  // Clipping itself retains the stricter geometric tolerance.
  const boundaryTolerance=1e-9;
  const same=(a,b)=>Math.abs(a[0]-b[0])<epsilon && Math.abs(a[1]-b[1])<epsilon;
  const cross=(a,b)=>a[0]*b[1]-a[1]*b[0];
  const subtract=(a,b)=>[a[0]-b[0],a[1]-b[1]];
  function ringEdges(ring){
    return ring.map((a,i)=>[a,ring[(i+1)%ring.length]]).filter(([a,b])=>!same(a,b));
  }
  const polygonEdges=polygons.map(rings=>rings.map(ringEdges));
  const allEdges=polygonEdges.flat(2);
  // Latitude buckets restrict exact geometry checks to nearby boundary edges.
  // Keep every edge spanning a bucket; holes and distant polygon parts still
  // use the same intersection and point-in-ring calculations below.
  function edgeIndex(edges){
    if(!edges.length) return ()=>edges;
    let minY=Infinity,maxY=-Infinity;
    for(const [a,b] of edges){
      minY=Math.min(minY,a[1],b[1]);
      maxY=Math.max(maxY,a[1],b[1]);
    }
    const count=Math.min(256,Math.max(1,Math.ceil(Math.sqrt(edges.length))));
    const step=(maxY-minY)/count;
    if(!step) return ()=>edges;
    const bucket=y=>Math.max(0,Math.min(count-1,Math.floor((y-minY)/step)));
    const bins=Array.from({length:count},()=>[]);
    for(const edge of edges){
      const first=bucket(Math.min(edge[0][1],edge[1][1]));
      const last=bucket(Math.max(edge[0][1],edge[1][1]));
      for(let i=first;i<=last;i++) bins[i].push(edge);
    }
    return (low,high=low)=>{
      low-=boundaryTolerance;high+=boundaryTolerance;
      if(high<minY || low>maxY) return [];
      if(low<=minY && high>=maxY) return edges;
      const first=bucket(low),last=bucket(high);
      if(first===last) return bins[first];
      const candidates=new Set();
      for(let i=first;i<=last;i++) for(const edge of bins[i]) candidates.add(edge);
      return candidates;
    };
  }
  const ringIndexes=polygonEdges.map(rings=>rings.map(edgeIndex));
  const boundaryCandidates=edgeIndex(allEdges);
  function onEdge(p,a,b,tolerance){
    const ab=subtract(b,a),ap=subtract(p,a);
    return Math.abs(cross(ab,ap))<=tolerance*Math.hypot(...ab)
      && p[0]>=Math.min(a[0],b[0])-tolerance && p[0]<=Math.max(a[0],b[0])+tolerance
      && p[1]>=Math.min(a[1],b[1])-tolerance && p[1]<=Math.max(a[1],b[1])+tolerance;
  }
  function inRing(p,edges){
    let inside=false;
    for(const [a,b] of edges){
      if((a[1]>p[1])!==(b[1]>p[1]) && p[0]<(b[0]-a[0])*(p[1]-a[1])/(b[1]-a[1])+a[0]) inside=!inside;
    }
    return inside;
  }
  function contains(p,tolerance=boundaryTolerance){
    if(!Array.isArray(p) || !p.every(Number.isFinite)) return false;
    return ringIndexes.some(rings=>{
      const candidates=rings.map(query=>query(p[1]));
      if(candidates.some(edges=>{
        for(const [a,b] of edges) if(onEdge(p,a,b,tolerance)) return true;
        return false;
      })) return true;
      return inRing(p,candidates[0]) && !candidates.slice(1).some(edges=>inRing(p,edges));
    });
  }
  function cuts(a,b){
    const ab=subtract(b,a),lengthSquared=ab[0]**2+ab[1]**2;
    const ts=[0,1];
    for(const [c,d] of boundaryCandidates(Math.min(a[1],b[1]),Math.max(a[1],b[1]))){
      if(Math.max(a[0],b[0])+epsilon<Math.min(c[0],d[0]) || Math.min(a[0],b[0])-epsilon>Math.max(c[0],d[0])
        || Math.max(a[1],b[1])+epsilon<Math.min(c[1],d[1]) || Math.min(a[1],b[1])-epsilon>Math.max(c[1],d[1])) continue;
      const cd=subtract(d,c),ac=subtract(c,a),denom=cross(ab,cd);
      if(Math.abs(denom)>1e-20){
        const t=cross(ac,cd)/denom,u=cross(ac,ab)/denom;
        if(t>=0 && t<=1 && u>=-epsilon && u<=1+epsilon) ts.push(t);
      }else if(Math.abs(cross(ab,ac))<=epsilon*Math.sqrt(lengthSquared)){
        for(const p of [c,d]){
          const ap=subtract(p,a),t=(ap[0]*ab[0]+ap[1]*ab[1])/lengthSquared;
          if(t>0 && t<1) ts.push(t);
        }
      }
    }
    return ts.sort((x,y)=>x-y).filter((t,i,list)=>!i || t-list[i-1]>1e-12);
  }
  const features=[];
  for(const [featureIndex,feature] of collection.features.entries()){
    const g=feature.geometry;
    const parts=g?.type==='LineString'?[g.coordinates]:g?.type==='MultiLineString'?g.coordinates:[];
    for(const [partIndex,points] of parts.entries()){
      let piece=[],pieceIndex=0;
      function finish(){
        if(piece.length>=2){
          features.push({type:'Feature',id:`${featureIndex}:${partIndex}:${pieceIndex++}`,
            properties:{...feature.properties,
              CLIPPED_F:!same(piece[0],points[0]),CLIPPED_T:!same(piece.at(-1),points.at(-1))},
            geometry:{type:'LineString',coordinates:piece}});
        }
        piece=[];
      }
      for(let i=1;i<points.length;i++){
        const a=points[i-1],b=points[i];
        if(same(a,b)) continue;
        const at=t=>[a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t];
        const ts=cuts(a,b);
        for(let j=1;j<ts.length;j++){
          const start=at(ts[j-1]),end=at(ts[j]);
          if(!contains(at((ts[j-1]+ts[j])/2),epsilon)){finish();continue;}
          if(piece.length && !same(piece.at(-1),start)) finish();
          if(!piece.length) piece.push(start);
          if(!same(piece.at(-1),end)) piece.push(end);
        }
      }
      finish();
    }
  }
  return {roads:{type:'FeatureCollection',features},contains:p=>contains(p)};
}
