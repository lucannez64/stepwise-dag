'use strict';
const $ = id => document.getElementById(id);
const element = (tag, text, cls) => { const e=document.createElement(tag); if(text!==undefined)e.textContent=text; if(cls)e.className=cls; return e; };
let data=null, selected=null, view='graph', directOnly=true, highlightChain=false, scale=1, tx=24, ty=24, positions=new Map(), bounds={w:1,h:1};
const defaults={theme:'system',density:'compact',direction:'vertical',font:13,panel:360,showSize:true};
let prefs={...defaults};try{prefs={...defaults,...JSON.parse(localStorage.getItem('stepwise.preferences.v2')||'{}')};}catch{}
function applyPrefs(){
 document.documentElement.dataset.theme=['light','dark'].includes(prefs.theme)?prefs.theme:'system';
 document.documentElement.dataset.density=prefs.density==='compact'?'compact':'comfortable';
 document.documentElement.style.setProperty('--font',Math.max(11,Math.min(16,Number(prefs.font)||14))+'px');
 document.documentElement.style.setProperty('--panel',Math.max(260,Math.min(520,Number(prefs.panel)||340))+'px');
 for(const key of ['theme','density','direction','font','panel'])$(key).value=prefs[key];
 $('show-size').checked=prefs.showSize;
 try{localStorage.setItem('stepwise.preferences.v2',JSON.stringify(prefs));}catch{}
 if(data)render();
}
function error(msg){$('error').textContent=msg;$('error').hidden=false;setTimeout(()=>$('error').hidden=true,7000);}
function related(id,up){const by=new Map(data.nodes.map(n=>[n.id,n])), seen=new Set();function visit(k){for(const next of (up?by.get(k).deps:by.get(k).unblocks))if(!seen.has(next)){seen.add(next);visit(next);}}visit(id);return seen;}
function visible(n){const q=$('search').value.toLowerCase(),f=$('filter').value,a=$('area').value;return (!q||[n.id,n.title,n.area,n.description].some(s=>s.toLowerCase().includes(q)))&&(!a||n.area===a)&&(f==='all'||(f==='inconsistent'?n.inconsistent:n.kind===f));}
function transform(){$('world').style.transform=`translate(${tx}px,${ty}px) scale(${scale})`;}
let nodeW=200,nodeH=46;
function readable(){const v=$('viewport');scale=Math.max(.65,Math.min(1,(v.clientHeight-40)/bounds.h));tx=(v.clientWidth-bounds.w*scale)/2;ty=24;transform();}
function fit(){const v=$('viewport');scale=Math.min(1.2,Math.max(.12,Math.min((v.clientWidth-40)/bounds.w,(v.clientHeight-40)/bounds.h)));tx=20;ty=20;transform();}
function choose(id){selected=id;render();}
function render(){
 nodeW=prefs.density==='comfortable'?220:200;nodeH=prefs.density==='comfortable'?64:46;
 document.documentElement.style.setProperty('--node-w',nodeW+'px');document.documentElement.style.setProperty('--node-h',nodeH+'px');
 $('title').textContent=data.title;document.title=data.title+' · Stepwise';
 const areas=[...new Set(data.nodes.map(n=>n.area))].sort(),current=$('area').value;
 $('area').replaceChildren(new Option('All areas',''),...areas.map(a=>new Option(a||'Uncategorized',a)));$('area').value=current;
 const counts={done:0,in_progress:0,ready:0,waiting:0,blocked:0};data.nodes.forEach(n=>counts[n.kind]++);
 $('summary').replaceChildren(...Object.entries(counts).map(([k,v])=>{const e=element('div',undefined,'metric');e.append(element('b',k==='done'?v+' / '+data.nodes.length:v),element('span',k==='done'?'completed':k.replaceAll('_',' ')));return e;}));
 const notPushed=data.nodes.filter(n=>n.pushed===false).length;if(notPushed){const e=element('div',undefined,'metric');e.append(element('b',notPushed),element('span','not pushed'));$('summary').append(e);}
 const conflict=data.nodes.filter(n=>n.inconsistent).length;if(conflict){const e=element('div',undefined,'metric conflict');e.append(element('b',conflict),element('span','Prerequisite conflicts'));$('summary').append(e);}
 const ancestors=selected?related(selected,true):new Set(),descendants=selected?related(selected,false):new Set(),chain=new Set(data.longest_chain);
 const chosen=data.nodes.find(n=>n.id===selected),near=new Set(chosen?[...chosen.deps,...chosen.unblocks]:[]);
 const focus=n=>(!selected||n.id===selected||(directOnly?near.has(n.id):ancestors.has(n.id)||descendants.has(n.id)))&&(!highlightChain||chain.has(n.id));
 const buckets=new Map(),by=new Map(data.nodes.map(n=>[n.id,n]));positions=new Map();
 for(const n of data.nodes){if(!buckets.has(n.level))buckets.set(n.level,[]);buckets.get(n.level).push(n.id);}
 const layers=[...buckets.keys()].sort((a,b)=>a-b),rank=new Map();
 for(const layer of layers)buckets.get(layer).forEach((id,i)=>rank.set(id,i));
 for(let pass=0;pass<6;pass++)for(const layer of layers){const ids=buckets.get(layer);const bary=id=>{const deps=by.get(id).deps;return deps.length?deps.reduce((s,d)=>s+rank.get(d),0)/deps.length:rank.get(id);};ids.sort((a,b)=>bary(a)-bary(b));ids.forEach((id,i)=>rank.set(id,i));}
 const widest=Math.max(1,...[...buckets.values()].map(ids=>ids.length));
 for(const layer of layers){const ids=buckets.get(layer),offset=(widest-ids.length)*(nodeW+36)/2;ids.forEach((id,i)=>positions.set(id,prefs.direction==='vertical'?{x:offset+i*(nodeW+36),y:layer*(nodeH+70)}:{x:layer*(nodeW+70),y:offset+i*(nodeH+36)}));}
 bounds={w:Math.max(nodeW,...[...positions.values()].map(p=>p.x+nodeW)),h:Math.max(nodeH,...[...positions.values()].map(p=>p.y+nodeH))};
 $('nodes').replaceChildren();$('edges').replaceChildren();$('order').replaceChildren();
 const svgNS='http://www.w3.org/2000/svg',defs=document.createElementNS(svgNS,'defs'),marker=document.createElementNS(svgNS,'marker');marker.id='arrow';marker.setAttribute('viewBox','0 0 10 10');marker.setAttribute('refX','9');marker.setAttribute('refY','5');marker.setAttribute('markerWidth','7');marker.setAttribute('markerHeight','7');marker.setAttribute('orient','auto-start-reverse');const triangle=document.createElementNS(svgNS,'polygon');triangle.setAttribute('points','0,0 10,5 0,10');triangle.setAttribute('fill','currentColor');marker.append(triangle);defs.append(marker);$('edges').append(defs);
 for(const n of data.nodes){
  const p=positions.get(n.id),b=element('button',undefined,`node ${n.kind}${selected===n.id?' selected':''}${!visible(n)||!focus(n)?' dim':''}`);b.style.left=p.x+'px';b.style.top=p.y+'px';b.setAttribute('aria-label',`${n.id}: ${n.title}, ${n.kind}`);b.setAttribute('aria-pressed',String(selected===n.id));
  const head=element('div',undefined,'node-head');head.append(element('span','#'+n.order,'ord'),element('strong',n.id));if(prefs.showSize&&n.size)head.append(element('small',n.size));if(n.hard)head.append(element('small','hard','risk'));if(n.inconsistent)head.append(element('small','conflict','conflict'));b.append(head,element('span',n.title,'label'));b.title=n.title;if(n.pushed===false)b.classList.add('unpushed');b.onclick=()=>choose(n.id);$('nodes').append(b);
  if(visible(n)){const r=element('button',undefined,'order-row');r.append(element('span','#'+n.order),element('span',`${n.id} · ${n.title}`));r.onclick=()=>choose(n.id);$('order').append(r);}
  for(const dep of n.deps){const from=positions.get(dep),path=document.createElementNS(svgNS,'path');let d;if(prefs.direction==='vertical'){const x=from.x+nodeW/2,y=from.y+nodeH,X=p.x+nodeW/2,Y=p.y;d=`M${x},${y} C${x},${y+20} ${X},${Y-20} ${X},${Y}`;}else{const x=from.x+nodeW,y=from.y+nodeH/2,X=p.x,Y=p.y+nodeH/2;d=`M${x},${y} C${x+25},${y} ${X-25},${Y} ${X},${Y}`;}path.setAttribute('d',d);const hot=selected&&(directOnly?(n.id===selected||dep===selected):(focus(n)&&focus(by.get(dep))));if(hot)path.classList.add('hot');else if(selected||!visible(n)||!visible(by.get(dep)))path.classList.add('dim');$('edges').append(path);}
 }
 $('world').hidden=false;$('order').hidden=view!=='list';$('activity').hidden=view==='list';$('activity-title').textContent=view==='list'?'Dependency order — not execution priority':'Running log';$('list-view').setAttribute('aria-pressed',String(view==='list'));$('chain').setAttribute('aria-pressed',String(highlightChain));
 detail();transform();
 $('repo').textContent=data.repo?`${data.repo.branch||'Detached'} · ${data.repo.head||'?'} / ${data.repo.origin||data.repo.upstream||'?'} · ${data.repo.ahead??'?'} ahead${data.repo.dirty?' +dirty':''}${data.repo.worktrees!==undefined?' · '+data.repo.worktrees+' worktrees':''}${data.load?' · load '+data.load.join(' '):''} · ${data.repo.freshness}`:'';
}
function detail(){const box=$('detail');box.replaceChildren();const n=data.nodes.find(n=>n.id===selected);if(!n){box.append(element('p','Select a node to see its details, dependencies and log.','muted'));}else{
 box.append(element('span',n.id,'eyebrow'),element('h2',n.title),element('span',n.kind.replaceAll('_',' '),'tag'));
 if(n.inconsistent)box.append(element('p','Prerequisite conflict: '+n.unmet.join(', '),'conflict'));
 if(n.hard)box.append(element('p','High risk: design or implementation may need revision.','muted'));
 if(n.description)box.append(element('p',n.description));box.append(element('h2','Done when'),element('p',n.exit_check||'No exit check supplied. Add an observable completion criterion.'));
 for(const [label,ids] of [['Prerequisites',n.deps],['Unblocks',n.unblocks]]){box.append(element('h2',label));if(!ids.length)box.append(element('p','None','muted'));for(const id of ids){const b=element('button',id);b.onclick=()=>choose(id);box.append(b);}}
 const p=n.progress;box.append(element('p',`${p.who||'Unassigned'} · ${p.retries||0} retries${p.updated?' · '+p.updated:''}`,'muted'));if(p.note)box.append(element('p',p.note));if(p.commit)box.append(element('p',`Commit ${p.commit} · ${n.pushed===true?'reachable from local upstream ref':n.pushed===false?'not reachable from local upstream ref':'push state unknown'}`,'muted'));
 if(!window.SNAPSHOT){const note=element('input');note.placeholder='Milestone or evidence note';note.setAttribute('aria-label','Milestone note');note.id='note';box.append(note);for(const [action,label] of [['start','Start'],['done','Mark done'],['block','Block'],['retry','Retry'],['reset','Reset']]){const b=element('button',label);b.disabled=['start','done','retry'].includes(action)&&n.unmet.length>0;b.onclick=()=>mutate(action,n.id,note.value);box.append(b);}}
 const clear=element('button','Clear selection');clear.onclick=()=>{selected=null;render();};box.append(clear);
 }
 const logs=data.log.filter(e=>!selected||e.step===selected).slice(0,80);$('activity').replaceChildren(...logs.map(e=>{const el=element('div',undefined,'activity'),text=element('div');text.append(element('strong',e.step+' '),element('span',e.msg||e.kind));el.append(element('small',(e.t||'').slice(11,19)),text);return el;}));if(!logs.length)$('activity').append(element('p','No milestones reported yet.','muted'));
}
async function mutate(action,id,msg){try{const r=await fetch('/api/step',{method:'POST',headers:{'Content-Type':'application/json','X-Stepwise-Token':data.token},body:JSON.stringify({action,id,msg})});if(!r.ok)throw Error((await r.json()).error||'Update refused');await refresh();}catch(e){error(e.message);}}
let pending=false,lastSnapshot='',initialLayout=true;async function refresh(){if(pending)return;pending=true;try{if(window.SNAPSHOT){data=window.SNAPSHOT;$('connection').textContent='Offline snapshot';}else{const r=await fetch('/api/state');if(!r.ok)throw Error('Could not load plan');data=await r.json();$('connection').textContent='Live · '+new Date().toLocaleTimeString();}const fingerprint=JSON.stringify(data);if(fingerprint!==lastSnapshot){const note=$('note')?.value,focused=document.activeElement?.id;render();if(note!==undefined&&$('note'))$('note').value=note;if(focused)$(focused)?.focus();lastSnapshot=fingerprint;if(initialLayout){initialLayout=false;readable();}}}catch(e){$('connection').textContent='Disconnected · showing last snapshot';error(e.message);}finally{pending=false;}}
for(const id of ['search','filter','area'])$(id).addEventListener('input',()=>render());
$('settings-toggle').onclick=()=>$('settings').hidden=!$('settings').hidden;
for(const key of ['theme','density','direction','font','panel'])$(key).oninput=()=>{prefs[key]=$(key).value;applyPrefs();};$('show-size').onchange=()=>{prefs.showSize=$('show-size').checked;applyPrefs();};$('reset-prefs').onclick=()=>{prefs={...defaults};applyPrefs();};
$('list-view').onclick=()=>{view=view==='list'?'graph':'list';render();};$('direct').onclick=()=>{directOnly=!directOnly;$('direct').setAttribute('aria-pressed',String(directOnly));render();};$('progress-only').onclick=()=>{$('filter').value=$('filter').value==='in_progress'?'all':'in_progress';$('progress-only').setAttribute('aria-pressed',String($('filter').value==='in_progress'));render();};$('readable').onclick=readable;$('chain').onclick=()=>{highlightChain=!highlightChain;render();};$('fit').onclick=fit;$('zoom-in').onclick=()=>{scale=Math.min(2,scale*1.2);transform();};$('zoom-out').onclick=()=>{scale=Math.max(.1,scale/1.2);transform();};
const viewport=$('viewport');let drag=null;viewport.onpointerdown=e=>{if(view!=='graph'||e.target.closest('button'))return;drag={x:e.clientX,y:e.clientY,tx,ty};viewport.setPointerCapture(e.pointerId);};viewport.onpointermove=e=>{if(!drag)return;tx=drag.tx+e.clientX-drag.x;ty=drag.ty+e.clientY-drag.y;transform();};viewport.onpointerup=()=>drag=null;viewport.onpointercancel=()=>drag=null;
viewport.addEventListener('wheel',e=>{if(view!=='graph')return;e.preventDefault();const rect=viewport.getBoundingClientRect(),x=e.clientX-rect.left,y=e.clientY-rect.top,old=scale;scale=Math.min(2,Math.max(.1,scale*(e.deltaY>0?.9:1.1)));tx=x-(x-tx)*scale/old;ty=y-(y-ty)*scale/old;transform();},{passive:false});
document.addEventListener('keydown',e=>{if(e.key==='Escape'){selected=null;render();}});
applyPrefs();refresh();if(!window.SNAPSHOT)setInterval(refresh,3000);
