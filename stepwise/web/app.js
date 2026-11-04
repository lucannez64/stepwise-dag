"use strict";
/* Stepwise hub dashboard. No dependencies; works served by the hub or as an offline snapshot. */

const STATIC = window.STEPWISE_STATIC || null;
const $ = id => document.getElementById(id);
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const NS = "http://www.w3.org/2000/svg";
const svgEl = (tag, attrs = {}, parent) => {
  const e = document.createElementNS(NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
};

// ------------------------------------------------------------- preferences --
const PREF_KEY = "stepwise.hub.v1";
const DEFAULTS = { theme: "system", density: "compact", text: 100, sizes: true, legend: true, panel: 380, dir: {}, edges: {}, view: {} };
let prefs = { ...DEFAULTS };
try { prefs = { ...DEFAULTS, ...JSON.parse(localStorage.getItem(PREF_KEY) || "{}") }; } catch { /* private mode */ }
const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)); } catch { /* ignore */ } };
const darkQuery = matchMedia("(prefers-color-scheme: dark)");
function applyPrefs() {
  const t = prefs.theme === "system" ? (darkQuery.matches ? "macchiato" : "latte") : prefs.theme;
  document.documentElement.dataset.theme = t;
  document.documentElement.style.setProperty("--fs", (13 * prefs.text / 100).toFixed(2) + "px");
  document.documentElement.style.setProperty("--panel-w", prefs.panel + "px");
  $("app").classList.toggle("density-comfortable", prefs.density === "comfortable");
}
darkQuery.addEventListener("change", () => { if (prefs.theme === "system") applyPrefs(); });

// ------------------------------------------------------------------- state --
const LABEL = { done: "done", progress: "in progress", blocked: "blocked", ready: "ready", waiting: "waiting" };
const GLYPH = { done: "✓", progress: "●", blocked: "✕", ready: "○", waiting: "" };
const AREA_COLORS = ["blue", "peach", "teal", "yellow", "pink", "green", "mauve", "red", "sapphire", "flamingo", "lavender", "maroon", "sky", "rosewater"];

let projects = [];          // summaries from /api/projects
let route = { project: null, step: null };
let data = null;            // full data of the open project
let byId = {};
let filter = null, critOn = false, query = "";
const areasOff = new Map(); // project -> Set of hidden areas
const cams = new Map();     // project -> {k, tx, ty}
const seenLog = new Map();  // project -> log length already shown
let hubOk = 0, hubErr = null, lastFetch = 0;
let tableSort = { key: "order", dir: 1 };
let graph = null;           // built graph for the open project
let busy = false;

const sel = () => route.step && byId[route.step] ? route.step : null;
const viewOf = id => prefs.view[id] || "graph";
const dirOf = id => prefs.dir[id] || (data && data.id === id && data.direction) || "TB";
const edgesOf = id => prefs.edges[id] || (data && data.id === id && data.edges) || "all";
const offAreas = () => { if (!areasOff.has(route.project)) areasOff.set(route.project, new Set()); return areasOff.get(route.project); };

