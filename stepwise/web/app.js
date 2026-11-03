'use strict';
const $ = id => document.getElementById(id);
const element = (tag, text, cls) => { const e=document.createElement(tag); if(text!==undefined)e.textContent=text; if(cls)e.className=cls; return e; };
let data=null, selected=null, view='graph', highlightChain=false, scale=1, tx=24, ty=24, positions=new Map(), bounds={w:1,h:1};
const defaults={theme:'system',density:'comfortable',direction:'horizontal',font:14,panel:340,showSize:true};
let prefs={...defaults};try{prefs={...defaults,...JSON.parse(localStorage.getItem('stepwise.preferences.v1')||'{}')};}catch{}
function applyPrefs(){
 document.documentElement.dataset.theme=['light','dark'].includes(prefs.theme)?prefs.theme:'system';
 document.documentElement.dataset.density=prefs.density==='compact'?'compact':'comfortable';
 document.documentElement.style.setProperty('--font',Math.max(12,Math.min(18,Number(prefs.font)||14))+'px');
 document.documentElement.style.setProperty('--panel',Math.max(260,Math.min(520,Number(prefs.panel)||340))+'px');
 for(const key of ['theme','density','direction','font','panel'])$(key).value=prefs[key];
 $('show-size').checked=prefs.showSize;
 try{localStorage.setItem('stepwise.preferences.v1',JSON.stringify(prefs));}catch{}
 if(data)render();
}
function error(msg){$('error').textContent=msg;$('error').hidden=false;setTimeout(()=>$('error').hidden=true,7000);}
function related(id,up){const by=new Map(data.nodes.map(n=>[n.id,n])), seen=new Set();function visit(k){for(const next of (up?by.get(k).deps:by.get(k).unblocks))if(!seen.has(next)){seen.add(next);visit(next);}}visit(id);return seen;}
function visible(n){const q=$('search').value.toLowerCase(),f=$('filter').value,a=$('area').value;return (!q||[n.id,n.title,n.area,n.description].some(s=>s.toLowerCase().includes(q)))&&(!a||n.area===a)&&(f==='all'||(f==='inconsistent'?n.inconsistent:n.kind===f));}
function transform(){$('world').style.transform=`translate(${tx}px,${ty}px) scale(${scale})`;}
function fit(){const v=$('viewport');scale=Math.min(1.2,Math.max(.12,Math.min((v.clientWidth-40)/bounds.w,(v.clientHeight-40)/bounds.h)));tx=20;ty=20;transform();}
function choose(id){selected=id;render();}
function render(){
 $('title').textContent=data.title;document.title=data.title+' · Stepwise';
 const areas=[...new Set(data.nodes.map(n=>n.area))].sort(),current=$('area').value;
 $('area').replaceChildren(new Option('All areas',''),...areas.map(a=>new Option(a||'Uncategorized',a)));$('area').value=current;
 const counts={done:0,in_progress:0,ready:0,waiting:0,blocked:0};data.nodes.forEach(n=>counts[n.kind]++);
 $('summary').replaceChildren(...Object.entries(counts).map(([k,v])=>{const e=element('div',undefined,'metric');e.append(element('b',v),element('span',k.replaceAll('_',' ')));return e;}));
 const conflict=data.nodes.filter(n=>n.inconsistent).length;if(conflict){const e=element('div',undefined,'metric conflict');e.append(element('b',conflict),element('span','Prerequisite conflicts'));$('summary').append(e);}
 const ancestors=selected?related(selected,true):new Set(),descendants=selected?related(selected,false):new Set(),chain=new Set(data.longest_chain);
 const focus=n=>(!selected||n.id===selected||ancestors.has(n.id)||descendants.has(n.id))&&(!highlightChain||chain.has(n.id));
 const buckets=new Map();positions=new Map();for(const n of data.nodes){const row=buckets.get(n.level)||0;buckets.set(n.level,row+1);positions.set(n.id,prefs.direction==='vertical'?{x:row*248,y:n.level*145}:{x:n.level*270,y:row*130});}
 bounds={w:Math.max(220,...[...positions.values()].map(p=>p.x+220)),h:Math.max(108,...[...positions.values()].map(p=>p.y+108))};
 $('nodes').replaceChildren();$('edges').replaceChildren();$('order').replaceChildren();
 const svgNS='http://www.w3.org/2000/svg',defs=document.createElementNS(svgNS,'defs'),marker=document.createElementNS(svgNS,'marker');marker.id='arrow';marker.setAttribute('viewBox','0 0 10 10');marker.setAttribute('refX','9');marker.setAttribute('refY','5');marker.setAttribute('markerWidth','7');marker.setAttribute('markerHeight','7');marker.setAttribute('orient','auto-start-reverse');const triangle=document.createElementNS(svgNS,'polygon');triangle.setAttribute('points','0,0 10,5 0,10');triangle.setAttribute('fill','currentColor');marker.append(triangle);defs.append(marker);$('edges').append(defs);
 for(const n of data.nodes){
  const p=positions.get(n.id),b=element('button',undefined,`node ${n.kind}${selected===n.id?' selected':''}${!visible(n)||!focus(n)?' dim':''}`);b.style.left=p.x+'px';b.style.top=p.y+'px';b.setAttribute('aria-label',`${n.id}: ${n.title}, ${n.kind}`);b.setAttribute('aria-pressed',String(selected===n.id));
  b.append(element('strong',`${n.order.toString().padStart(2,'0')} / ${n.id}`),element('span',n.title,'label'),element('small',`${n.kind.replaceAll('_',' ')}${prefs.showSize&&n.size?' · '+n.size:''}${n.hard?' · high risk':''}${n.inconsistent?' · conflict':''}`));b.onclick=()=>choose(n.id);$('nodes').append(b);
  if(visible(n)){const r=element('button',undefined,'order-row');r.append(element('span',n.order),element('span',n.kind.replaceAll('_',' ')),element('span',`${n.id} · ${n.title}`));r.onclick=()=>choose(n.id);$('order').append(r);}
  for(const dep of n.deps){const from=positions.get(dep),path=document.createElementNS(svgNS,'path');let d;if(prefs.direction==='vertical'){const x=from.x+110,y=from.y+108,X=p.x+110,Y=p.y;d=`M${x},${y} C${x},${y+20} ${X},${Y-20} ${X},${Y}`;}else{const x=from.x+220,y=from.y+54,X=p.x,Y=p.y+54;d=`M${x},${y} C${x+25},${y} ${X-25},${Y} ${X},${Y}`;}path.setAttribute('d',d);path.setAttribute('marker-end','url(#arrow)');if(selected&&(n.id===selected||ancestors.has(n.id)||descendants.has(n.id))&&(dep===selected||ancestors.has(dep)||descendants.has(dep)))path.classList.add('hot');$('edges').append(path);}
 }
 $('world').hidden=view!=='graph';$('order').hidden=view!=='list';$('graph-view').setAttribute('aria-pressed',String(view==='graph'));$('list-view').setAttribute('aria-pressed',String(view==='list'));$('chain').setAttribute('aria-pressed',String(highlightChain));
 detail();transform();
 $('repo').textContent=data.repo?`${data.repo.branch||'Detached'} · ${data.repo.head||'No commit'} · ${data.repo.ahead??'?'} ahead of ${data.repo.upstream||'no upstream'} · ${data.repo.freshness}`:'Project data and interface preferences are stored separately.';
}
function detail(){const box=$('detail');box.replaceChildren();const n=data.nodes.find(n=>n.id===selected);if(!n){box.append(element('h2','What can move next?'),element('p','Select a step to see its exit check, prerequisites and the work it unblocks.','muted'));for(const r of data.nodes.filter(n=>n.kind==='ready').slice(0,10)){const b=element('button',r.id+' · '+r.title);b.onclick=()=>choose(r.id);box.append(b);}box.append(element('h2','Longest dependency chain'),element('p',data.longest_chain.join(' → '),'muted'),element('p','Measured in steps, not elapsed time. A topological order is a valid build sequence, not a schedule.','muted'));}else{
 box.append(element('span',n.id,'eyebrow'),element('h2',n.title),element('span',n.kind.replaceAll('_',' '),'tag'));
 if(n.inconsistent)box.append(element('p','Prerequisite conflict: '+n.unmet.join(', '),'conflict'));
 if(n.hard)box.append(element('p','High risk: design or implementation may need revision.','muted'));
 if(n.description)box.append(element('p',n.description));box.append(element('h2','Done when'),element('p',n.exit_check||'No exit check supplied. Add an observable completion criterion.'));
 for(const [label,ids] of [['Prerequisites',n.deps],['Unblocks',n.unblocks]]){box.append(element('h2',label));if(!ids.length)box.append(element('p','None','muted'));for(const id of ids){const b=element('button',id);b.onclick=()=>choose(id);box.append(b);}}
 const p=n.progress;box.append(element('p',`${p.who||'Unassigned'} · ${p.retries||0} retries${p.updated?' · '+p.updated:''}`,'muted'));if(p.note)box.append(element('p',p.note));if(p.commit)box.append(element('p',`Commit ${p.commit} · ${n.pushed===true?'reachable from local upstream ref':n.pushed===false?'not reachable from local upstream ref':'push state unknown'}`,'muted'));
 if(!window.SNAPSHOT){const note=element('input');note.placeholder='Milestone or evidence note';note.setAttribute('aria-label','Milestone note');note.id='note';box.append(note);for(const [action,label] of [['start','Start'],['done','Mark done'],['block','Block'],['retry','Retry'],['reset','Reset']]){const b=element('button',label);b.disabled=['start','done','retry'].includes(action)&&n.unmet.length>0;b.onclick=()=>mutate(action,n.id,note.value);box.append(b);}}
 const clear=element('button','Clear selection');clear.onclick=()=>{selected=null;render();};box.append(clear);
 }
 const logs=data.log.filter(e=>!selected||e.step===selected).slice(0,40);$('activity').replaceChildren(...logs.map(e=>{const el=element('div',undefined,'activity');el.append(element('small',`${e.t} · ${e.who||'agent'} · ${e.step} / ${e.kind}`),element('span',e.msg||e.kind));return el;}));if(!logs.length)$('activity').append(element('p','No milestones reported yet.','muted'));
}
async function mutate(action,id,msg){try{const r=await fetch('/api/step',{method:'POST',headers:{'Content-Type':'application/json','X-Stepwise-Token':data.token},body:JSON.stringify({action,id,msg})});if(!r.ok)throw Error((await r.json()).error||'Update refused');await refresh();}catch(e){error(e.message);}}
let pending=false,lastSnapshot='';async function refresh(){if(pending)return;pending=true;try{if(window.SNAPSHOT){data=window.SNAPSHOT;$('connection').textContent='Offline snapshot';}else{const r=await fetch('/api/state');if(!r.ok)throw Error('Could not load plan');data=await r.json();$('connection').textContent='Live · '+new Date().toLocaleTimeString();}const fingerprint=JSON.stringify(data);if(fingerprint!==lastSnapshot){const note=$('note')?.value,focused=document.activeElement?.id;render();if(note!==undefined&&$('note'))$('note').value=note;if(focused)$(focused)?.focus();lastSnapshot=fingerprint;}}catch(e){$('connection').textContent='Disconnected · showing last snapshot';error(e.message);}finally{pending=false;}}
for(const id of ['search','filter','area'])$(id).addEventListener('input',()=>render());
$('settings-toggle').onclick=()=>$('settings').hidden=!$('settings').hidden;
for(const key of ['theme','density','direction','font','panel'])$(key).oninput=()=>{prefs[key]=$(key).value;applyPrefs();};$('show-size').onchange=()=>{prefs.showSize=$('show-size').checked;applyPrefs();};$('reset-prefs').onclick=()=>{prefs={...defaults};applyPrefs();};
$('graph-view').onclick=()=>{view='graph';render();};$('list-view').onclick=()=>{view='list';render();};$('chain').onclick=()=>{highlightChain=!highlightChain;render();};$('fit').onclick=fit;$('zoom-in').onclick=()=>{scale=Math.min(2,scale*1.2);transform();};$('zoom-out').onclick=()=>{scale=Math.max(.1,scale/1.2);transform();};
const viewport=$('viewport');let drag=null;viewport.onpointerdown=e=>{if(view!=='graph'||e.target.closest('button'))return;drag={x:e.clientX,y:e.clientY,tx,ty};viewport.setPointerCapture(e.pointerId);};viewport.onpointermove=e=>{if(!drag)return;tx=drag.tx+e.clientX-drag.x;ty=drag.ty+e.clientY-drag.y;transform();};viewport.onpointerup=()=>drag=null;viewport.onpointercancel=()=>drag=null;
viewport.addEventListener('wheel',e=>{if(view!=='graph')return;e.preventDefault();const rect=viewport.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top,old=scale;scale=Math.min(2,Math.max(.1,scale*(e.deltaY>0?.9:1.1)));tx=x-(x-tx)*scale/old;ty=y-(y-ty)*scale/old;transform();},{passive:false});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){selected=null;render();}});
applyPrefs();refresh();if(!window.SNAPSHOT)setInterval(refresh,3000);
