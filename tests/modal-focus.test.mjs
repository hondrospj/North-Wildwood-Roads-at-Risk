import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
function source(name){
  const match = html.match(new RegExp(`^    function ${name}\\([\\s\\S]*?^    }`, 'm'));
  assert.ok(match, `source function ${name}`);
  return match[0];
}

// Exercise the actual dialog handlers with a deterministic DOM/event fixture.
// Browser QA separately checks native rendering, inert support and focus order.
function fixture(){
  const elements = new Map();
  const listeners = new Map();
  const windowListeners = new Map();
  const activations = [];
  let desktop = false;
  const document = {
    activeElement:null,
    getElementById:id => elements.get(id) || null,
    querySelector:() => null,
    querySelectorAll:selector => selector === '[data-help-key]' ? [elements.get('helpTrigger')] : [],
    addEventListener(type, fn, capture=false){
      const entries = listeners.get(type) || [];
      entries.push({fn, capture:!!capture}); listeners.set(type, entries);
    },
    removeEventListener(type, fn){ listeners.set(type, (listeners.get(type) || []).filter(x => x.fn !== fn)); }
  };
  function dispatch(type, event){
    event.target ||= document.activeElement;
    event.preventDefault = () => { event.defaultPrevented = true; };
    event.stopImmediatePropagation = () => { event.stopped = true; };
    for(const {fn} of [...(listeners.get(type) || [])].sort((a,b) => Number(b.capture)-Number(a.capture))){
      fn(event);
      if(event.stopped) break;
    }
    return event;
  }
  class Element {
    constructor(id, parent=null, tagName='BUTTON'){
      this.id=id; this.parentElement=parent; this.tagName=tagName; this.children=[];
      this.hidden=false; this.inert=false; this.disabled=false; this.isConnected=true;
      this.tabIndex=tagName === 'BUTTON' ? 0 : -1; this.dataset={}; this.handlers=new Map();
      this.style={display:'block',visibility:'visible'}; this.attributes=new Map();
      this.classes=new Set();
      this.classList={add:name=>this.classes.add(name),remove:name=>this.classes.delete(name)};
      parent?.children.push(this); elements.set(id,this);
    }
    contains(element){ return element === this || this.children.some(child => child.contains(element)); }
    closest(selector){
      for(let element=this; element; element=element.parentElement){
        if(selector === '[hidden], [inert]' && (element.hidden || element.inert)) return element;
        if(selector === '.toolPane' && element.classes.has('toolPane')) return element;
      }
      return null;
    }
    querySelector(selector){ return selector === '[role="dialog"]' ? this.children.find(x => x.dialog) || null : null; }
    querySelectorAll(){
      const all=[];
      const walk=element => { for(const child of element.children){ all.push(child); walk(child); } };
      walk(this);
      return all.filter(x => x.tagName === 'BUTTON' || x.tagName === 'A' || x.tabIndex >= 0);
    }
    getClientRects(){
      for(let element=this; element; element=element.parentElement){
        if(element.hidden || element.style.display === 'none') return [];
      }
      return [{}];
    }
    setAttribute(name,value){ this.attributes.set(name,value); }
    focus(){
      if(this.disabled || this.closest('[hidden], [inert]')) return;
      document.activeElement=this; dispatch('focusin',{target:this});
    }
    addEventListener(type, fn){ this.handlers.set(type, [...(this.handlers.get(type) || []), fn]); }
    click(){ if(!this.disabled) for(const fn of this.handlers.get('click') || []) fn({target:this}); }
  }
  const body=new Element('body',null,'BODY'); document.body=body; document.activeElement=body;
  const map=new Element('map',body,'DIV'); map.tabIndex=0;
  const shell=new Element('shell',body,'DIV');
  const pane=new Element('profilePane',shell,'SECTION'); pane.classes.add('toolPane');
  const trigger=new Element('helpTrigger',pane); trigger.dataset.helpKey='map';
  const launch=new Element('roadRiskTourBtn',shell);
  const help=new Element('roadRiskHelp',body,'DIV'); help.hidden=true;
  const helpCard=new Element('helpCard',help,'SECTION'); helpCard.dialog=true;
  new Element('roadRiskHelpClose',helpCard);
  new Element('roadRiskHelpTitle',helpCard,'H2');
  new Element('roadRiskHelpBody',helpCard,'DIV');
  new Element('roadRiskHelpTour',helpCard);
  const tour=new Element('roadRiskTour',body,'DIV'); tour.hidden=true;
  const tourCard=new Element('roadRiskTourCard',tour,'SECTION'); tourCard.dialog=true;
  for(const id of ['roadRiskTourClose','roadRiskTourBack','roadRiskTourNext']) new Element(id,tourCard);
  for(const id of ['roadRiskTourProgress','roadRiskTourTitle','roadRiskTourBody']) new Element(id,tourCard,'DIV');
  const window = {
    setTimeout(){},
    addEventListener(type, fn){ windowListeners.set(type,[...(windowListeners.get(type) || []),fn]); },
    removeEventListener(type, fn){ windowListeners.set(type,(windowListeners.get(type) || []).filter(x=>x!==fn)); }
  };
  const names=['activeRoadRiskDialog','roadRiskDialogTabStops','syncRoadRiskModalBackground','restoreRoadRiskDialogFocus','closeRoadRiskHelp','openRoadRiskHelp','renderRoadRiskTourStep','setRoadRiskTourOpen','installRoadRiskHelpAndTour'];
  const api=new Function('document','window','$','getComputedStyle','setText','desktopWorkspaceTabs','setMobileToolActive',`
    const ROADRISK_PANE_HELP={map:{title:'Map',body:'Map help',tourStep:1}};
    const ROADRISK_TOUR_STEPS=[0,1,2].map(i=>({title:'Step '+i,body:'Step body',target:'.target'}));
    let roadRiskHelpKey='map',roadRiskDialogReturnFocus=null,roadRiskTourIndex=0;
    let roadRiskTourReturnFocus=null,roadRiskTourPositionHandler=null,roadRiskModalInertState=null;
    const clamp=(n,min,max)=>Math.max(min,Math.min(max,n));
    const togglePaneExpansion=()=>{},positionRoadRiskTour=()=>{},visibleRoadRiskTourTarget=()=>null;
    ${names.map(source).join('\n')}
    installRoadRiskHelpAndTour();
    return {openRoadRiskHelp,closeRoadRiskHelp,setRoadRiskTourOpen,roadRiskDialogTabStops,activeRoadRiskDialog};
  `)(document,window,id=>elements.get(id) || null,element=>element.style,
    (id,text)=>{ elements.get(id).textContent=text; },()=>desktop,id=>activations.push(id));
  return { ...api,elements,document,map,shell,trigger,launch,help,helpCard,tour,tourCard,activations,windowListeners,
    element:(id,parent,tag)=>new Element(id,parent,tag),
    key:(key,shiftKey=false)=>dispatch('keydown',{key,shiftKey}),
    dispatch, desktop:()=>{desktop=true;},
    addBackgroundShortcut:fn=>document.addEventListener('keydown',fn)
  };
}

