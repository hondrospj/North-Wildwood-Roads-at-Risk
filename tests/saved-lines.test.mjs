import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import vm from 'node:vm';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const storageKey = 'north-wildwood-roads-at-risk-saved-lines-v1';
const plain = value => JSON.parse(JSON.stringify(value));
const path = [
  {lat:39.003,lng:-74.809},
  {lat:39.001,lng:-74.806},
  {lat:38.996,lng:-74.798}
];
const legacyLine = {
  id:'legacy-road', name:'Original road', thresholdFt:3.25,
  a:path[0], b:path.at(-1), createdAt:'2026-10-01T12:00:00.000Z'
};

function appFunction(name){
  const start = html.indexOf(`    function ${name}(`);
  assert.ok(start >= 0, `${name} is present`);
  return html.slice(start, html.indexOf('\n    }', start) + 6);
}

function harness({lines=[legacyLine], storedValue=JSON.stringify(lines)}={}){
  let value=storedValue, writeError=null, writes=0, clock=1793000000000;
  const input={value:'New road'}, statuses=[], renders=[], warnings=[], activations=[];
  class FixedDate extends Date {
    constructor(...args){super(...(args.length ? args : [clock]));}
    static now(){return clock++;}
  }
  const state={
    savedLines:plain(lines), activeSavedLineId:lines[0]?.id || null,
    thresholdFt:4.25, activeRoadSnapped:true, activeVertexDistances:[0,1234],
    activeVertexLabels:[1,2], comparisonSections:[],
    line:{getLatLngs:()=>path},
    markers:[path[0],path.at(-1)].map(point=>({getLatLng:()=>point}))
  };
  const context={
    state, SAVED_LINES_KEY:storageKey, Date:FixedDate,
    Math:Object.assign(Object.create(Math),{random:()=>.25}),
    localStorage:{
      getItem(key){assert.equal(key,storageKey);return value;},
      setItem(key,next){
        assert.equal(key,storageKey);
        writes++;
        if(writeError) throw writeError;
        value=next;
      }
    },
    $:id=>id==='lineNameInput' ? input : null,
    setExportStatus:text=>statuses.push(text),
    renderSavedLines:()=>renders.push({lines:plain(state.savedLines),activeId:state.activeSavedLineId}),
    console:{warn:(...args)=>warnings.push(args)},
    setDrawMode(){}, toDisplayDatum:value=>value,
    setThreshold:value=>{state.thresholdFt=value;},
    drawSection:(...args)=>activations.push(args),
    L:{latLng:(lat,lng)=>({lat,lng})}
  };
  vm.createContext(context);
  vm.runInContext([
    'currentLineLatLngs','sanitizeLineName','loadSavedLines','persistSavedLines',
    'saveCurrentLine','deleteSavedLine','useSavedLine','profileNumberLabel','exportLineRecords'
  ].map(appFunction).join('\n'),context);
  return {
    context,state,input,statuses,renders,warnings,activations,
    failWrites:error=>{writeError=error;},
    stored:()=>value, writes:()=>writes
  };
}

function storageError(name){
  return Object.assign(new Error('Injected browser storage failure'),{name});
}

test('a full-storage Save preserves saved data, active state, typed name and rendered list', () => {
  const h=harness();
  const previousLines=h.state.savedLines, previousStorage=h.stored();
  h.input.value='Keep this typed name';
  h.failWrites(storageError('QuotaExceededError'));
  assert.doesNotThrow(()=>h.context.saveCurrentLine());
  assert.equal(h.state.savedLines,previousLines);
  assert.equal(h.state.activeSavedLineId,'legacy-road');
  assert.equal(h.input.value,'Keep this typed name');
  assert.equal(h.stored(),previousStorage);
  assert.equal(h.renders.length,0);
  assert.match(h.statuses.at(-1),/Could not save.*full or unavailable.*unchanged.*Export/);

  h.failWrites(null);
  h.context.saveCurrentLine();
  assert.equal(h.state.savedLines.length,2);
  assert.equal(h.state.savedLines[0].name,'Keep this typed name');
  assert.equal(h.input.value,'');
  assert.equal(h.renders.length,1);
  assert.equal(h.state.activeSavedLineId,h.state.savedLines[0].id);
});