// -------------------------------------------------------------- time utils --
const dur = ms => {
  if (!(ms >= 0)) return "–";
  const m = Math.floor(ms / 60000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d ? `${d}d ${h % 24}h` : h ? `${h}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
};
const ts = iso => { const t = Date.parse(iso); return isNaN(t) ? NaN : t; };
const ago = iso => isNaN(ts(iso)) ? "–" : dur(Date.now() - ts(iso)) + " ago";
const clock = iso => {
  const d = new Date(ts(iso));
  if (isNaN(d)) return "";
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
};
const entry = id => (data && data.progress[id]) || null;
const runtime = e => e && e.started ? dur((e.finished ? ts(e.finished) : Date.now()) - ts(e.started)) : "–";
// In-progress steps: time since start when the format records it, else time since the last update.
const since = e => e && e.started ? runtime(e) : e && e.updated ? "updated " + ago(e.updated) : "in progress";

// ---------------------------------------------------------------- network --
async function getJSON(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 12000);
  try {
    const r = await fetch(url, { cache: "no-store", signal: ctl.signal });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || r.status);
    return body;
  } finally { clearTimeout(timer); }
}

async function pollProjects() {
  if (STATIC || document.hidden) return;
  try {
    const d = await getJSON("api/projects");
    projects = d.projects; hubOk = Date.now(); hubErr = null;
    if (!route.project) renderHome();
    renderMenu(); renderChrome();
  } catch (e) { hubErr = e.message || "unreachable"; renderChrome(); }
}

async function pollProject() {
  if (STATIC || !route.project || document.hidden) return;
  const id = route.project;
  try {
    const d = await getJSON("api/project/" + encodeURIComponent(id));
    hubOk = Date.now(); hubErr = null; lastFetch = Date.now();
    if (route.project !== id) return;
    setData(d);
  } catch (e) { hubErr = e.message || "unreachable"; renderChrome(); }
}

function setData(d) {
  const sig = JSON.stringify([d.mtime, d.counts, d.progress, d.log.length, d.error, d.repo, d.problems, d.nodes && d.nodes.length]);
  const changed = !data || data.id !== d.id || sig !== data._sig;
  d._sig = sig;
  data = d;
  byId = Object.fromEntries((d.nodes || []).map(n => [n.id, n]));
  if (changed) renderProject(); else renderChrome();
}

// ------------------------------------------------------------------ routing --
function parseHash() {
  const parts = location.hash.replace(/^#\/?/, "").split("/").filter(Boolean).map(decodeURIComponent);
  return { project: parts[0] || null, step: parts[1] || null };
}
function go(project, step = null, replace = false) {
  const h = "#/" + (project ? encodeURIComponent(project) + (step ? "/" + encodeURIComponent(step) : "") : "");
  if (replace) history.replaceState(null, "", h); else history.pushState(null, "", h);
  applyRoute();
}
function applyRoute() {
  const r = STATIC ? { project: STATIC.id, step: parseHash().step } : parseHash();
  const switched = r.project !== route.project;
  route = r;
  closeMenus();
  if (switched) {
    filter = null; critOn = false; query = ""; $("q").value = "";
    if (route.project) {
      if (!data || data.id !== route.project) { data = null; byId = {}; graph = null; }
      renderProject(); pollProject();
    } else { data = null; byId = {}; graph = null; renderHome(); pollProjects(); }
  } else if (route.project) renderProject(true);
}
addEventListener("hashchange", applyRoute);
addEventListener("popstate", applyRoute);

function selectStep(id, center = false) {
  if (!route.project) return;
  if (id && !byId[id]) return;
  go(route.project, id, true);
  if (center && id && viewOf(route.project) === "graph") focusNode(id);
}

// ------------------------------------------------------------- top chrome --
function stackBar(c, cls = "stack") {
  const t = c.total || 1;
  const seg = (n, col) => n ? `<i style="width:${(100 * n / t).toFixed(2)}%;background:var(--${col})"></i>` : "";
  return `<span class="${cls}">${seg(c.done, "done")}${seg(c.progress, "progress")}${seg(c.blocked, "blocked")}${seg(c.ready, "ready")}</span>`;
}
function statusDot(p) { return !p || p.loading ? "" : p.error ? (p.nodes || p.counts ? "stale" : "err") : "ok"; }

function renderChrome() {
  const home = !route.project;
  $("app").classList.toggle("home", home);
  $("toolbar").hidden = home || !data || !data.nodes;
  if ($("toolbar").hidden) $("chiprow").hidden = true;
  // switcher label
  const cur = home ? null : (data && data.id === route.project ? data : projects.find(p => p.id === route.project));
  $("switchName").textContent = home ? "All projects" : (cur ? cur.title : route.project);
  $("switchDot").className = "dotp " + (home ? (projects.some(p => p.error) ? "stale" : "ok") : statusDot(cur));
  document.title = home ? "Stepwise · all projects" : `${cur ? cur.title : route.project} · Stepwise`;
  // stats
  let c;
  if (home) {
    c = { done: 0, progress: 0, blocked: 0, ready: 0, waiting: 0, unpushed: 0, total: 0, retries: 0 };
    projects.forEach(p => p.counts && Object.keys(c).forEach(k => c[k] += p.counts[k] || 0));
  } else c = data && data.counts;
  if (c) {
    const pct = c.total ? Math.round(100 * c.done / c.total) : 0;
    $("stats").innerHTML = `
      <div class="donebar" title="${c.done} of ${c.total} steps done"><span class="lbl"><span><b>${c.done}</b> / ${c.total} done</span><span>${pct}%</span></span>${stackBar(c, "bar")}</div>
      <div class="stat progress"><b>${c.progress}</b><span>in progress</span></div>
      ${c.blocked ? `<div class="stat blocked"><b>${c.blocked}</b><span>blocked</span></div>` : ""}
      <div class="stat ready"><b>${c.ready}</b><span>ready</span></div>
      <div class="stat"><b>${c.waiting}</b><span>waiting</span></div>
      ${!home || c.unpushed ? `<div class="stat unpushed" title="Done, but the recorded commit is not on the upstream branch yet"><b>${c.unpushed}</b><span>not pushed</span></div>` : ""}
      ${c.retries ? `<div class="stat"><b>${c.retries}</b><span>retries</span></div>` : ""}
      ${home ? `<div class="stat"><b>${projects.length}</b><span>projects</span></div>` : ""}`;
  } else $("stats").innerHTML = "";
  // facts
  if (!home && data && data.nodes) {
    const ld = a => a ? a.slice(0, 3).map(x => x.toFixed(2)).join(" ") : "–";
    const r = data.repo;
    const cores = a => a && a[3] ? `${a[3]} cores` : "";
    $("facts").innerHTML = `
      <div class="fact" title="Load average on ${esc(data.machine || data.host)} (${cores(data.load)})"><b>${ld(data.load)}</b><span>load · ${esc(data.machine || data.host)}</span></div>
      ${data.box_host ? `<div class="fact opt" title="${esc(data.box_host)} ${cores(data.box)}"><b>${data.box ? ld(data.box) : "offline"}</b><span>load · build box</span></div>` : ""}
      ${r ? `<div class="fact" title="${esc(r.branch || "")}: HEAD / ${esc(r.upstream || "no upstream")} (local tracking refs, no fetch)"><b>${esc(r.head || "?")} / ${esc(r.origin || "?")}</b><span>head / ${esc((r.upstream || "origin").split("/")[0])} · ${esc(r.branch || "HEAD")}</span></div>
      <div class="fact ${r.dirty ? "warn" : ""}"><b>${r.ahead ?? "–"}${r.dirty ? " +dirty" : ""}</b><span>commits ahead</span></div>
      <div class="fact opt"><b>${r.worktrees}</b><span>worktrees</span></div>` : ""}`;
  } else $("facts").innerHTML = "";
  tickLive();
  // banner
  const b = $("banner");
  if (STATIC) {
    b.hidden = false;
    b.innerHTML = `Offline snapshot of <b>${esc(STATIC.title)}</b> from ${esc(new Date(STATIC.exported).toLocaleString())}. Done marks you set here stay in this browser only.`;
  } else if (!home && data && data.error && data.nodes) {
    b.hidden = false;
    b.innerHTML = `Showing data from ${esc(dur((data.age || 0) * 1000 + (Date.now() - lastFetch)))} ago: ${esc(data.error)}`;
  } else b.hidden = true;
}

function tickLive() {
  const el = $("live"), t = $("liveT");
  if (STATIC) { el.className = "live"; t.textContent = "snapshot"; return; }
  if (hubErr && Date.now() - hubOk > 8000) { el.className = "live err"; t.textContent = "hub unreachable"; return; }
  if (route.project && data && data.error) { el.className = "live stale"; t.textContent = "stale"; return; }
  if (route.project && data && data.age != null) {
    const s = Math.round(data.age + (Date.now() - lastFetch) / 1000);
    el.className = s < 15 ? "live on" : "live stale"; t.textContent = `live · ${s}s`;
    el.title = `Plan read ${s}s ago from ${data.machine || data.host}`;
    return;
  }
  el.className = hubOk ? "live on" : "live"; t.textContent = hubOk ? "live" : "connecting";
}

// ------------------------------------------------------------- switcher ----
function renderMenu() {
  const items = [`<button class="item" role="menuitem" data-go="" aria-current="${!route.project}"><span>⌂</span><span class="t">All projects</span><span class="kbd">0</span></button><hr>`];
  projects.forEach((p, i) => {
    const c = p.counts;
    items.push(`<button class="item" role="menuitem" data-go="${esc(p.id)}" aria-current="${route.project === p.id}">
      <i class="dotp ${statusDot(p)}"></i><span class="t">${esc(p.title)}</span>${i < 9 ? `<span class="kbd">${i + 1}</span>` : "<span></span>"}
      <span class="sub">${c ? `${stackBar(c, "mini")} ${c.done}/${c.total}${c.progress ? ` · ${c.progress} in progress` : ""}` : esc(p.error || "loading")} · ${esc(p.machine || p.host)}</span></button>`);
  });
  if (STATIC) items.length = 0;
  $("menu").innerHTML = items.join("");
}
$("switchBtn").onclick = e => {
  e.stopPropagation();
  if (STATIC) return;
  const open = $("menu").hidden;
  closeMenus();
  if (open) { renderMenu(); $("menu").hidden = false; $("switchBtn").setAttribute("aria-expanded", "true"); $("menu").querySelector("[aria-current=true]")?.focus(); }
};
$("menu").onclick = e => { const b = e.target.closest("[data-go]"); if (b) go(b.dataset.go || null); };
$("menu").onkeydown = e => {
  const items = [...$("menu").querySelectorAll(".item")], i = items.indexOf(document.activeElement);
  if (e.key === "ArrowDown") { e.preventDefault(); items[(i + 1) % items.length].focus(); }
  if (e.key === "ArrowUp") { e.preventDefault(); items[(i - 1 + items.length) % items.length].focus(); }
};
function closeMenus() {
  $("menu").hidden = true; $("switchBtn").setAttribute("aria-expanded", "false");
  $("prefs").hidden = true; $("prefsBtn").setAttribute("aria-expanded", "false");
}
document.addEventListener("click", e => { if (!e.target.closest("#menu, #prefs, #switchBtn, #prefsBtn")) closeMenus(); });

// ------------------------------------------------------------------ home ----
function renderHome() {
  renderChrome();
  const main = $("main");
  if (!main.querySelector(".homegrid")) main.innerHTML = `<div class="homegrid"><div class="cards" id="cards"></div><aside class="feed" id="feed"></aside></div>`;
  if (!projects.length) { $("cards").innerHTML = `<div class="empty">${hubErr ? "Cannot reach the hub: " + esc(hubErr) : "Loading projects…"}</div>`; $("feed").innerHTML = ""; return; }
  $("cards").innerHTML = projects.map((p, i) => {
    const c = p.counts;
    if (!c) return `<article class="card" tabindex="0" data-go="${esc(p.id)}"><div class="top"><div><h2>${esc(p.title)}</h2><div class="where">${esc(p.host)}</div></div>${i < 9 ? `<span class="kbd">${i + 1}</span>` : ""}</div>
      <div class="${p.loading ? "empty" : "errbox"}">${p.loading ? "Loading…" : esc(p.error)}</div></article>`;
    const pct = c.total ? Math.round(100 * c.done / c.total) : 0;
    const active = p.active.map(a => `<li><span class="dot ${a.status}"></span><span class="t"><span class="id">${esc(a.id)}</span> ${esc(a.title)}</span><span class="s">${a.status === "blocked" ? "blocked" : since(a)}</span></li>`).join("");
    const ready = p.ready.slice(0, 4).map(a => `<li><span class="dot ready"></span><span class="t"><span class="id">${esc(a.id)}</span> ${esc(a.title)}</span><span></span></li>`).join("");
    const r = p.repo;
    const sw = (col, n, l) => `<span><i class="sw" style="background:var(--${col})"></i><b>${n}</b> ${l}</span>`;
    return `<article class="card" tabindex="0" data-go="${esc(p.id)}" aria-label="Open ${esc(p.title)}">
      <div class="top"><div><h2>${esc(p.title)}</h2><div class="where"><i class="dotp ${statusDot(p)}"></i>${esc(p.machine || p.host)}${p.error ? ` · <span style="color:var(--yellow)">stale</span>` : ""}</div></div>${i < 9 ? `<span class="kbd">${i + 1}</span>` : ""}</div>
      <div class="big"><b>${pct}%</b><span>${c.done} of ${c.total} steps done</span></div>
      ${stackBar(c)}
      <div class="counts">${sw("progress", c.progress, "in progress")}${c.blocked ? sw("blocked", c.blocked, "blocked") : ""}${sw("ready", c.ready, "ready")}<span><i class="sw" style="background:var(--s1)"></i><b>${c.waiting}</b> waiting</span>${c.unpushed ? sw("peach", c.unpushed, "not pushed") : ""}</div>
      ${p.problems && p.problems.length ? `<div class="errbox">${p.problems.length} plan problem${p.problems.length > 1 ? "s" : ""}: ${esc(p.problems[0])}</div>` : ""}
      <div><h3>${p.active.length ? "In progress" : "Ready next"}</h3><ul>${active || ready || '<li class="empty">Nothing ready</li>'}</ul></div>
      ${p.active.length && ready ? `<div><h3>Ready next</h3><ul>${ready}</ul></div>` : ""}
      <div class="foot">${r ? `<span><b>${esc(r.head || "?")}</b> ${esc(r.branch || "")}</span><span><b>${r.ahead ?? "–"}</b> ahead${r.dirty ? " · dirty" : ""}</span>` : ""}${p.load ? `<span>load <b>${p.load[0].toFixed(2)}</b></span>` : ""}${p.box ? `<span>box <b>${p.box[0].toFixed(2)}</b></span>` : ""}</div>
    </article>`;
  }).join("");
  const feed = projects.flatMap(p => (p.log || []).map(e => ({ ...e, p }))).sort((a, b) => ts(b.t) - ts(a.t)).slice(0, 60);
  $("feed").innerHTML = `<div class="sechead"><h3>Recent activity</h3></div>` + (feed.map(e => `
    <div class="logrow"><span class="tm">${esc(clock(e.t))}</span><div class="hd"><span class="proj">${esc(e.p.title)}</span><a data-go="${esc(e.p.id)}" data-step="${esc(e.step)}">${esc(e.step)}</a>${kindBadge(e.kind)}${e.who ? `<span class="k">${esc(e.who)}</span>` : ""}</div><div class="m">${esc(e.msg)}</div></div>`).join("") || '<div class="empty">No activity yet.</div>');
}
$("main").addEventListener("click", e => {
  if (route.project) return;
  const a = e.target.closest("[data-step]");
  if (a) { e.stopPropagation(); return go(a.dataset.go, a.dataset.step); }
  const c = e.target.closest(".card[data-go]");
  if (c) go(c.dataset.go);
});
$("main").addEventListener("keydown", e => { const c = e.target.closest(".card[data-go]"); if (c && e.key === "Enter") go(c.dataset.go); });
const kindBadge = k => k ? `<span class="kind ${esc(k)}">${esc(k === "undo" ? "reset" : k)}</span>` : "";

// --------------------------------------------------------------- project ----
function renderProject(routeOnly = false) {
  renderChrome();
  const main = $("main");
  if (!data || data.id !== route.project) {
    main.innerHTML = `<div class="homegrid" style="grid-template-columns:1fr"><div class="cards"><div class="empty">Loading ${esc(route.project)}…</div></div></div>`;
    return;
  }
  if (!data.nodes) {
    main.innerHTML = `<div class="homegrid" style="grid-template-columns:1fr"><div class="cards"><article class="card"><h2>${esc(data.title)}</h2><div class="errbox">${esc(data.error || "Not loaded yet")}</div><div class="muted small">Source: ${esc(data.host)} · ${esc(data.format)} format. The hub retries every few seconds.</div></article></div></div>`;
    return;
  }
  if (!main.querySelector(".work")) {
    main.innerHTML = `<div class="work" id="work"><section class="stage" id="stage"></section><div class="resizer" id="resizer" role="separator" aria-orientation="vertical" aria-label="Resize side panel" tabindex="0"></div>
      <aside class="side"><section class="panel" id="panel"></section><section class="logsec" id="logsec"></section></aside></div>`;
    graph = null;
    bindResizer();
  }
  renderToolbar();
  renderStage(routeOnly);
  renderPanel();
  renderLog();
}

function renderToolbar() {
  const c = data.counts;
  $("nProg").textContent = c.progress; $("nReady").textContent = c.ready; $("nBlocked").textContent = c.blocked;
  $("fBlocked").hidden = !c.blocked && filter !== "blocked";
  document.querySelectorAll("[data-filter]").forEach(b => b.setAttribute("aria-pressed", filter === b.dataset.filter));
  $("critBtn").setAttribute("aria-pressed", critOn);
  $("critBtn").title = data.critical_computed ? "Longest chain of steps (computed: counts steps, not time) (c)" : "Critical path from the plan (c)";
  $("edgeBtn").setAttribute("aria-pressed", edgesOf(data.id) === "direct");
  const v = viewOf(data.id);
  document.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", b.dataset.view === v));
  $("zoomCtl").hidden = v !== "graph"; $("dirBtn").hidden = v !== "graph";
  const lr = dirOf(data.id) === "LR";
  $("dirBtn").innerHTML = lr
    ? `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="2" y="9" width="6" height="6" rx="1.5"/><rect x="16" y="4" width="6" height="6" rx="1.5"/><rect x="16" y="14" width="6" height="6" rx="1.5"/><path d="M8 12h4m0 0c2 0 2-5 4-5m-4 5c2 0 2 5 4 5"/></g></svg>`
    : `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="2" width="6" height="6" rx="1.5"/><rect x="4" y="16" width="6" height="6" rx="1.5"/><rect x="14" y="16" width="6" height="6" rx="1.5"/><path d="M12 8v4m0 0c0 2-5 2-5 4m5-4c0 2 5 2 5 4"/></g></svg>`;
  $("dirBtn").title = (lr ? "Left to right" : "Top to bottom") + " · switch direction (d)";
  const off = offAreas(), keys = Object.keys(data.areas);
  $("chiprow").hidden = keys.length < 2;
  $("areas").innerHTML = keys.map((a, i) => `<button class="chip" data-area="${esc(a)}" aria-pressed="${!off.has(a)}" title="${esc(data.areas[a])}"><i class="sw" style="background:${areaColor(a)}"></i>${esc(a === data.areas[a] || !a ? data.areas[a] : a + " · " + data.areas[a])} <span class="n">${data.nodes.filter(n => n.area === a).length}</span></button>`).join("");
}
const areaColor = a => `var(--${AREA_COLORS[Math.max(0, Object.keys(data.areas).indexOf(a)) % AREA_COLORS.length]})`;

// visibility rules shared by every view
function matches(n, q) {
  return n.id.toLowerCase().includes(q) || n.title.toLowerCase().includes(q) || n.check.toLowerCase().includes(q) || n.desc.toLowerCase().includes(q);
}
function focusSets() {
  const s = sel();
  if (!s) return null;
  const n = byId[s];
  if (edgesOf(data.id) === "direct") return { up: new Set(n.deps), down: new Set(n.users), direct: true };
  const walk = (start, key) => { const out = new Set(), st = [start]; while (st.length) for (const x of byId[st.pop()][key]) if (!out.has(x)) { out.add(x); st.push(x); } return out; };
  return { up: walk(s, "deps"), down: walk(s, "users"), direct: false };
}
function visibility() {
  const q = query.toLowerCase(), off = offAreas(), f = focusSets(), crit = new Set(data.critical), s = sel();
  const out = {};
  for (const n of data.nodes) {
    const match = !!q && matches(n, q);
    const related = !f || n.id === s || f.up.has(n.id) || f.down.has(n.id);
    // Every active filter dims what it excludes, as both original dashboards did.
    const dim = !related || off.has(n.area) || (filter && n.status !== filter) || (critOn && !crit.has(n.id)) || (q && !match);
    out[n.id] = { dim, match };
  }
  return { vis: out, f, crit };
}

// ----------------------------------------------------------------- stage ----
function renderStage(routeOnly) {
  const stage = $("stage"), v = viewOf(data.id);
  stage.className = "stage " + v;
  if (v === "graph") {
    const sig = layoutSig();
    if (!graph || graph.sig !== sig || !stage.querySelector("svg.g")) buildGraph(sig);
    updateGraph();
  } else {
    graph = null;
    if (v === "order") renderOrder(); else renderTable();
  }
  const q = query.toLowerCase();
  const n = q ? data.nodes.filter(x => matches(x, q)).length : 0;
  $("qCount").hidden = !q; $("qKbd").hidden = !!q; $("qCount").textContent = q ? `${n} found` : "";
}

function layoutSig() {
  return JSON.stringify([data.id, dirOf(data.id), prefs.density, prefs.sizes, data.nodes.map(n => [n.id, n.deps, n.level, n.order, n.area])]);
}

const measure = (() => {
  const ctx = document.createElement("canvas").getContext("2d");
  const sans = getComputedStyle(document.documentElement).getPropertyValue("--sans") || "system-ui";
  return (text, size = 11, weight = 400) => { ctx.font = `${weight} ${size}px ${sans}`; return ctx.measureText(text).width; };
})();
const monoW = (s, size) => s.length * size * 0.6;
function wrap2(text, width) {
  const words = text.split(/\s+/);
  let a = "", i = 0;
  for (; i < words.length; i++) { const t = (a ? a + " " : "") + words[i]; if (measure(t) > width && a) break; a = t; }
  let b = words.slice(i).join(" ");
  if (measure(a) > width) { while (a.length > 1 && measure(a + "…") > width) a = a.slice(0, -1); a += "…"; }
  if (b && measure(b) > width) { while (b.length > 1 && measure(b + "…") > width) b = b.slice(0, -1); b += "…"; }
  return [a, b];
}

function buildGraph(sig) {
  const stage = $("stage");
  const comfy = prefs.density === "comfortable";
  const W = comfy ? 224 : 204, H = comfy ? 60 : 54;
  const lr = dirOf(data.id) === "LR";
  const GAPX = lr ? 64 : 22, GAPY = lr ? 12 : 58;
  // layers by level, ordered by area then dependency order, then barycenter sweeps
  const levels = [];
  data.nodes.forEach(n => (levels[n.level] ||= []).push(n));
  for (let i = 0; i < levels.length; i++) levels[i] ||= [];
  const areaIdx = Object.fromEntries(Object.keys(data.areas).map((a, i) => [a, i]));
  levels.forEach(l => l.sort((a, b) => (areaIdx[a.area] ?? 0) - (areaIdx[b.area] ?? 0) || a.order - b.order));
  const r = {};
  levels.forEach(l => l.forEach((n, i) => r[n.id] = i));
  const bary = (n, list) => list.length ? list.reduce((s, id) => s + r[id], 0) / list.length : r[n.id];
  for (let it = 0; it < 12; it++) {
    const down = it % 2 === 0;
    for (const l of (down ? levels.slice(1) : levels.slice(0, -1).reverse())) {
      const b = {};
      l.forEach(n => b[n.id] = bary(n, down ? n.deps : n.users));
      l.sort((x, y) => b[x.id] - b[y.id]);
      l.forEach((n, i) => r[n.id] = i);
    }
  }
  const maxRows = Math.max(1, ...levels.map(l => l.length));
  const pos = {};
  const LABEL_PAD = 34;
  levels.forEach((l, li) => {
    if (lr) {
      const off = (maxRows - l.length) * (H + GAPY) / 2;
      l.forEach((n, i) => pos[n.id] = { x: 24 + li * (W + GAPX), y: LABEL_PAD + 10 + off + i * (H + GAPY) });
    } else {
      const off = (maxRows - l.length) * (W + GAPX) / 2;
      l.forEach((n, i) => pos[n.id] = { x: LABEL_PAD + 30 + off + i * (W + GAPX), y: 24 + li * (H + GAPY) });
    }
  });
  const worldW = lr ? 48 + levels.length * (W + GAPX) : LABEL_PAD + 60 + maxRows * (W + GAPX);
  const worldH = lr ? LABEL_PAD + 40 + maxRows * (H + GAPY) : 48 + levels.length * (H + GAPY);

  stage.innerHTML = `<div class="dotgrid"></div>`;
  const svg = svgEl("svg", { class: "g", role: "application", "aria-label": `${data.title} dependency graph` }, stage);
  const vp = svgEl("g", {}, svg);
  const gL = svgEl("g", {}, vp), gE = svgEl("g", {}, vp), gN = svgEl("g", {}, vp);
  levels.forEach((l, li) => {
    if (!l.length) return;
    if (lr) svgEl("text", { class: "lvl", x: 24 + li * (W + GAPX), y: 24 }, gL).textContent = "LEVEL " + li;
    else svgEl("text", { class: "lvl", x: 8, y: 24 + li * (H + GAPY) + H / 2 + 4 }, gL).textContent = "L" + li;
  });
  const edges = [];
  for (const n of data.nodes) for (const d of n.deps) {
    const a = pos[d], b = pos[n.id];
    let p;
    if (lr) { const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, c = Math.max(28, (x2 - x1) / 2); p = `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`; }
    else { const x1 = a.x + W / 2, y1 = a.y + H, x2 = b.x + W / 2, y2 = b.y, c = Math.max(24, (y2 - y1) / 2); p = `M${x1},${y1} C${x1},${y1 + c} ${x2},${y2 - c} ${x2},${y2}`; }
    edges.push({ from: d, to: n.id, el: svgEl("path", { class: "edge", d: p }, gE) });
  }
  const els = {};
  for (const n of data.nodes) {
    const { x, y } = pos[n.id];
    const g = svgEl("g", { class: "node", transform: `translate(${x},${y})`, tabindex: 0, role: "button", "data-id": n.id }, gN);
    svgEl("rect", { class: "pulse", width: W, height: H, rx: 7 }, g);
    svgEl("rect", { class: "box", width: W, height: H, rx: 7 }, g);
    svgEl("rect", { x: 4, y: 6, width: 3, height: H - 12, rx: 1.5, fill: areaColor(n.area) }, g);
    let cx = 13;
    const ord = svgEl("text", { class: "ord", x: cx, y: 17 }, g); ord.textContent = "#" + n.order; cx += monoW(ord.textContent, 10) + 5;
    const idt = svgEl("text", { class: "id", x: cx, y: 17 }, g);
    const st = svgEl("text", { class: "st", x: W - 8, y: 17, "text-anchor": "end" }, g);
    // fit the id, size and hard tags, leaving room for a status glyph
    const room = W - 8 - 16 - cx;
    let id = n.id;
    if (monoW(id, 11.5) > room) { while (id.length > 3 && monoW(id + "…", 11.5) > room) id = id.slice(0, -1); id += "…"; }
    idt.textContent = id; cx += monoW(id, 11.5) + 6;
    if (prefs.sizes && n.size && cx + monoW(n.size, 9.5) < W - 24) { svgEl("text", { class: "tag", x: cx, y: 17 }, g).textContent = n.size; cx += monoW(n.size, 9.5) + 5; }
    if (n.hard && cx + 24 < W - 24) { svgEl("text", { class: "hard", x: cx, y: 17 }, g).textContent = "hard"; cx += 26; }
    const [l1, l2] = wrap2(n.title, W - 22);
    svgEl("text", { x: 13, y: comfy ? 35 : 33 }, g).textContent = l1;
    if (l2) svgEl("text", { x: 13, y: comfy ? 50 : 46 }, g).textContent = l2;
    els[n.id] = { g, st, statusRoom: W - 8 - cx };
  }
  graph = { sig, svg, vp, edges, els, pos, W, H, worldW, worldH, lr };
  bindGraph(svg);
  const cam = cams.get(data.id);
  if (cam && cam.sig === sig) applyCam(); else initialView();
}

function updateGraph() {
  const { vis, f, crit } = visibility();
  const s = sel();
  const critEdges = new Set(data.critical.slice(1).map((id, i) => data.critical[i] + ">" + id));
  for (const n of data.nodes) {
    const e = graph.els[n.id];
    if (!e) continue;
    const v = vis[n.id];
    e.g.setAttribute("class", `node ${n.status}${n.unpushed ? " unpushed" : ""}${n.id === s ? " sel" : ""}${v.match ? " match" : ""}${v.dim ? " dim" : ""}`);
    e.g.setAttribute("aria-label", `${n.id}: ${n.title}. ${LABEL[n.status]}${n.unpushed ? ", not pushed" : ""}.`);
    const full = n.status === "waiting" ? "" : n.unpushed ? "✓ not pushed" : `${GLYPH[n.status]} ${LABEL[n.status]}`;
    const fits = monoW(full, 9.5) * 0.92 <= e.statusRoom;
    e.st.textContent = fits ? full : (n.unpushed ? "✓↑" : GLYPH[n.status]);
    e.st.setAttribute("class", `st st-${n.status}`);
  }
  for (const e of graph.edges) {
    let cls = "edge";
    if (f) {
      if (f.direct) cls += e.to === s && f.up.has(e.from) ? " up" : e.from === s && f.down.has(e.to) ? " down" : " dim";
      else cls += (e.to === s || f.up.has(e.to)) && f.up.has(e.from) ? " up" : (e.from === s || f.down.has(e.from)) && f.down.has(e.to) ? " down" : " dim";
    } else if (critOn) cls += critEdges.has(e.from + ">" + e.to) ? " crit" : " dim";
    else if (vis[e.from].dim || vis[e.to].dim) cls += " dim";
    e.el.setAttribute("class", cls);
  }
  renderLegend();
}

function renderLegend() {
  const stage = $("stage");
  let lg = stage.querySelector(".legend");
  if (!prefs.legend) { lg?.remove(); return; }
  if (!lg) { lg = document.createElement("div"); lg.className = "legend"; stage.appendChild(lg); }
  const sw = (fill, stroke, dash) => `<i class="sw" style="background:color-mix(in srgb, var(--${fill}) 22%, var(--base));border-color:var(--${stroke});${dash ? "border-style:dashed" : ""}"></i>`;
  lg.innerHTML = `<span class="k">${sw("done", "done")}done</span><span class="k">${sw("done", "done", 1)}not pushed</span>
    <span class="k">${sw("progress", "progress")}in progress</span><span class="k">${sw("blocked", "blocked")}blocked</span>
    <span class="k">${sw("ready", "ready")}ready</span><span class="k">${sw("s0", "s1")}waiting</span>
    <span class="k"><i class="ln" style="border-color:var(--needs)"></i>needs</span><span class="k"><i class="ln" style="border-color:var(--unblocks)"></i>unblocks</span>
    ${critOn ? `<span class="k"><i class="ln" style="border-color:var(--crit)"></i>critical</span>` : ""}
    <button title="Hide legend (it can come back in view settings)" aria-label="Hide legend" data-hide-legend>×</button>`;
}

// camera
function applyCam() {
  const c = cams.get(data.id);
  graph.vp.setAttribute("transform", `translate(${c.tx},${c.ty}) scale(${c.k})`);
  $("zPct").textContent = Math.round(c.k * 100) + "%";
  const dg = $("stage").querySelector(".dotgrid");
  if (dg) { dg.style.backgroundSize = `${22 * c.k}px ${22 * c.k}px`; dg.style.backgroundPosition = `${c.tx}px ${c.ty}px`; }
}
function setCam(k, tx, ty) { cams.set(data.id, { k: Math.min(3, Math.max(0.08, k)), tx, ty, sig: graph.sig }); applyCam(); }
function fitAll() {
  const r = $("stage").getBoundingClientRect();
  const k = Math.min(1.2, (r.width - 24) / graph.worldW, (r.height - 24) / graph.worldH);
  setCam(k, (r.width - graph.worldW * k) / 2, (r.height - graph.worldH * k) / 2);
}
function initialView() {
  const r = $("stage").getBoundingClientRect();
  if (graph.lr) {
    const k = Math.min(1, Math.max(0.5, (r.height - 20) / graph.worldH));
    setCam(k, 8, Math.max(8, (r.height - graph.worldH * k) / 2));
  } else {
    const k = Math.min(1, Math.max(0.5, (r.width - 20) / graph.worldW));
    setCam(k, (r.width - graph.worldW * k) / 2, 8);
  }
  const s = sel();
  const active = data.nodes.filter(n => n.status === "progress").sort((a, b) => a.order - b.order)[0];
  if (s) focusNode(s);
  else if (active) focusNode(active.id);
}
// Fit the camera around some steps, for example the critical path.
function fitNodes(ids) {
  const ps = ids.map(id => graph.pos[id]).filter(Boolean);
  if (!ps.length) return;
  const r = $("stage").getBoundingClientRect();
  const x0 = Math.min(...ps.map(p => p.x)) - 30, y0 = Math.min(...ps.map(p => p.y)) - 30;
  const x1 = Math.max(...ps.map(p => p.x)) + graph.W + 30, y1 = Math.max(...ps.map(p => p.y)) + graph.H + 30;
  const k = Math.max(0.45, Math.min(1.1, r.width / (x1 - x0), r.height / (y1 - y0)));
  // Too big to fit at a readable size: start at the first step instead of centring.
  const fits = (x1 - x0) * k <= r.width && (y1 - y0) * k <= r.height;
  const p0 = graph.pos[ids[0]];
  if (fits) setCam(k, (r.width - (x1 - x0) * k) / 2 - x0 * k, (r.height - (y1 - y0) * k) / 2 - y0 * k);
  else setCam(k, graph.lr ? 20 - (p0.x - 30) * k : r.width / 2 - (p0.x + graph.W / 2) * k, graph.lr ? r.height / 2 - (p0.y + graph.H / 2) * k : 20 - (p0.y - 30) * k);
}
function zoomAt(f, mx, my) {
  const c = cams.get(data.id), r = $("stage").getBoundingClientRect();
  mx ??= r.width / 2; my ??= r.height / 2;
  const nk = Math.min(3, Math.max(0.08, c.k * f));
  setCam(nk, mx - (mx - c.tx) * nk / c.k, my - (my - c.ty) * nk / c.k);
}
function focusNode(id) {
  if (!graph || !graph.pos[id]) return;
  const r = $("stage").getBoundingClientRect(), c = cams.get(data.id) || { k: 1 };
  const k = Math.max(c.k, 0.85), p = graph.pos[id];
  setCam(k, r.width / 2 - (p.x + graph.W / 2) * k, r.height / 2 - (p.y + graph.H / 2) * k);
}

function bindGraph(svg) {
  const stage = $("stage");
  const pts = new Map();
  let drag = null, pinch = null;
  svg.addEventListener("wheel", e => {
    e.preventDefault();
    const r = stage.getBoundingClientRect();
    zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
  }, { passive: false });
  svg.addEventListener("pointerdown", e => {
    pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.size === 2) {
      const [a, b] = [...pts.values()], c = cams.get(data.id);
      pinch = { d: Math.hypot(a.x - b.x, a.y - b.y), k: c.k, tx: c.tx, ty: c.ty, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
      drag = null; return;
    }
    if (e.button !== 0) return;
    const c = cams.get(data.id);
    drag = { x: e.clientX, y: e.clientY, tx: c.tx, ty: c.ty, moved: false, node: e.target.closest(".node") };
    svg.setPointerCapture(e.pointerId);
  });
  svg.addEventListener("pointermove", e => {
    if (pts.has(e.pointerId)) pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinch && pts.size === 2) {
      const [a, b] = [...pts.values()], r = stage.getBoundingClientRect();
      const nk = Math.min(3, Math.max(0.08, pinch.k * Math.hypot(a.x - b.x, a.y - b.y) / pinch.d));
      const mx = pinch.mx - r.left, my = pinch.my - r.top;
      setCam(nk, mx - (mx - pinch.tx) * nk / pinch.k, my - (my - pinch.ty) * nk / pinch.k);
      return;
    }
    if (drag) {
      const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > 4) { drag.moved = true; stage.classList.add("drag"); hideTip(); }
      if (drag.moved) setCam(cams.get(data.id).k, drag.tx + dx, drag.ty + dy);
      return;
    }
    const n = e.target.closest(".node");
    if (n && e.pointerType === "mouse") showTip(n.dataset.id, e); else hideTip();
  });
  const end = e => {
    pts.delete(e.pointerId);
    if (pinch) { if (pts.size < 2) pinch = null; return; }
    if (drag && !drag.moved) {
      const id = drag.node && drag.node.dataset.id;
      selectStep(id && id !== sel() ? id : null);
    }
    drag = null; stage.classList.remove("drag");
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  svg.addEventListener("pointerleave", hideTip);
  svg.addEventListener("keydown", e => {
    const n = e.target.closest(".node");
    if (n && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selectStep(n.dataset.id); }
  });
}

// tooltip
const tip = $("tip");
function showTip(id, e) {
  const n = byId[id]; if (!n) return;
  const en = entry(id);
  const bits = [`<span class="pill ${n.status}" style="height:18px">${LABEL[n.status]}</span>`, n.size && `size ${esc(n.size)}`, n.hard && `<span style="color:var(--red)">hard</span>`, `order ${n.order}`, en && en.started && n.status === "progress" && runtime(en)].filter(Boolean);
  const text = (en && en.note) || n.check || n.desc;
  tip.innerHTML = `<div class="h">${esc(n.id)}</div><div>${esc(n.title)}</div><div class="l">${bits.join(" · ")}</div>${text ? `<div class="muted">${esc(text.length > 260 ? text.slice(0, 259) + "…" : text)}</div>` : ""}`;
  tip.style.display = "block";
  const w = tip.offsetWidth, h = tip.offsetHeight;
  tip.style.left = Math.min(e.clientX + 14, innerWidth - w - 8) + "px";
  tip.style.top = (e.clientY + 16 + h > innerHeight ? e.clientY - h - 12 : e.clientY + 16) + "px";
}
function hideTip() { tip.style.display = "none"; }

// order + table
const listScroll = () => { const l = $("stage").querySelector(".list"); return l ? l.scrollTop : 0; };
function keepScroll(top, s) {
  const l = $("stage").querySelector(".list");
  if (!l) return;
  l.scrollTop = top;
  const row = s && l.querySelector(".sel");
  if (row && s !== keepScroll.last) {
    const r = row.getBoundingClientRect(), b = l.getBoundingClientRect();
    if (r.top < b.top + 40 || r.bottom > b.bottom) row.scrollIntoView({ block: "center" });
  }
  keepScroll.last = s;
}
function renderOrder() {
  const { vis } = visibility(), s = sel(), top = listScroll();
  const rows = data.order.map(id => byId[id]).map(n => {
    const e = entry(n.id);
    const right = [data.areas[n.area] && esc(data.areas[n.area]), n.size && esc(n.size), n.hard && '<span style="color:var(--red)">hard</span>',
      n.status === "progress" ? `<span style="color:var(--progress)">${since(e)}</span>` : `<span class="${n.status}">${LABEL[n.status]}${n.unpushed ? ", not pushed" : ""}</span>`].filter(Boolean).join(" · ");
    return `<div class="orow${n.id === s ? " sel" : ""}${vis[n.id].dim ? " dim" : ""}" data-id="${esc(n.id)}" tabindex="0"><span class="n">#${n.order}</span><span class="dot ${n.unpushed ? "unpushed" : n.status}"></span><span class="id">${esc(n.id)}</span><span class="t" title="${esc(n.title)}">${esc(n.title)}</span><span class="r">${right}</span></div>`;
  }).join("");
  $("stage").innerHTML = `<div class="list"><div class="listhead"><b>Dependency order</b><span>One valid build sequence: every step comes after its prerequisites. It is not a priority ranking.</span></div>${rows}</div>`;
  keepScroll(top, s);
}