test('Help traps both Tab directions, closes with Escape and restores original inert state/focus',()=>{
  const f=fixture(); f.map.inert=true;
  f.openRoadRiskHelp('map',f.trigger);
  assert.equal(f.document.activeElement.id,'roadRiskHelpClose');
  assert.equal(f.shell.inert,true);
  assert.equal(f.key('Tab').defaultPrevented,true);
  assert.equal(f.document.activeElement.id,'roadRiskHelpTour');
  f.key('Tab'); assert.equal(f.document.activeElement.id,'roadRiskHelpClose');
  f.key('Tab',true); assert.equal(f.document.activeElement.id,'roadRiskHelpTour');
  f.key('Escape');
  assert.equal(f.help.hidden,true);
  assert.equal(f.document.activeElement,f.trigger);
  assert.equal(f.shell.inert,false);
  assert.equal(f.map.inert,true);
});

test('Tour excludes disabled Back, wraps at either boundary and returns to its launcher',()=>{
  const f=fixture(); f.launch.focus(); f.setRoadRiskTourOpen(true);
  assert.equal(f.document.activeElement.id,'roadRiskTourNext');
  assert.equal(f.elements.get('roadRiskTourBack').disabled,true);
  f.key('Tab'); assert.equal(f.document.activeElement.id,'roadRiskTourClose');
  f.key('Tab',true); assert.equal(f.document.activeElement.id,'roadRiskTourNext');
  f.key('Escape');
  assert.equal(f.document.activeElement,f.launch);
  assert.equal(f.map.inert,false); assert.equal(f.shell.inert,false);
});