test('a failed Delete keeps the active saved line and becomes effective only after retry succeeds', () => {
  const h=harness();
  const previousLines=h.state.savedLines, previousStorage=h.stored();
  h.failWrites(storageError('SecurityError'));
  assert.doesNotThrow(()=>h.context.deleteSavedLine('legacy-road'));
  assert.equal(h.state.savedLines,previousLines);
  assert.equal(h.state.activeSavedLineId,'legacy-road');
  assert.equal(h.stored(),previousStorage);
  assert.equal(h.renders.length,0);
  assert.equal(h.context.exportLineRecords().find(record=>record.id==='legacy-road').name,'Original road');
  assert.match(h.statuses.at(-1),/Could not delete.*unchanged/);

  h.failWrites(null);
  h.context.deleteSavedLine('legacy-road');
  assert.equal(h.state.savedLines.length,0);
  assert.equal(h.state.activeSavedLineId,null);
  assert.deepEqual(JSON.parse(h.stored()),[]);
  assert.equal(h.renders.length,1);
  assert.equal(h.context.currentLineLatLngs().length,path.length,'deleting a saved entry leaves the displayed geometry available');
});

test('blocked storage also preserves a new Save without changing the UI', () => {
  const h=harness({lines:[]});
  h.failWrites(storageError('SecurityError'));
  h.context.saveCurrentLine();
  assert.equal(h.state.savedLines.length,0);
  assert.equal(h.state.activeSavedLineId,null);
  assert.equal(h.input.value,'New road');
  assert.equal(h.renders.length,0);
  assert.deepEqual(JSON.parse(h.stored()),[]);
  assert.match(h.statuses.at(-1),/Could not save/);
});

test('sixteen saves retain every profile, including the oldest, across a reload', () => {
  const h=harness({lines:[]});
  for(let index=1;index<=16;index++){
    h.input.value=`Road ${index}`;
    h.context.saveCurrentLine();
  }
  assert.equal(h.state.savedLines.length,16);
  assert.equal(h.state.savedLines.at(-1).name,'Road 1');
  assert.equal(new Set(h.state.savedLines.map(line=>line.id)).size,16);
  const reloaded=harness({lines:[],storedValue:h.stored()});
  reloaded.context.loadSavedLines();
  assert.equal(reloaded.state.savedLines.length,16);
  assert.deepEqual(plain(reloaded.state.savedLines.map(line=>line.name)),plain(h.state.savedLines.map(line=>line.name)));
});

test('a quota failure after thirteen saves does not evict any earlier profile', () => {
  const h=harness({lines:[]});
  for(let index=1;index<=13;index++){
    h.input.value=`Road ${index}`;
    h.context.saveCurrentLine();
  }
  const previousLines=h.state.savedLines, previousStorage=h.stored(), previousActive=h.state.activeSavedLineId;
  h.input.value='Road 14';
  h.failWrites(storageError('QuotaExceededError'));
  h.context.saveCurrentLine();
  assert.equal(h.state.savedLines,previousLines);
  assert.equal(h.state.savedLines.length,13);
  assert.equal(h.state.savedLines.at(-1).name,'Road 1');
  assert.equal(h.state.activeSavedLineId,previousActive);
  assert.equal(h.input.value,'Road 14');
  assert.equal(h.stored(),previousStorage);
  assert.equal(h.renders.length,13,'failed write does not change the existing rendered list');
});

test('saving retains traced geometry and legacy saved lines remain activatable and exportable', () => {
  const h=harness();
  h.context.loadSavedLines();
  h.context.useSavedLine('legacy-road');
  const activation=h.activations.at(-1);
  assert.equal(activation[3],'legacy-road');
  assert.deepEqual(plain(activation[5].path),[legacyLine.a,legacyLine.b]);
  h.context.saveCurrentLine();
  const saved=h.state.savedLines[0];
  assert.equal(saved.roadSnapped,true);
  assert.deepEqual(plain(saved.points),path);
  assert.deepEqual(plain(saved.controlPoints),[path[0],path.at(-1)]);
  assert.deepEqual(plain(saved.vertexDistances),[0,1234]);
  assert.deepEqual(JSON.parse(h.stored()).find(line=>line.id==='legacy-road'),legacyLine);
  const exports=h.context.exportLineRecords();
  assert.equal(exports.length,2,'active saved line is still exported only once');
  assert.deepEqual(plain(exports.find(line=>line.id===saved.id).points),path);
  assert.deepEqual(plain(exports.find(line=>line.id==='legacy-road').points),[legacyLine.a,legacyLine.b]);
});