const COLS = [
  ["order", "#", n => n.order], ["id", "Step", n => n.id], ["area", "Area", n => data.areas[n.area] || n.area],
  ["level", "Level", n => n.level], ["size", "Size", n => n.size], ["status", "State", n => n.status],
  ["title", "Title", n => n.title], ["check", "Done when", n => n.check || n.desc], ["deps", "Needs", n => n.deps.length],
  ["updated", "Updated", n => (entry(n.id) || {}).updated || ""], ["who", "By", n => (entry(n.id) || {}).who || ""],
];
function renderTable() {
  const { vis } = visibility(), s = sel(), top = listScroll();
  const col = COLS.find(c => c[0] === tableSort.key) || COLS[0];
  const rows = data.nodes.slice().sort((a, b) => {
    const x = col[2](a), y = col[2](b);
    return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * tableSort.dir || a.order - b.order;
  });
  const head = COLS.map(c => `<th data-sort="${c[0]}" aria-sort="${tableSort.key === c[0] ? (tableSort.dir > 0 ? "ascending" : "descending") : "none"}">${c[1]}${tableSort.key === c[0] ? ` <span class="ar">${tableSort.dir > 0 ? "↑" : "↓"}</span>` : ""}</th>`).join("");
  const body = rows.map(n => {
    const e = entry(n.id) || {};
    return `<tr data-id="${esc(n.id)}" class="${n.id === s ? "sel" : ""}${vis[n.id].dim ? " dim" : ""}" tabindex="0">
      <td class="muted">${n.order}</td><td class="id">${esc(n.id)}</td><td><i class="dot" style="display:inline-block;vertical-align:-1px;margin-right:5px;background:${areaColor(n.area)};border-color:${areaColor(n.area)}"></i>${esc(data.areas[n.area] || n.area)}</td>
      <td>${n.level}</td><td>${esc(n.size)}${n.hard ? ' <span style="color:var(--red)">hard</span>' : ""}</td>
      <td><span class="pill ${n.status}" style="height:20px">${LABEL[n.status]}</span>${n.unpushed ? ' <span class="pill unpushed" style="height:20px">not pushed</span>' : ""}</td>
      <td>${esc(n.title)}</td><td class="wrap">${esc(n.check || n.desc)}</td><td class="mono small">${esc(n.deps.join(", ") || "–")}</td>
      <td class="muted small" title="${esc(e.updated || "")}">${e.updated ? ago(e.updated) : ""}</td><td class="small">${esc(e.who || "")}</td></tr>`;
  }).join("");
  $("stage").innerHTML = `<div class="list"><table class="t"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  keepScroll(top, s);
}
$("main").addEventListener("click", e => {
  if (!route.project || !data) return;
  const th = e.target.closest("th[data-sort]");
  if (th) { tableSort = { key: th.dataset.sort, dir: tableSort.key === th.dataset.sort ? -tableSort.dir : 1 }; renderTable(); $("stage").querySelector(".list").scrollTop = 0; return; }
  const row = e.target.closest(".orow[data-id], tr[data-id]");
  if (row) return selectStep(row.dataset.id === sel() ? null : row.dataset.id);
  if (e.target.closest("[data-hide-legend]")) { prefs.legend = false; savePrefs(); return renderLegend(); }
});
$("main").addEventListener("keydown", e => {
  const row = e.target.closest(".orow[data-id], tr[data-id]");
  if (row && e.key === "Enter") selectStep(row.dataset.id);
});

// ----------------------------------------------------------------- panel ----
const linkRow = id => {
  const n = byId[id], e = entry(id);
  const right = n.status === "progress" ? since(e) : LABEL[n.status] + (n.unpushed ? ", not pushed" : "");
  return `<li data-goto="${esc(id)}" tabindex="0"><span class="dot ${n.unpushed ? "unpushed" : n.status}"></span><span class="id">${esc(id)}</span><span class="t" title="${esc(n.title)}">${esc(n.title)}</span><span class="s">${right}</span></li>`;
};
const linkList = (ids, empty) => `<ul class="links">${ids.map(linkRow).join("") || `<li class="none">${empty}</li>`}</ul>`;

function renderPanel() {
  const p = $("panel"), keep = p.scrollTop, s = sel();
  const focused = document.activeElement && document.activeElement.id === "noteIn";
  const draft = $("noteIn") ? $("noteIn").value : "";
  p.innerHTML = s ? detail(byId[s]) : overview();
  if ($("noteIn")) { $("noteIn").value = draft; if (focused) $("noteIn").focus(); }
  p.scrollTop = keep;
}

function overview() {
  const by = st => data.nodes.filter(n => n.status === st).sort((a, b) => a.order - b.order);
  const prog = by("progress"), blocked = by("blocked"), ready = by("ready");
  const problems = data.problems && data.problems.length ? `<div class="errbox"><b>Plan problems</b><br>${data.problems.map(esc).join("<br>")}</div>` : "";
  return `${problems}
    ${prog.length ? `<h3 style="margin-top:2px">In progress · ${prog.length}</h3>${linkList(prog.map(n => n.id))}` : ""}
    ${blocked.length ? `<h3>Blocked · ${blocked.length}</h3>${linkList(blocked.map(n => n.id))}` : ""}
    <h3 ${prog.length || blocked.length ? "" : 'style="margin-top:2px"'}>Ready to start · ${ready.length}</h3>
    ${linkList(ready.slice(0, 12).map(n => n.id), "Nothing is ready: every open step waits on a prerequisite.")}
    ${ready.length > 12 ? `<button class="btn ghost small" data-filter-ready style="margin-top:4px">Show all ${ready.length} ready steps</button>` : ""}
    <p class="muted small">Ready means every prerequisite is recorded as done. It is not a priority order.</p>
    <h3>${data.critical_computed ? "Longest chain" : "Critical path"} · ${data.critical.length} steps</h3>
    ${linkList(data.critical)}
    ${data.critical_computed ? `<p class="muted small">Counted in steps, not time.</p>` : ""}
    <p class="muted small" style="margin-top:16px">${STATIC ? "Offline snapshot. Mark done here to plan; marks stay in this browser."
      : `Live from ${esc(data.machine || data.host)} (${esc(data.format)} plan). Changes made by agents with the project's CLI show up within seconds. <a href="export/${encodeURIComponent(data.id)}.html">Download an offline snapshot</a>`}</p>`;
}

function detail(n) {
  const e = entry(n.id) || {}, s = n.status;
  const crit = data.critical.includes(n.id);
  const f = (() => { const walk = (start, key) => { const out = new Set(), st = [start]; while (st.length) for (const x of byId[st.pop()][key]) if (!out.has(x)) { out.add(x); st.push(x); } return out; }; return { up: walk(n.id, "deps"), down: walk(n.id, "users") }; })();
  const pills = [`<span class="pill ${s}">${GLYPH[s] || "○"} ${LABEL[s]}</span>`, n.unpushed && `<span class="pill unpushed">not pushed</span>`,
    n.hard && `<span class="pill hard">hard</span>`, crit && `<span class="pill crit">${data.critical_computed ? "longest chain" : "critical path"}</span>`].filter(Boolean).join("");
  const cell = (v, l, t = "") => `<div title="${esc(t)}"><b>${v}</b><span>${l}</span></div>`;
  const meta = `<div class="meta">${cell("#" + n.order, "order", `${n.order} of ${data.nodes.length} in dependency order`)}${cell(n.level, "level")}${cell(esc(n.size || "–"), "size")}${cell(f.down.size, "depend on it", "steps that need this one, directly or not")}
    ${cell(runtime(e), "runtime")}${cell(e.retries ?? 0, "retries")}${cell(e.updated ? ago(e.updated) : "–", "last update", e.updated || "")}${cell(esc(e.who || "–"), "by")}</div>`;
  const commit = e.commit ? `<div class="commit">commit <code>${esc(String(e.commit).slice(0, 10))}</code> · ${n.unpushed ? `<span style="color:var(--peach)">not on ${esc((data.repo || {}).upstream || "upstream")} yet</span>` : data.repo && data.repo.pushed && e.commit in data.repo.pushed ? "pushed" : "push state unknown"}</div>` : "";
  const unmet = s !== "done" && n.unmet.length ? `<div class="warnbox">Waiting on ${n.unmet.length} prerequisite${n.unmet.length > 1 ? "s" : ""}: ${n.unmet.map(id => `<a data-goto="${esc(id)}" href="javascript:void 0">${esc(id)}</a>`).join(", ")}. ${f.up.size} steps upstream in total.</div>` : "";
  const check = n.check ? `<h3>Done when</h3><div class="check">${esc(n.check)}</div>` : "";
  const desc = n.desc ? `<h3>${n.check ? "Notes" : "Description"}</h3><div class="check">${esc(n.desc)}</div>` : "";
  const noCheck = !n.check && !n.desc ? `<h3>Done when</h3><div class="check empty">No completion check written for this step.</div>` : "";
  return `<div class="dhead"><span class="idl">${esc(n.id)}</span><button class="iconbtn x" data-close aria-label="Close details" title="Close (Esc)">✕</button></div>
    <div class="dtitle">${esc(n.title)}</div>
    <div class="darea"><i class="sw" style="background:${areaColor(n.area)}"></i>${esc(data.areas[n.area] || n.area || "no area")}</div>
    <div class="pills">${pills}</div>
    ${meta}
    ${e.note && e.note !== n.check ? `<div class="note">${esc(e.note)}</div>` : ""}${commit}
    ${n.hard ? `<p class="small" style="color:var(--red);margin:0 0 8px">Hard: this step may need a redesign.</p>` : ""}
    ${unmet}${check}${desc}${noCheck}
    ${actions(n, e)}
    <h3>Needs first · ${n.deps.length}</h3>${linkList(n.deps, "Nothing: it can start any time.")}
    <h3>Unblocks · ${n.users.length}</h3>${linkList(n.users, "Nothing depends on it.")}
    <p class="muted small">${f.down.size} step${f.down.size === 1 ? "" : "s"} depend on this one, directly or not.</p>`;
}

function actions(n, e) {
  if (STATIC) {
    const local = staticDone().has(n.id);
    return n.status === "done" && !local ? "" : `<div class="actions"><div class="btns" style="margin:0"><button class="btn" data-local>${local ? "Mark not done" : "Mark done"}</button><span class="muted small" style="align-self:center">Saved in this browser only</span></div></div>`;
  }
  const can = a => data.actions.includes(a), s = n.status, b = [];
  if (can("start") && s !== "progress" && s !== "done") b.push(`<button class="btn primary" data-act="start">Start</button>`);
  if (can("done") && s !== "done") b.push(`<button class="btn good" data-act="done">Mark done</button>`);
  if (can("block") && s === "progress") b.push(`<button class="btn" data-act="block">Block</button>`);
  if (can("retry") && (s === "progress" || s === "blocked")) b.push(`<button class="btn" data-act="retry">Retry</button>`);
  // VELA's CLI starts a step when you log on it, so only offer notes once it has a record.
  if (can("log") && !(data.log_starts && !data.progress[n.id])) b.push(`<button class="btn" data-act="log">Add note</button>`);
  if (can("reset") && data.progress[n.id]) b.push(`<button class="btn ghost" data-act="reset">Reset…</button>`);
  if (!b.length) return "";
  const noteOnly = b.some(x => x.includes('data-act="log"'));
  return `<div class="actions"><input id="noteIn" maxlength="2000" placeholder="${noteOnly ? "Note for the log (optional, Enter adds it)" : "Note for the log (optional)"}" aria-label="Note">
    <div class="btns">${b.join("")}</div>${n.unmet.length && s !== "done" ? `<div class="muted small" style="margin-top:6px">${n.unmet.length} prerequisite${n.unmet.length > 1 ? "s are" : " is"} not done yet.</div>` : ""}</div>`;
}

async function act(action) {
  const id = sel(); if (!id || busy) return;
  const input = $("noteIn"), msg = input ? input.value.trim() : "";
  if (action === "log" && !msg) { input && input.focus(); return toast("Write a note first"); }
  if (action === "reset" && !(await confirmReset(id))) return;
  busy = true;
  document.querySelectorAll("[data-act]").forEach(b => b.disabled = true);
  try {
    const r = await fetch("api/project/" + encodeURIComponent(data.id) + "/step", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Stepwise": "1" },
      body: JSON.stringify({ action, id, msg }),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || r.status);
    if (input) input.value = "";
    lastFetch = Date.now();
    setData(body);
    toast({ start: `${id} started`, done: `${id} marked done`, block: `${id} blocked`, retry: `${id} retried`, log: "Note added", reset: `${id} reset` }[action]);
  } catch (err) { toast("Could not save: " + err.message, true); }
  finally { busy = false; document.querySelectorAll("[data-act]").forEach(b => b.disabled = false); }
}
function confirmReset(id) {
  return new Promise(resolve => {
    const d = $("confirm");
    $("cTitle").textContent = `Reset ${id}?`;
    $("cBody").textContent = "Its progress record is cleared. The log keeps the history.";
    const done = v => { d.close(); resolve(v); };
    $("cYes").onclick = () => done(true); $("cNo").onclick = () => done(false);
    d.oncancel = () => resolve(false);
    d.showModal(); $("cNo").focus();
  });
}

$("main").addEventListener("click", e => {
  if (!route.project || !data) return;
  const g = e.target.closest("[data-goto]");
  if (g) { e.preventDefault(); return selectStep(g.dataset.goto, true); }
  const a = e.target.closest("[data-act]");
  if (a) return act(a.dataset.act);
  if (e.target.closest("[data-close]")) return selectStep(null);
  if (e.target.closest("[data-filter-ready]")) { filter = "ready"; return renderProject(); }
  if (e.target.closest("[data-local]")) { toggleStatic(sel()); return; }
  if (e.target.closest("[data-showall]")) return selectStep(null);
});
$("main").addEventListener("keydown", e => {
  if (e.target.id === "noteIn" && e.key === "Enter") { e.preventDefault(); if (document.querySelector('[data-act="log"]')) act("log"); }
  const g = e.target.closest("li[data-goto]");
  if (g && e.key === "Enter") selectStep(g.dataset.goto, true);
});

// ------------------------------------------------------------------- log ----
function renderLog() {
  const box = $("logsec"), s = sel(), latest = data.log.length ? ts(data.log[data.log.length - 1].t) : 0;
  const seen = seenLog.has(data.id) ? seenLog.get(data.id) : latest;
  if (STATIC && !data.log.length) { box.innerHTML = `<div class="sechead"><h3>Running log</h3></div><div class="empty">No log in this snapshot.</div>`; return; }
  const rows = data.log.map((r, i) => ({ ...r, i })).filter(r => !s || r.step === s).slice(-200).reverse();
  box.innerHTML = `<div class="sechead"><h3>${s ? `Log · ${esc(s)}` : "Running log"}</h3><span class="muted small">${rows.length}</span>${s ? `<button class="btn ghost small" data-showall style="margin-left:auto;height:24px">All steps</button>` : ""}</div>` +
    (rows.map(r => `<div class="logrow${ts(r.t) > seen ? " fresh" : ""}"><span class="tm" title="${esc(r.t)}">${esc(clock(r.t))}</span>
      <div class="hd"><a data-goto="${esc(r.step)}">${esc(r.step)}</a>${kindBadge(r.kind)}${r.who ? `<span class="k">${esc(r.who)}</span>` : ""}</div><div class="m">${esc(r.msg)}</div></div>`).join("")
      || `<div class="empty">${s ? "Nothing logged for this step yet." : "No entries yet. Agents add them with the project's CLI."}</div>`);
  seenLog.set(data.id, Math.max(seen, latest || 0));
}

// ------------------------------------------------------- offline snapshot ----
const staticOrig = {};
const staticKey = () => "stepwise.static." + STATIC.id;
function staticDone() { try { return new Set(JSON.parse(localStorage.getItem(staticKey()) || "[]")); } catch { return new Set(); } }
function toggleStatic(id) {
  const s = staticDone();
  s.has(id) ? s.delete(id) : s.add(id);
  try { localStorage.setItem(staticKey(), JSON.stringify([...s])); } catch { /* ignore */ }
  restatus(); renderProject();
}
function restatus() {
  const local = staticDone();
  const isDone = n => staticOrig[n.id] === "done" || local.has(n.id);
  const done = new Set(data.nodes.filter(isDone).map(n => n.id));
  const c = { done: 0, progress: 0, blocked: 0, ready: 0, waiting: 0 };
  data.nodes.forEach(n => {
    const orig = staticOrig[n.id];
    n.status = done.has(n.id) ? "done" : orig === "progress" || orig === "blocked" ? orig : n.deps.every(d => done.has(d)) ? "ready" : "waiting";
    n.unmet = n.deps.filter(d => !done.has(d));
    c[n.status]++;
  });
  c.unpushed = data.nodes.filter(n => n.unpushed && n.status === "done").length;
  data.counts = { ...data.counts, ...c };
}

// -------------------------------------------------------------- controls ----
$("q").addEventListener("input", () => { query = $("q").value.trim(); if (data && data.nodes) { renderStage(); } });
$("q").addEventListener("keydown", e => {
  if (e.key === "Enter" && query && data) {
    const q = query.toLowerCase();
    const m = data.nodes.find(n => n.id.toLowerCase() === q) || data.order.map(id => byId[id]).find(n => matches(n, q));
    if (m) selectStep(m.id, true);
  }
  if (e.key === "Escape") { $("q").value = query = ""; renderStage(); $("q").blur(); }
});
$("toolbar").addEventListener("click", e => {
  const v = e.target.closest("[data-view]");
  if (v) { prefs.view[data.id] = v.dataset.view; savePrefs(); return renderProject(); }
  const f = e.target.closest("[data-filter]");
  if (f) { filter = filter === f.dataset.filter ? null : f.dataset.filter; return renderProject(); }
});
$("chiprow").addEventListener("click", e => {
  const a = e.target.closest("[data-area]");
  if (a) {
    const off = offAreas(), k = a.dataset.area;
    if (e.altKey || e.metaKey) { const keys = Object.keys(data.areas); const only = off.size === keys.length - 1 && !off.has(k); off.clear(); if (!only) keys.forEach(x => x !== k && off.add(x)); }
    else off.has(k) ? off.delete(k) : off.add(k);
    return renderProject();
  }
});
$("critBtn").onclick = () => { critOn = !critOn; renderProject(); if (critOn && graph && !sel()) fitNodes(data.critical); };
$("edgeBtn").onclick = () => { prefs.edges[data.id] = edgesOf(data.id) === "direct" ? "all" : "direct"; savePrefs(); renderProject(); };
$("zIn").onclick = () => zoomAt(1.2);
$("zOut").onclick = () => zoomAt(1 / 1.2);
$("zPct").onclick = () => fitAll();
$("dirBtn").onclick = () => { prefs.dir[data.id] = dirOf(data.id) === "LR" ? "TB" : "LR"; savePrefs(); graph = null; renderProject(); };

function bindResizer() {
  const r = $("resizer");
  r.onpointerdown = e => {
    r.setPointerCapture(e.pointerId); r.classList.add("drag");
    const move = ev => { prefs.panel = Math.round(Math.min(680, Math.max(300, innerWidth - ev.clientX))); applyPrefs(); };
    const up = () => { r.classList.remove("drag"); r.removeEventListener("pointermove", move); savePrefs(); };
    r.addEventListener("pointermove", move); r.addEventListener("pointerup", up, { once: true });
  };
  r.onkeydown = e => {
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") { prefs.panel = Math.min(680, Math.max(300, prefs.panel + (e.key === "ArrowLeft" ? 20 : -20))); applyPrefs(); savePrefs(); }
  };
}

// preferences popover
$("prefsBtn").onclick = e => {
  e.stopPropagation();
  const open = $("prefs").hidden;
  closeMenus();
  if (!open) return;
  renderPrefs(); $("prefs").hidden = false; $("prefsBtn").setAttribute("aria-expanded", "true");
};
function renderPrefs() {
  const p = route.project && data && data.nodes;
  const opt = (v, cur, l) => `<option value="${v}"${v === cur ? " selected" : ""}>${l}</option>`;
  $("prefs").innerHTML = `<h3>Appearance</h3>
    <div class="row"><label for="pTheme">Theme</label><select id="pTheme">${opt("system", prefs.theme, "System")}${opt("macchiato", prefs.theme, "Macchiato (dark)")}${opt("latte", prefs.theme, "Latte (light)")}</select></div>
    <div class="row"><label for="pDensity">Density</label><select id="pDensity">${opt("compact", prefs.density, "Compact")}${opt("comfortable", prefs.density, "Comfortable")}</select></div>
    <div class="row"><label for="pText">Text size</label><input id="pText" type="range" min="90" max="125" step="5" value="${prefs.text}"></div>
    <div class="row"><label for="pSizes">Show size estimates</label><input id="pSizes" type="checkbox"${prefs.sizes ? " checked" : ""}></div>
    <div class="row"><label for="pLegend">Show legend</label><input id="pLegend" type="checkbox"${prefs.legend ? " checked" : ""}></div>
    ${p ? `<h3>This project</h3>
    <div class="row"><label for="pDir">Graph direction</label><select id="pDir">${opt("TB", dirOf(data.id), "Top to bottom")}${opt("LR", dirOf(data.id), "Left to right")}</select></div>
    <div class="row"><label for="pEdges">On select, highlight</label><select id="pEdges">${opt("all", edgesOf(data.id), "Whole chain")}${opt("direct", edgesOf(data.id), "Direct links")}</select></div>` : ""}
    <h3>Keys</h3><div class="keys"><span class="kbd">/</span>find a step<span class="kbd">0–9</span>switch project<span class="kbd">g o t</span>graph, order, table
      <span class="kbd">f</span>fit everything<span class="kbd">c</span>critical path<span class="kbd">e</span>direct edges<span class="kbd">d</span>direction<span class="kbd">Esc</span>clear selection</div>
    <div class="btns"><button class="btn ghost" id="pReset">Reset view settings</button></div>`;
  const on = (id, ev, fn) => $(id) && $(id).addEventListener(ev, fn);
  on("pTheme", "change", e => { prefs.theme = e.target.value; savePrefs(); applyPrefs(); });
  on("pDensity", "change", e => { prefs.density = e.target.value; savePrefs(); applyPrefs(); rerenderGraph(); });
  on("pText", "input", e => { prefs.text = +e.target.value; savePrefs(); applyPrefs(); });
  on("pSizes", "change", e => { prefs.sizes = e.target.checked; savePrefs(); rerenderGraph(); });
  on("pLegend", "change", e => { prefs.legend = e.target.checked; savePrefs(); if (graph) renderLegend(); });
  on("pDir", "change", e => { prefs.dir[data.id] = e.target.value; savePrefs(); rerenderGraph(); });
  on("pEdges", "change", e => { prefs.edges[data.id] = e.target.value; savePrefs(); renderProject(); });
  on("pReset", "click", () => { prefs = { ...DEFAULTS, dir: {}, edges: {}, view: {} }; savePrefs(); applyPrefs(); renderPrefs(); rerenderGraph(); });
}
function rerenderGraph() { graph = null; if (route.project && data && data.nodes) renderProject(); }

// keyboard
addEventListener("keydown", e => {
  const typing = e.target.closest && e.target.closest("input, select, textarea, dialog");
  if (e.key === "Escape") {
    if (!$("menu").hidden || !$("prefs").hidden) return closeMenus();
    if (typing) return;
    if (sel()) return selectStep(null);
    if (filter || critOn) { filter = null; critOn = false; return renderProject(); }
    return;
  }
  if (typing || e.ctrlKey || e.metaKey || e.altKey) return;
  const inProject = route.project && data && data.nodes;
  if (e.key === "/") { if (inProject) { e.preventDefault(); $("q").focus(); $("q").select(); } return; }
  if (/^[0-9]$/.test(e.key) && !STATIC) {
    const i = +e.key;
    if (i === 0) return go(null);
    if (projects[i - 1]) return go(projects[i - 1].id);
    return;
  }
  if (!inProject) return;
  const views = { g: "graph", o: "order", t: "table" };
  if (views[e.key]) { prefs.view[data.id] = views[e.key]; savePrefs(); return renderProject(); }
  if (e.key === "c") return $("critBtn").click();
  if (e.key === "e") return $("edgeBtn").click();
  if (viewOf(data.id) !== "graph" || !graph) return;
  if (e.key === "f") return fitAll();
  if (e.key === "d") return $("dirBtn").click();
  if (e.key === "+" || e.key === "=") return zoomAt(1.2);
  if (e.key === "-") return zoomAt(1 / 1.2);
});

// --------------------------------------------------------------- toasts ----
function toast(text, err = false) {
  const t = document.createElement("div");
  t.className = "toast" + (err ? " err" : "");
  t.textContent = text;
  $("toasts").appendChild(t);
  setTimeout(() => t.remove(), err ? 6000 : 2600);
}

// ----------------------------------------------------------------- start ----
applyPrefs();
if (STATIC) {
  data = STATIC;
  byId = Object.fromEntries(data.nodes.map(n => [n.id, n]));
  data.nodes.forEach(n => staticOrig[n.id] = n.status);
  restatus();
  $("switchBtn").querySelector(".chev").style.display = "none";
  document.querySelector(".brand").removeAttribute("href");
  applyRoute();
} else {
  applyRoute();
  pollProjects();
  setInterval(pollProject, 3000);
  setInterval(pollProjects, 10000);
}
setInterval(tickLive, 1000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && !STATIC) { pollProject(); pollProjects(); } });
// keep runtimes and "ago" labels moving
setInterval(() => { if (route.project && data && data.nodes && data.counts.progress) renderPanel(); if (!route.project) renderHome(); }, 30000);
addEventListener("resize", () => { if (graph && !cams.has(data.id)) initialView(); });
// A plain mouse wheel scrolls the area chips sideways.
$("areas").addEventListener("wheel", e => {
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && $("areas").scrollWidth > $("areas").clientWidth) { e.preventDefault(); $("areas").scrollLeft += e.deltaY; }
}, { passive: false });