test('Tour arrow navigation still changes steps and keeps focus off newly disabled Back',()=>{
  const f=fixture(); f.launch.focus(); f.setRoadRiskTourOpen(true);
  const right=f.key('ArrowRight');
  assert.equal(right.defaultPrevented,true);
  assert.equal(f.elements.get('roadRiskTourProgress').textContent,'2 of 3');
  f.elements.get('roadRiskTourBack').focus();
  f.key('ArrowLeft');
  assert.equal(f.elements.get('roadRiskTourProgress').textContent,'1 of 3');
  assert.equal(f.document.activeElement.id,'roadRiskTourNext');
});

test('Help-to-Tour opens the requested step and returns to the original help invoker',()=>{
  const f=fixture(); f.desktop(); f.openRoadRiskHelp('map',f.trigger);
  f.elements.get('roadRiskHelpTour').focus(); f.elements.get('roadRiskHelpTour').click();
  assert.equal(f.help.hidden,true); assert.equal(f.tour.hidden,false);
  assert.equal(f.elements.get('roadRiskTourProgress').textContent,'2 of 3');
  assert.equal(f.document.activeElement.id,'roadRiskTourNext');
  f.elements.get('roadRiskTourClose').click();
  assert.equal(f.document.activeElement,f.trigger);
  assert.equal(f.activations.at(-1),'profilePane');
});

test('modal keyboard isolation blocks background shortcuts and restores them after close',()=>{
  const f=fixture(); let calls=0; f.addBackgroundShortcut(()=>calls++);
  f.openRoadRiskHelp('map',f.trigger);
  for(const key of ['+','-','ArrowUp','ArrowDown','Enter',' ']) assert.equal(f.key(key).stopped,true);
  assert.equal(calls,0);
  f.closeRoadRiskHelp(); f.key('+'); assert.equal(calls,1);
});

test('unexpected outside focus is redirected to the visible dialog',()=>{
  const f=fixture(); f.launch.focus(); f.setRoadRiskTourOpen(true);
  const outside=f.element('outside',f.document.body,'BUTTON'); outside.focus();
  assert.equal(f.document.activeElement.id,'roadRiskTourClose');
  assert.equal(f.tourCard.contains(f.document.activeElement),true);
});

test('hidden/negative-tabindex controls are excluded and an empty tab sequence focuses the card',()=>{
  const f=fixture(); f.openRoadRiskHelp('map',f.trigger);
  const hidden=f.element('hidden',f.helpCard); hidden.hidden=true;
  const removed=f.element('notTabbable',f.helpCard); removed.tabIndex=-1;
  assert.deepEqual(f.roadRiskDialogTabStops(f.helpCard).map(x=>x.id),['roadRiskHelpClose','roadRiskHelpTour']);
  f.elements.get('roadRiskHelpClose').disabled=true;
  f.elements.get('roadRiskHelpTour').disabled=true;
  f.key('Tab'); assert.equal(f.document.activeElement,f.helpCard);
  f.key('Escape'); assert.equal(f.document.activeElement,f.trigger);
});

test('reopening the visible Tour preserves its original return target and one position handler',()=>{
  const f=fixture(); f.launch.focus(); f.setRoadRiskTourOpen(true);
  f.setRoadRiskTourOpen(true,2);
  assert.equal(f.windowListeners.get('resize').length,1);
  f.elements.get('roadRiskTourNext').click();
  assert.equal(f.tour.hidden,true); assert.equal(f.document.activeElement,f.launch);
  assert.equal(f.windowListeners.get('resize').length,0);
});
