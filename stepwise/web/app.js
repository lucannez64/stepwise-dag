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
// Short status words on graph nodes; the right edge always keeps room for the longest.
const SHORT = { done: "✓ done", progress: "● active", blocked: "✕ blocked", ready: "○ ready", waiting: "" };
// Green, blue, yellow and red mean status, so areas use the other accents.
const AREA_COLORS = ["teal", "sky", "lavender", "sapphire", "o2", "sub0"];

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
const phone = () => matchMedia("(max-width: 900px)").matches;
const viewOf = id => prefs.view[id] || (matchMedia("(max-width: 900px)").matches ? "order" : "graph");
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
const ago = iso => isNaN(ts(iso)) ? "–" : Date.now() - ts(iso) < 60000 ? "just now" : dur(Date.now() - ts(iso)) + " ago";
const clock = iso => {
  const d = new Date(ts(iso));
  if (isNaN(d)) return "";
  const today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })
    : d.toLocaleDateString("en-GB", { month: "short", day: "numeric" }) + " " + d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
};
const entry = id => (data && data.progress[id]) || null;
const runtime = e => e && e.started ? dur((e.finished ? ts(e.finished) : Date.now()) - ts(e.started)) : "–";
// In-progress steps: time since start when the format records it, else time since the last update.
const since = e => e && e.started ? runtime(e) : e && e.updated ? dur(Date.now() - ts(e.updated)) : "in progress";

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
    else if (!data || !data.nodes) renderProject();
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
  } catch (e) {
    if (String(e.message) === "not found") { renderProject(); return; }
    hubErr = e.message || "unreachable"; renderChrome();
    // Nothing shown yet for this project: say so instead of leaving skeletons up.
    if (route.project === id && (!data || data.id !== id)) {
      $("main").innerHTML = `<div class="state-msg"><div class="state-card"><h2>Couldn't load ${esc(id)}</h2>
        <p class="muted">${esc(hubErr)}. The hub may be stopped or this device offline.</p>
        <div class="btns" style="justify-content:center"><button class="btn primary" data-retry>Retry</button><button class="btn" onclick="location.hash='#/'">All projects</button></div></div></div>`;
    }
  }
}

let warnedStep = null;
function setData(d) {
  const sig = JSON.stringify([d.mtime, d.counts, d.progress, d.log && d.log.length, d.error, d.repo, d.problems, d.nodes && d.nodes.length]);
  const changed = !data || data.id !== d.id || sig !== data._sig;
  d._sig = sig;
  data = d;
  byId = Object.fromEntries((d.nodes || []).map(n => [n.id, n]));
  if (route.step && d.nodes && !byId[route.step] && warnedStep !== route.step) {
    warnedStep = route.step;
    toast(`No step “${route.step}” in ${d.title}`, true);
    history.replaceState(null, "", "#/" + encodeURIComponent(d.id));
    route.step = null;
  }
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
  const stepChanged = r.step !== route.step;
  route = r;
  closeMenus();
  hideTip(); hovered = null;
  if (switched) {
    filter = null; critOn = false; query = ""; $("q").value = "";
    if (route.project) {
      if (!data || data.id !== route.project) { data = null; byId = {}; graph = null; }
      renderProject(); pollProject();
    } else { data = null; byId = {}; graph = null; renderHome(); pollProjects(); }
  } else if (route.project) {
    renderProject(true);
    // A step chosen from the address bar or a link: bring it into view.
    if (stepChanged && !internalNav && route.step && graph) frameStep(route.step);
  }
}
addEventListener("hashchange", applyRoute);
addEventListener("popstate", applyRoute);

let internalNav = false;
function selectStep(id, center = false) {
  if (!route.project) return;
  if (id && !byId[id]) return;
  internalNav = true;
  go(route.project, id, false);
  internalNav = false;
  if (id && viewOf(route.project) === "graph" && graph) frameStep(id);
}

// ------------------------------------------------------------- top chrome --
function stackBar(c, cls = "stack") {
  const t = c.total || 1;
  const seg = (n, col) => n ? `<i style="width:${(100 * n / t).toFixed(2)}%;background:${col === "ready" ? "color-mix(in srgb, var(--ready) 55%, var(--s0))" : `var(--${col})`}"></i>` : "";
  // "done" is always the first segment, so only it shows at full strength.
  return `<span class="${cls}"><i style="width:${(100 * (c.done || 0) / t).toFixed(2)}%;background:var(--done)"></i>${seg(c.progress, "progress")}${seg(c.blocked, "blocked")}${seg(c.ready, "ready")}</span>`;
}
function statusDot(p) { return !p || p.loading ? "" : p.error ? (p.nodes || p.counts ? "stale" : "err") : "ok"; }

function renderChrome() {
  const home = !route.project;
  $("app").classList.toggle("home", home);
  $("toolbar").hidden = home || !data || !data.nodes;
  $("legend").hidden = home || !data || !data.nodes || !prefs.legend || viewOf(route.project) !== "graph";
  // switcher label
  const cur = home ? null : (data && data.id === route.project ? data : projects.find(p => p.id === route.project));
  const unknown = !home && projects.length && !projects.some(p => p.id === route.project);
  $("switchName").textContent = home || unknown ? "All projects" : (cur ? cur.title : route.project);
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
      <div class="stat waiting"><b>${c.waiting}</b><span>waiting</span></div>
      ${c.unpushed ? `<div class="stat unpushed" title="Done, but the recorded commit is not on the upstream branch yet"><b>${c.unpushed}</b><span>not pushed</span></div>` : ""}
      ${c.retries ? `<div class="stat retries"><b>${c.retries}</b><span>${c.retries === 1 ? "retry" : "retries"}</span></div>` : ""}`;
  } else $("stats").innerHTML = "";
  // facts
  if (!home && data && data.nodes) {
    const ld = a => a ? a.slice(0, 3).map(x => x.toFixed(2)).join(" ") : "–";
    const r = data.repo;
    const cores = a => a && a[3] ? `${a[3]} cores` : "";
    // A status bar, like an editor's: machine first, then git.
    $("facts").innerHTML = `
      <span class="fact" title="Load average on ${esc(data.machine || data.host)} (${cores(data.load)})"><span>${esc(data.machine || data.host)} load</span><b>${ld(data.load)}</b></span>
      ${data.box_host ? `<span class="fact" title="Build box ${esc(data.box_host)} ${cores(data.box)}"><span>box load</span><b>${data.box ? ld(data.box) : "offline"}</b></span>` : ""}
      ${r ? `<span class="fact" title="HEAD / ${esc(r.upstream || "no upstream")} (local tracking refs, no fetch)"><svg width="12" height="12" viewBox="0 0 16 16" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="4" cy="3.5" r="1.8"/><circle cx="4" cy="12.5" r="1.8"/><circle cx="12" cy="6" r="1.8"/><path d="M4 5.3v5.4M12 7.8c0 2.5-3 2.7-6.2 4"/></g></svg><span class="br">${esc(r.branch || "HEAD")}</span><b>${esc(r.head || "?")}</b><span>/ ${esc(r.origin || "?")}</span></span>
      <span class="fact ${r.dirty ? "warn" : ""}" title="Commits ahead of ${esc(r.upstream || "upstream")}"><b>↑${r.ahead ?? "–"}</b>${r.dirty ? "<span>dirty</span>" : ""}</span>
      <span class="fact" title="Git worktrees"><b>${r.worktrees}</b><span>worktrees</span></span>` : ""}`;
  } else $("facts").innerHTML = "";
  tickLive();
  renderBanner();
}
function renderBanner() {
  const home = !route.project, b = $("banner");
  b.classList.toggle("bad", false);
  if (!STATIC && hubErr && Date.now() - hubOk > 8000) {
    b.hidden = false; b.classList.add("bad");
    const when = lastFetch ? new Date(lastFetch).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }) : "";
    b.innerHTML = `<b>Connection lost</b> · ${when ? `showing data from ${esc(when)}` : "nothing loaded yet"}. <button class="btn small" data-reconnect>Retry</button>`;
    return;
  }
  if (STATIC) {
    b.hidden = false;
    b.innerHTML = `Offline snapshot of <b>${esc(STATIC.title)}</b> from ${esc(new Date(STATIC.exported).toLocaleString("en-GB", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }))}. Done marks you set here stay in this browser only.`;
  } else if (!home && data && data.error && data.nodes) {
    b.hidden = false;
    b.innerHTML = `Showing data from ${esc(dur((data.age || 0) * 1000 + (Date.now() - lastFetch)))} ago: ${esc(data.error)}`;
  } else b.hidden = true;
}

function tickLive() {
  const el = $("live"), t = $("liveT");
  if (STATIC) { el.className = "live"; t.textContent = "snapshot"; return; }
  if (hubErr && Date.now() - hubOk > 8000) { el.className = "live err"; t.textContent = "hub unreachable"; if ($("banner").hidden) renderBanner(); return; }
  if (hubErr && route.project && (!data || data.id !== route.project)) { el.className = "live err"; t.textContent = "project unavailable"; return; }
  if (!$("banner").hidden && $("banner").classList.contains("bad")) renderBanner();
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
  $("areaMenu").hidden = true; $("areaBtn").setAttribute("aria-expanded", "false");
  $("prefs").hidden = true; $("prefsBtn").setAttribute("aria-expanded", "false");
}
// Use the path from when the click happened: a popover may have redrawn and detached the clicked button since.
document.addEventListener("click", e => { if (!e.composedPath().some(el => el instanceof Element && el.matches("#menu, #prefs, #switchBtn, #prefsBtn, #areaMenu, #areaBtn"))) closeMenus(); });

// ------------------------------------------------------------------ home ----
// Every home card has the same ten rows, so sections line up across a row of cards.
const SLOT = '<div class="slot"></div>';
// Activity entries the reader expanded stay expanded across refreshes.
const feedOpen = new Set();
$("main").addEventListener("click", e => {
  const m = e.target.closest(".feed .logrow .m"); if (!m) return;
  const row = m.parentNode, k = row.dataset.k;
  feedOpen.has(k) ? feedOpen.delete(k) : feedOpen.add(k);
  row.classList.toggle("open", feedOpen.has(k));
});
function renderHome() {
  parkBar();
  renderChrome();
  const main = $("main");
  if (!$("cards") || !$("feed")) main.innerHTML = `<div class="homegrid"><div class="cards" id="cards"></div><aside class="feed" id="feed"></aside></div>`;
  if (!projects.length) { $("cards").innerHTML = hubErr ? `<div class="errbox">Cannot reach the hub: ${esc(hubErr)}</div>` : `<div class="card skel"></div><div class="card skel"></div>`; $("feed").innerHTML = ""; return; }
  $("cards").innerHTML = projects.map((p, i) => {
    const c = p.counts;
    if (!c) return `<article class="card" tabindex="0" data-go="${esc(p.id)}"><div class="top"><div><h2>${esc(p.title)}</h2><div class="where">${esc(p.host)}</div></div>${i < 9 ? `<span class="kbd">${i + 1}</span>` : ""}</div>
      <div class="${p.loading ? "empty" : "errbox"}">${p.loading ? "Loading…" : esc(p.error)}</div></article>`;
    const pct = c.total ? Math.round(100 * c.done / c.total) : 0;
    const active = p.active.map(a => `<li><span class="dot ${a.status}"></span><span class="t"><span class="id">${esc(a.id)}</span> ${esc(a.title)}</span><span class="s">${a.status === "blocked" ? "blocked" : since(a)}</span></li>`).join("");
    const ready = p.ready.slice(0, p.active.length ? 3 : 4).map(a => `<li><span class="dot ready"></span><span class="t"><span class="id">${esc(a.id)}</span> ${esc(a.title)}</span><span></span></li>`).join("");
    const r = p.repo;
    const sw = (col, n, l) => `<span><i class="sw" style="background:var(--${col})"></i><b>${n}</b> ${l}</span>`;
    return `<article class="card" tabindex="0" data-go="${esc(p.id)}" aria-label="Open ${esc(p.title)}">
      <div class="top"><div><h2>${esc(p.title)}</h2><div class="where"><i class="dotp ${statusDot(p)}"></i>${esc(p.machine || p.host)}${p.error ? ` · <span style="color:var(--yellow)">stale</span>` : ""}</div></div>${i < 9 ? `<span class="kbd" title="Press ${i + 1} to open">${i + 1}</span>` : ""}</div>
      <div class="big"><b>${pct}%</b><span>${c.done} of ${c.total} steps done</span></div>
      ${stackBar(c)}
      <div class="counts">${sw("progress", c.progress, "in progress")}${c.blocked ? sw("blocked", c.blocked, "blocked") : ""}${sw("ready", c.ready, "ready")}<span><i class="sw" style="background:var(--s1)"></i><b>${c.waiting}</b> waiting</span>${c.unpushed ? sw("peach", c.unpushed, "not pushed") : ""}</div>
      ${p.problems && p.problems.length ? `<div class="errbox slot-problems">${p.problems.length} plan problem${p.problems.length > 1 ? "s" : ""}: ${esc(p.problems[0])}</div>` : SLOT}
      ${p.active.length ? `<div class="sec-active"><h3>In progress</h3><ul>${active}</ul></div>` : SLOT}
      ${ready ? `<details class="sec-ready"${phone() ? "" : " open"}><summary><h3>${phone() ? `Show next steps · ${p.ready.length}` : "Ready next"}</h3></summary><ul>${ready}</ul></details>`
        : p.active.length ? SLOT : '<div class="empty">Nothing ready</div>'}
      ${p.critical && p.critical.total ? `<div class="crit-line"><span class="muted small">${p.critical.computed ? "Longest chain" : "Critical path"}</span>${stackBar({ done: p.critical.done, total: p.critical.total, progress: 0, blocked: 0, ready: 0 }, "stack thin")}<span class="small"><b>${p.critical.done}</b>/${p.critical.total}</span></div>` : SLOT}
      ${p.log && p.log.length ? `<div class="last small"><span class="muted">Last activity</span> ${esc(ago(p.log[p.log.length - 1].t))} · <span class="mono">${esc(p.log[p.log.length - 1].step)}</span> ${esc(p.log[p.log.length - 1].msg.slice(0, 200))}</div>` : SLOT}
      <div class="foot">${r ? `<span><b>${esc(r.head || "?")}</b> ${esc(r.branch || "")}</span><span><b>${r.ahead ?? "–"}</b> ahead${r.dirty ? " · dirty" : ""}</span>` : ""}${p.load ? `<span>load <b>${p.load[0].toFixed(2)}</b></span>` : ""}${p.box ? `<span>box <b>${p.box[0].toFixed(2)}</b></span>` : ""}</div>
    </article>`;
  }).join("");
  const feed = projects.flatMap(p => (p.log || []).map(e => ({ ...e, p }))).sort((a, b) => ts(b.t) - ts(a.t)).slice(0, 60);
  let day = "";
  $("feed").innerHTML = `<div class="sechead"><h3>Recent activity</h3></div>` + (feed.map(e => {
    const d = new Date(ts(e.t)), label = isNaN(d) ? "" : d.toDateString() === new Date().toDateString() ? "Today" : d.toLocaleDateString("en-GB", { weekday: "long", month: "short", day: "numeric" });
    const head = label !== day ? `<div class="dayhead">${esc(day = label)}</div>` : "";
    const k = e.p.id + "|" + e.t + "|" + e.step;
    return head + `<div class="logrow${feedOpen.has(k) ? " open" : ""}" data-k="${esc(k)}"><span class="tm">${esc(isNaN(d) ? "" : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" }))}</span><div class="hd"><span class="proj">${esc(e.p.title)}</span><a data-go="${esc(e.p.id)}" data-step="${esc(e.step)}">${esc(e.step)}</a>${kindBadge(e.kind)}${e.who && e.who !== "dashboard" ? `<span class="k">${esc(e.who)}</span>` : ""}</div><div class="m">${esc(e.msg)}</div></div>`;
  }).join("") || '<div class="empty">No activity yet.</div>');
}
$("main").addEventListener("click", e => {
  if (route.project) return;
  const a = e.target.closest("[data-step]");
  if (a) { e.stopPropagation(); return go(a.dataset.go, a.dataset.step); }
  if (e.target.closest("summary, details, a, button:not(.card)")) return;
  const c = e.target.closest(".card[data-go]");
  if (c) go(c.dataset.go);
});
$("main").addEventListener("click", e => { if (e.target.closest("[data-retry]")) { $("main").innerHTML = ""; renderProject(); pollProject(); } });
$("main").addEventListener("keydown", e => { const c = e.target.closest(".card[data-go]"); if (c && e.key === "Enter") go(c.dataset.go); });
const kindBadge = k => k ? `<span class="kind ${esc(k)}">${esc(k === "undo" ? "reset" : k)}</span>` : "";

// --------------------------------------------------------------- project ----
function renderProject(routeOnly = false) {
  parkBar();
  renderChrome();
  const main = $("main");
  if (projects.length && !projects.some(p => p.id === route.project)) {
    main.innerHTML = `<div class="state-msg"><div class="state-card"><h2>No project named “${esc(route.project)}”</h2>
      <p class="muted">It may have been renamed or removed from hub.json.</p><button class="btn" onclick="location.hash='#/'">See all projects</button></div></div>`;
    return;
  }
  if (!data || data.id !== route.project) {
    main.innerHTML = `<div class="loading" aria-busy="true" aria-label="Loading ${esc(route.project)}"><div class="skel-graph">${Array.from({ length: 18 }, (_, i) => `<i style="animation-delay:${(i % 6) * 80}ms"></i>`).join("")}</div><div class="skel-side"><i></i><i></i><i></i><i></i></div></div>`;
    return;
  }
  if (!data.nodes) {
    main.innerHTML = `<div class="state-msg"><div class="state-card">
      <svg width="40" height="40" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><path d="M2 8.5a15 15 0 0 1 20 0M5.5 12a10 10 0 0 1 13 0M9 15.5a5 5 0 0 1 6 0"/><path d="M3 3l18 18"/><circle cx="12" cy="19" r="1" fill="currentColor"/></g></svg>
      <h2>Can't read ${esc(data.title)} right now</h2>
      <p class="muted">${esc(data.error || "Not loaded yet")}</p>
      <p class="muted small">The plan lives on ${esc(data.host)}. The hub keeps retrying every few seconds and this page updates by itself. If the machine has another route (say its Tailscale name), list both under <code>host</code> in hub.json.</p>
      <button class="btn" onclick="location.hash='#/'">Back to all projects</button></div></div>`;
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
  document.querySelectorAll("[data-filter]").forEach(b => b.setAttribute("aria-pressed", (filter || "") === b.dataset.filter));
  $("critBtn").setAttribute("aria-pressed", critOn);
  $("critBtn").lastChild.textContent = data.critical_computed ? "Longest chain" : "Critical path";
  $("critBtn").title = data.critical_computed ? "Longest chain of steps (computed: counts steps, not time) (c)" : "Critical path from the plan (c)";
  $("edgeBtn").setAttribute("aria-pressed", edgesOf(data.id) === "direct");
  const v = viewOf(data.id);
  document.querySelectorAll("[data-view]").forEach(b => b.setAttribute("aria-pressed", b.dataset.view === v));
  $("zFocus").textContent = sel() ? "Fit related" : "Focus active";
  $("zFocus").title = sel() ? "Fit the selected step and its direct links (w)" : "Focus the work in progress (w)";
  const nf = (filter ? 1 : 0) + (critOn ? 1 : 0) + (offAreas().size ? 1 : 0);
  $("moreBtn").innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 4h12M4 8h8M6.5 12h3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg><span class="lbl">Filters</span>${nf ? `<span class="badge">${nf}</span>` : ""}`;
  $("moreBtn").setAttribute("aria-label", nf ? `Filters, ${nf} active` : "Filters");
  const act = activeSteps();
  $("actNav").hidden = v !== "graph" || act.length < 2;
  $("actPos").textContent = `${Math.min(activeIdx, act.length - 1) + 1} / ${act.length}`;
  $("zoomCtl").hidden = v !== "graph"; $("dirBtn").hidden = v !== "graph"; $("edgeBtn").hidden = v !== "graph"; $("ctxBtn").hidden = v !== "graph";
  const lr = dirOf(data.id) === "LR";
  $("dirBtn").innerHTML = lr
    ? `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="2" y="9" width="6" height="6" rx="1.5"/><rect x="16" y="4" width="6" height="6" rx="1.5"/><rect x="16" y="14" width="6" height="6" rx="1.5"/><path d="M8 12h4m0 0c2 0 2-5 4-5m-4 5c2 0 2 5 4 5"/></g></svg>`
    : `<svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><g fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"><rect x="9" y="2" width="6" height="6" rx="1.5"/><rect x="4" y="16" width="6" height="6" rx="1.5"/><rect x="14" y="16" width="6" height="6" rx="1.5"/><path d="M12 8v4m0 0c0 2-5 2-5 4m5-4c0 2 5 2 5 4"/></g></svg>`;
  $("dirBtn").title = (lr ? "Left to right" : "Top to bottom") + " · switch direction (d)";
  const off = offAreas(), keys = Object.keys(data.areas);
  $("areaPick").hidden = keys.length < 2;
  const shown = keys.length - [...off].filter(a => keys.includes(a)).length;
  $("areaLbl").innerHTML = shown === keys.length ? "Areas" : `Areas <span class="n">${shown}/${keys.length}</span>`;
  $("areaBtn").setAttribute("aria-pressed", shown !== keys.length);
  $("areaMenu").innerHTML = `<div class="amhead"><b>Areas</b><button class="btn ghost small" data-area-all>Show all</button></div>` +
    keys.map(a => `<label class="aitem"><input type="checkbox" data-area="${esc(a)}"${off.has(a) ? "" : " checked"}><i class="sw" style="background:${areaColor(a)}"></i><span class="t">${esc(a === data.areas[a] || !a ? data.areas[a] : a + " · " + data.areas[a])}</span><span class="n">${data.nodes.filter(n => n.area === a).length}</span><button class="only" data-area-only="${esc(a)}" title="Show only this area">only</button></label>`).join("");
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
  const q = query.toLowerCase(), off = offAreas(), f = q ? null : focusSets(), crit = new Set(data.critical), s = q ? null : sel();
  const out = {};
  for (const n of data.nodes) {
    const match = !!q && matches(n, q);
    const related = !f || viewOf(data.id) !== "graph" || n.id === s || f.up.has(n.id) || f.down.has(n.id);
    // Every active filter dims what it excludes, as both original dashboards did.
    const excluded = n.id !== s && (off.has(n.area) || (filter && n.status !== filter) || (critOn && !crit.has(n.id)) || (q && !match));
    out[n.id] = { dim: !related || excluded, excluded, match };
  }
  return { vis: out, f, crit };
}

// ----------------------------------------------------------------- stage ----
function renderStage(routeOnly) {
  hideTip();
  if (viewOf(data.id) !== "graph" || !graph) parkBar();
  const stage = $("stage"), v = viewOf(data.id);
  stage.classList.remove("graph", "order", "table"); stage.classList.add("stage", v);
  if (v === "graph") {
    const sig = layoutSig();
    if (!graph || graph.sig !== sig || !stage.querySelector("svg.g")) buildGraph(sig);
    updateGraph();
    // Partial redraws keep the old canvas, so make sure its controls are back on it.
    if (canvasBar().parentNode !== stage) stage.appendChild(canvasBar());
    keepFramed();
    requestAnimationFrame(() => keepFramed());
  } else {
    graph = null;
    if (v === "order") renderOrder(); else renderTable();
  }
  const q = query.toLowerCase();
  const allVis = visibility().vis;
  const n = q ? data.nodes.filter(x => !allVis[x.id].excluded).length : 0;
  $("qCount").hidden = !q; $("qClear").hidden = !q; $("qKbd").hidden = !!q; $("qCount").textContent = q ? `${n}` : "";
  $("qCount").title = q ? `${n} step${n === 1 ? "" : "s"} match` : "";
  let nm = $("stage").querySelector(".nomatch");
  const anyShown = data.nodes.some(x => !allVis[x.id].excluded);
  const empty = v === "graph" && narrowing() && !anyShown;
  $("stage").classList.toggle("empty", empty);
  if (empty) {
    if (!nm) { nm = document.createElement("div"); nm.className = "nomatch"; $("stage").appendChild(nm); }
    nm.innerHTML = emptyHtml();
  } else nm?.remove();
}

// One wording for "nothing matches", naming what is active and offering both ways out.
function emptyHtml() {
  const what = filter ? LABEL[filter] + " steps" : critOn ? "steps on the " + (data.critical_computed ? "longest chain" : "critical path") : "steps";
  const btns = [query && `<button class="btn" data-clear-q>Clear search</button>`, (filter || critOn || offAreas().size) && `<button class="btn" data-reset-filters>Clear filters</button>`].filter(Boolean).join("");
  return `<h2>No ${esc(what)} match${query ? ` “${esc(query)}”` : ""}</h2><div class="btns" style="justify-content:center">${btns}</div>`;
}
const narrowing = () => !!(filter || critOn || query || offAreas().size);
// With a filter on, the graph lays out only the matching steps, compactly; "Keep layout" shows them in place.
function layoutNodes() {
  if (!narrowing() || showContext) return data.nodes;
  const { vis } = visibility();
  return data.nodes.filter(n => !vis[n.id].excluded);
}
function layoutSig() {
  const ln = layoutNodes();
  return JSON.stringify([data.id, dirOf(data.id), prefs.density, prefs.sizes, prefs.text, ln.length === data.nodes.length ? null : ln.map(n => n.id), data.nodes.map(n => [n.id, n.deps, n.level, n.order, n.area])]);
}

const measure = (() => {
  const ctx = document.createElement("canvas").getContext("2d");
  const sans = getComputedStyle(document.documentElement).getPropertyValue("--sans") || "system-ui";
  return (text, size = 11, weight = 400) => { ctx.font = `${weight} ${size}px ${sans}`; return ctx.measureText(text).width; };
})();
const monoW = (s, size) => s.length * size * 0.6;
function wrap2(text, width, size = 11) {
  const words = text.split(/\s+/), m = t => measure(t, size);
  let a = "", i = 0;
  for (; i < words.length; i++) { const t = (a ? a + " " : "") + words[i]; if (m(t) > width && a) break; a = t; }
  let b = words.slice(i).join(" ");
  if (m(a) > width) { while (a.length > 1 && m(a + "…") > width) a = a.slice(0, -1); a += "…"; }
  if (b && m(b) > width) { while (b.length > 1 && m(b + "…") > width) b = b.slice(0, -1); b += "…"; }
  return [a, b];
}

function buildGraph(sig) {
  const stage = $("stage");
  const comfy = prefs.density === "comfortable";
  const G = prefs.text / 100;  // text size scales the cards too
  const W = Math.round((comfy ? 296 : 280) * G), H = Math.round((comfy ? 98 : 92) * G);
  const lr = dirOf(data.id) === "LR";
  const GAPX = lr ? 84 : 22, GAPY = lr ? 12 : 58;
  // layers by level, ordered by area then dependency order, then barycenter sweeps
  const levels = [];
  const LN = layoutNodes(), inSet = new Set(LN.map(n => n.id));
  const lvls = [...new Set(LN.map(n => n.level))].sort((a, b) => a - b), rank = Object.fromEntries(lvls.map((l, i) => [l, i]));
  const depsOf = n => n.deps.filter(d => inSet.has(d)), usersOf = n => n.users.filter(u => inSet.has(u));
  LN.forEach(n => (levels[rank[n.level]] ||= []).push(n));
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
      l.forEach(n => b[n.id] = bary(n, down ? depsOf(n) : usersOf(n)));
      l.sort((x, y) => b[x.id] - b[y.id]);
      l.forEach((n, i) => r[n.id] = i);
    }
  }
  // Wide levels wrap into bands (rows of 10 top to bottom, columns of 14 left to right),
  // so "fit" stays readable on plans with many independent steps.
  const SUB = lr ? 20 : 16, TOP = 44, LEFT = 60;
  // Pick the band size whose overall shape best matches the stage, so "fit" stays as large as possible.
  const longest = Math.max(1, ...levels.map(l => l.length));
  const sr = $("stage").getBoundingClientRect();
  const shape = wrap => {
    const along = levels.reduce((t, l) => t + (l.length ? Math.ceil(l.length / wrap) * ((lr ? W : H) + SUB) - SUB + (lr ? GAPX : GAPY) : 0), 24);
    const side = (lr ? TOP : LEFT) + Math.min(wrap, longest) * (lr ? H + GAPY : W + GAPX) + 24;
    return lr ? [along, side] : [side, along];
  };
  let WRAP = longest, best = 0;
  for (let w = 3; w <= longest; w++) {
    const [ww, hh] = shape(w), k = Math.min((sr.width || 1200) / ww, (sr.height || 800) / hh);
    if (k > best + 1e-3) { best = k; WRAP = w; }
  }
  const across = Math.max(1, Math.min(WRAP, longest));
  const pos = {}, starts = [];
  let cursor = lr ? 24 : 24;
  levels.forEach((l, li) => {
    starts[li] = cursor;
    if (!l.length) return;
    const bands = [];
    for (let i = 0; i < l.length; i += WRAP) bands.push(l.slice(i, i + WRAP));
    bands.forEach((band, bi) => band.forEach((n, i) => {
      // Shorter columns sit centred against the tallest, as in the original VELA view.
      if (lr) pos[n.id] = { x: cursor + bi * (W + SUB), y: TOP + (across - band.length) * (H + GAPY) / 2 + i * (H + GAPY) };
      else pos[n.id] = { x: LEFT + (across - band.length) * (W + GAPX) / 2 + i * (W + GAPX), y: cursor + bi * (H + SUB) };
    }));
    cursor += bands.length * ((lr ? W : H) + SUB) - SUB + (lr ? GAPX : GAPY);
  });
  const worldW = lr ? cursor : LEFT + across * (W + GAPX) + 24;
  const worldH = lr ? TOP + across * (H + GAPY) + 24 : cursor;

  stage.innerHTML = `<div class="dotgrid"></div>`;
  stage.appendChild(canvasBar());
  canvasBar().hidden = !layoutNodes().length;
  const svg = svgEl("svg", { class: "g", role: "application", "aria-label": `${data.title} dependency graph`, style: `--gs:${G}` }, stage);
  const vp = svgEl("g", {}, svg);
  const defs = svgEl("defs", {}, svg);
  for (const k of ["def", "up", "down", "crit"]) {
    const m = svgEl("marker", { id: "m-" + k, viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse", markerUnits: "userSpaceOnUse" }, defs);
    svgEl("path", { d: "M0,1 L10,5 L0,9 z", class: "mk mk-" + k }, m);
  }
  const gL = svgEl("g", {}, vp), gE = svgEl("g", {}, vp), gN = svgEl("g", {}, vp);
  levels.forEach((l, li) => {
    if (!l.length) return;
    const t = lr ? svgEl("text", { class: "lvl", x: starts[li], y: 26 }, gL) : svgEl("text", { class: "lvl", x: LEFT - 12, y: starts[li] + H / 2 + 4, "text-anchor": "end" }, gL);
    t.textContent = "L" + lvls[li];
    const done = l.filter(n => n.status === "done").length;
    // Counts fit beside a row label; columns are too narrow, so they get a second line.
    if (lr) svgEl("tspan", { class: "lvlc", x: starts[li], dy: "1.2em" }, t).textContent = `${done}/${l.length}`;
    else svgEl("tspan", { class: "lvlc" }, t).textContent = `\u00a0\u00a0${done}/${l.length}`;
  });
  const edges = [];
  for (const n of LN) for (const d of depsOf(n)) {
    const a = pos[d], b = pos[n.id];
    let p;
    // Bend points vary a little per edge, so parallel links fan out instead of stacking.
    const fan = 0.36 + 0.28 * ((edges.length * 7) % 5) / 4;
    if (lr) { const x1 = a.x + W, y1 = a.y + H / 2, x2 = b.x, y2 = b.y + H / 2, c = Math.max(28, (x2 - x1) * fan); p = `M${x1},${y1} C${x1 + c},${y1} ${x2 - c},${y2} ${x2},${y2}`; }
    else { const x1 = a.x + W / 2, y1 = a.y + H, x2 = b.x + W / 2, y2 = b.y, c = Math.max(24, (y2 - y1) / 2); p = `M${x1},${y1} C${x1},${y1 + c} ${x2},${y2 - c} ${x2},${y2}`; }
    edges.push({ from: d, to: n.id, el: svgEl("path", { class: "edge", d: p }, gE) });
  }
  const els = {};
  for (const n of LN) {
    const { x, y } = pos[n.id];
    const g = svgEl("g", { class: "node", transform: `translate(${x},${y})`, tabindex: 0, role: "button", "data-id": n.id }, gN);
    svgEl("rect", { class: "pulse", width: W, height: H, rx: 7 }, g);
    svgEl("rect", { class: "box", width: W, height: H, rx: 7 }, g);
    svgEl("rect", { x: 4, y: 6, width: 3, height: H - 12, rx: 1.5, fill: areaColor(n.area) }, g);
    // Row 1: order and the full id. Rows 2-3: title. Bottom row: size, hard, status.
    let cx = 14;
    const ord = svgEl("text", { class: "ord", x: cx, y: 20 * G }, g); ord.textContent = "#" + n.order; cx += monoW(ord.textContent, 11 * G) + 6;
    const idt = svgEl("text", { class: "id", x: cx, y: 20 * G }, g);
    const room = W - 10 - cx;
    let id = n.id;
    if (monoW(id, 13.5 * G) > room) { while (id.length > 3 && monoW(id + "…", 13.5 * G) > room) id = id.slice(0, -1); id += "…"; }
    idt.textContent = id;
    const [l1, l2] = wrap2(n.title, W - 24, 14 * G);
    svgEl("text", { class: "tt", x: 14, y: 41 * G }, g).textContent = l1;
    if (l2) svgEl("text", { class: "tt tt2", x: 14, y: 58 * G }, g).textContent = l2;
    const by = H - 10 * G;
    let bx = 14;
    if (prefs.sizes && n.size) { svgEl("text", { class: "tag", x: bx, y: by }, g).textContent = n.size; bx += monoW(n.size, 12 * G) + 8; }
    if (n.hard) svgEl("text", { class: "hard", x: bx, y: by }, g).textContent = "hard";
    const st = svgEl("text", { class: "st", x: W - 9, y: by, "text-anchor": "end" }, g);
    // Far zoom shows only a large id, centred.
    let big = n.id;
    while (big.length > 3 && monoW(big, 26) > W - 16) big = big.slice(0, -2) + "…";
    svgEl("text", { class: "farid", x: W / 2, y: H / 2 + 8, "text-anchor": "middle", style: `--fmax:${(W - 16) / (Math.max(3, big.length) * 0.62)}px` }, g).textContent = big;
    els[n.id] = { g, st };
  }
  graph = { sig, svg, vp, edges, els, pos, W, H, worldW, worldH, lr };
  const mm = document.createElement("div");
  mm.hidden = !LN.length;
  mm.className = "minimap"; mm.title = "Overview: click to move there";
  mm.innerHTML = `<button class="mmtog" aria-label="Show or hide the overview map" title="Show or hide the map">▾</button><canvas></canvas>`;
  mm.querySelector(".mmtog").addEventListener("pointerdown", e => { e.stopPropagation(); prefs.miniOff = !miniOff(); savePrefs(); drawMinimap(); });
  mm.addEventListener("pointerdown", e => {
    e.stopPropagation();
    if (miniOff()) return;
    const b = mm.querySelector("canvas").getBoundingClientRect(), r = stage.getBoundingClientRect(), c = cams.get(data.id);
    const wx = (e.clientX - b.left) / graph.mini.sc, wy = (e.clientY - b.top) / graph.mini.sc;
    setCam(c.k, r.width / 2 - wx * c.k, r.height / 2 - wy * c.k);
  });
  stage.appendChild(mm);
  bindGraph(svg);
  const cam = cams.get(data.id);
  if (cam && cam.sig === sig) { applyCam(); ensureVisible(); }
  else if (LN.length !== data.nodes.length) fitNodes(LN.map(n => n.id), 1, 1);
  else initialView();
  graph.lastR = stage.getBoundingClientRect();
}

function updateGraph() {
  const { vis, f, crit } = visibility();
  const s = sel();
  const actIds = new Set(data.nodes.filter(n => n.status === "progress" || n.status === "blocked").map(n => n.id));
  const critEdges = new Set(data.critical.slice(1).map((id, i) => data.critical[i] + ">" + id));
  for (const n of data.nodes) {
    const e = graph.els[n.id];
    if (!e) continue;
    const v = vis[n.id];
    e.g.setAttribute("class", `node ${n.status}${n.unpushed ? " unpushed" : ""}${n.id === s ? " sel" : ""}${v.match ? " match" : ""}${v.dim ? " dim" : ""}${v.excluded ? " ex" : ""}`);
    e.g.setAttribute("aria-label", `${n.id}: ${n.title}. ${LABEL[n.status]}${n.unpushed ? ", not pushed" : ""}.`);
    e.st.textContent = n.unpushed ? "↑ unpushed" : SHORT[n.status];
    e.st.setAttribute("class", `st st-${n.status}`);
  }
  for (const e of graph.edges) {
    let cls = "edge";
    if (f) {
      if (f.direct) cls += e.to === s && f.up.has(e.from) ? " up" : e.from === s && f.down.has(e.to) ? " down" : " dim";
      else cls += (e.to === s || f.up.has(e.to)) && f.up.has(e.from) ? " up" : (e.from === s || f.down.has(e.from)) && f.down.has(e.to) ? " down" : " dim";
    } else if (critOn) cls += critEdges.has(e.from + ">" + e.to) ? " crit" : " dim";
    else if (vis[e.from].dim || vis[e.to].dim) cls += " dim";
    else if (!narrowing() && !s) cls += (actIds.has(e.from) || actIds.has(e.to)) ? " act" : " quiet";
    if (vis[e.from].excluded || vis[e.to].excluded) cls += " ex";
    e.el.setAttribute("class", cls);
  }
  graph.svg.classList.toggle("hide-ex", narrowing() && !showContext);
  let key = canvasBar().querySelector(".edgekey");
  if (s && !query) {
    if (!key) { key = document.createElement("div"); key.className = "edgekey"; canvasBar().appendChild(key); }
    key.innerHTML = `<span><i style="border-color:var(--needs)"></i>needs (before ${esc(s)})</span><span><i style="border-color:var(--unblocks)"></i>unblocks (after ${esc(s)})</span>`;
  } else key?.remove();
  $("ctxBtn").disabled = !narrowing();
  $("ctxBtn").title = narrowing() ? "Keep every step in its usual place and fade the ones the filters leave out" : "Turn on a filter or search first";
  $("ctxBtn").setAttribute("aria-pressed", showContext);
  edgePills();
  renderLegend();
}
let showContext = false;

function renderLegend() {
  const lg = $("legend");
  lg.hidden = !prefs.legend || !route.project || viewOf(route.project) !== "graph";
  if (lg.hidden) return;
  const sw = (fill, stroke, dash) => `<i class="sw" style="background:color-mix(in srgb, var(--${fill}) 22%, var(--base));border-color:var(--${stroke});${dash ? "border-style:dashed" : ""}"></i>`;
  lg.classList.toggle("open", keyOpen);
  lg.innerHTML = `<button class="keybtn" aria-expanded="${keyOpen}" aria-controls="legendKeys">Status key</button><span class="keys" id="legendKeys"><span class="k">${sw("done", "done")}done</span><span class="k">${sw("done", "peach", 1)}not pushed</span>
    <span class="k">${sw("progress", "progress")}in progress</span><span class="k">${sw("blocked", "blocked")}blocked</span>
    <span class="k">${sw("ready", "ready")}ready</span><span class="k">${sw("s0", "s1")}waiting</span>
    <span class="k"><i class="ln" style="border-color:var(--needs)"></i>needs</span><span class="k"><i class="ln" style="border-color:var(--unblocks)"></i>unblocks</span>
    ${critOn ? `<span class="k"><i class="ln" style="border-color:var(--crit)"></i>${data.critical_computed ? "longest chain" : "critical path"}</span>` : ""}</span>`;
  if (keyOpen) lg.style.setProperty("--keyx", lg.querySelector(".keybtn").getBoundingClientRect().left + "px");
}
// On laptops the key folds into a button; it opens above the status bar.
let keyOpen = false;
function setKey(open) { keyOpen = open; renderLegend(); }
$("legend").addEventListener("click", e => { if (e.target.closest(".keybtn")) setKey(!keyOpen); });
document.addEventListener("pointerdown", e => { if (keyOpen && !e.target.closest("#legend")) setKey(false); });
document.addEventListener("keydown", e => { if (keyOpen && e.key === "Escape") { setKey(false); $("legend").querySelector(".keybtn").focus(); } });

// Graph navigation sits in the canvas corner, not in the toolbar.
let cbar = null;
// Before a view or project replaces the canvas, move its controls somewhere safe.
function parkBar() { if (cbar && cbar.parentNode !== $("park")) $("park").appendChild(cbar); }
function canvasBar() {
  if (!cbar) {
    cbar = document.createElement("div");
    cbar.className = "canvasbar";
    ["actNav", "zoomCtl", "dirBtn"].forEach(id => cbar.appendChild($(id)));
  }
  return cbar;
}

// camera
// A small overview map: every step as a dot in its status colour, and the visible area.
// Links of the selected step that leave the screen get a small label at the edge.
function edgePills() {
  const st = $("stage"); st.querySelectorAll(".epill").forEach(x => x.remove());
  const s = sel(); if (!s || !graph || !byId[s] || query) return;
  const r = st.getBoundingClientRect(), c = cams.get(data.id), n = byId[s];
  const pills = [];
  for (const [ids, kind] of [[n.deps, "up"], [n.users, "down"]]) for (const id of ids) {
    const p = graph.pos[id]; if (!p) continue;
    const x = c.tx + (p.x + graph.W / 2) * c.k, y = c.ty + (p.y + graph.H / 2) * c.k;
    if (x >= 0 && y >= 0 && x <= r.width && y <= r.height) continue;
    pills.push({ id, kind, x, y });
  }
  // the canvas controls, the minimap, the key and every visible step count as taken space
  const placed = [...st.querySelectorAll(".canvasbar, .minimap:not([hidden]), .edgekey")].map(el => {
    const b = el.getBoundingClientRect(); return { L: b.left - r.left, T: b.top - r.top, w: b.width, h: b.height };
  });
  for (const id in graph.pos) {
    const p = graph.pos[id], L = c.tx + p.x * c.k, T = c.ty + p.y * c.k, w = graph.W * c.k, h = graph.H * c.k;
    if (L < r.width && T < r.height && L + w > 0 && T + h > 0) placed.push({ L, T, w, h });
  }
  const hits = (L, T, w, h) => placed.some(o => L < o.L + o.w + 6 && o.L < L + w + 6 && T < o.T + o.h + 6 && o.T < T + h + 6);
  const dock = [];
  for (const q of pills.slice(0, 12)) {
    const b = document.createElement("button");
    b.className = "epill " + q.kind; b.textContent = (q.kind === "up" ? "← " : "→ ") + q.id;
    b.title = `Go to ${q.id}`;
    b.addEventListener("pointerdown", e => { e.stopPropagation(); focusNode(q.id); });
    st.appendChild(b);
    // keep the whole label inside the canvas, and never on top of another label
    const w = b.offsetWidth, h = b.offsetHeight;
    const L0 = Math.min(r.width - w - 8, Math.max(8, q.x - w / 2)), T0 = Math.min(r.height - h - 64, Math.max(8, q.y - h / 2));
    // Slide along the edge the step lies past, to the nearest free gap.
    const side = q.x < 0 || q.x > r.width, step = side ? h + 6 : w + 6;
    let spot = null;
    for (let i = 0; i < 60 && !spot; i++) {
      const d = (i % 2 ? -1 : 1) * Math.ceil(i / 2) * step;
      const L = side ? L0 : L0 + d, T = side ? T0 + d : T0;
      if (L < 8 || T < 8 || L + w > r.width - 8 || T + h > r.height - 64) continue;
      if (!hits(L, T, w, h)) spot = { L, T };
    }
    if (!spot) { dock.push(b); continue; }
    placed.push({ ...spot, w, h });
    b.style.left = spot.L + "px"; b.style.top = spot.T + "px";
  }
  // No free gap: list the rest together in the top corner.
  if (dock.length) {
    const box = document.createElement("div"); box.className = "epill-dock";
    dock.forEach(b => box.appendChild(b));
    st.appendChild(box);
  }
}
// Far out, every id is drawn at a fixed 11px on screen, shortened to fit its card.
function farIds(k) {
  if (!graph || k >= 0.45) return;
  const bucket = Math.round(k * 50);
  if (graph.farBucket === bucket) return;
  graph.farBucket = bucket;
  const chars = Math.max(3, Math.floor((graph.W * k - 8) / (11 * 0.62)));
  for (const id in graph.els) {
    const t = graph.els[id].g.querySelector(".farid");
    t.textContent = id.length <= chars ? id : id.slice(0, chars - 1) + "…";
    t.style.fontSize = (11 / k).toFixed(1) + "px";
  }
}
// The overview map starts folded on laptops, where it would cover steps; the choice is remembered.
const miniOff = () => prefs.miniOff ?? innerWidth <= 1440;
function drawMinimap() {
  const cv = $("stage").querySelector(".minimap canvas");
  if (!cv || !graph) return;
  const c = cams.get(data.id), r = $("stage").getBoundingClientRect();
  const ar = graph.worldW / graph.worldH;
  const MW = ar > 1.8 ? 180 : Math.max(60, Math.round(100 * ar)), MH = ar > 1.8 ? Math.max(40, Math.round(180 / ar)) : 100;
  const mm = $("stage").querySelector(".minimap");
  mm.classList.toggle("collapsed", miniOff());
  mm.hidden = graph.worldW * c.k <= r.width && graph.worldH * c.k <= r.height;
  const dpr = devicePixelRatio || 1;
  cv.width = MW * dpr; cv.height = MH * dpr; cv.style.width = MW + "px"; cv.style.height = MH + "px";
  const ctx = cv.getContext("2d"), sc = Math.min(MW / graph.worldW, MH / graph.worldH);
  ctx.scale(dpr, dpr);
  const css = getComputedStyle(document.documentElement), col = v => css.getPropertyValue(v).trim();
  const fill = { done: col("--green"), progress: col("--yellow"), ready: col("--blue"), blocked: col("--red"), waiting: col("--s2") };
  for (const n of data.nodes) {
    const p = graph.pos[n.id]; if (!p) continue;
    ctx.fillStyle = fill[n.status];
    ctx.fillRect(p.x * sc, p.y * sc, Math.max(2, graph.W * sc), Math.max(1.5, graph.H * sc));
  }
  ctx.strokeStyle = col("--text"); ctx.lineWidth = 1.2;
  ctx.strokeRect(-c.tx / c.k * sc, -c.ty / c.k * sc, r.width / c.k * sc, r.height / c.k * sc);
  graph.mini = { sc };
}
function applyCam() {
  const c = cams.get(data.id);
  graph.vp.setAttribute("transform", `translate(${c.tx},${c.ty}) scale(${c.k})`);
  graph.svg.classList.toggle("far", c.k < 0.45);
  edgePills();
  farIds(c.k);
  const sr = $("stage").getBoundingClientRect();
  $("stage").classList.toggle("fits", graph.worldW * c.k <= sr.width && graph.worldH * c.k <= sr.height);
  graph.svg.style.setProperty("--inv", (1 / c.k).toFixed(3));
  drawMinimap();
  graph.svg.classList.toggle("mid", c.k >= 0.4 && c.k < 0.62);
  $("zPct").textContent = Math.round(c.k * 100) + "%";
  const dg = $("stage").querySelector(".dotgrid");
  if (dg) { dg.style.backgroundSize = `${22 * c.k}px ${22 * c.k}px`; dg.style.backgroundPosition = `${c.tx}px ${c.ty}px`; }
}
function setCam(k, tx, ty) {
  hideTip();
  if (graph) {
    const r = $("stage").getBoundingClientRect(), w = graph.worldW * k, h = graph.worldH * k;
    if (h > r.height) ty = Math.min(8, Math.max(r.height - h - 8, ty)); else ty = Math.max(8, Math.min(ty, r.height - h - 8));
    if (w > r.width) tx = Math.min(8, Math.max(r.width - w - 8, tx));
  } cams.set(data.id, { k: Math.min(3, Math.max(0.08, k)), tx, ty, sig: graph.sig }); applyCam(); }
// The canvas area steps are framed in: the bottom strip holds the graph controls.
function viewRect() {
  const r = $("stage").getBoundingClientRect();
  if (!phone()) return { width: r.width, height: Math.max(200, r.height - 56) };
  // On a phone the details sheet covers the lower part of the canvas once a step is selected.
  const sheetTop = sel() ? innerHeight * (1 - 0.62) : innerHeight;
  return { width: r.width, height: Math.max(graph ? graph.H + 16 : 100, Math.min(r.height, sheetTop - Math.max(0, r.top))) };
}
function fitAll() {
  const r = viewRect();
  // Top-to-bottom plans keep a screen-sized gutter on the left for level summaries.
  const GUT = graph.lr ? 0 : 110;
  const k = Math.min(1.2, (r.width - 24 - GUT) / graph.worldW, (r.height - 24) / graph.worldH);
  setCam(k, GUT + (r.width - GUT - graph.worldW * k) / 2, (r.height - graph.worldH * k) / 2);
}
function initialView() {
  const r = viewRect();
  // Open at full size: readable first, overview on demand (Fit).
  if (graph.lr) setCam(1, 8, 8);
  else setCam(1, graph.worldW < r.width ? (r.width - graph.worldW) / 2 : 8, 8);
  const s = sel();
  const active = data.nodes.filter(n => n.status === "progress").sort((a, b) => a.order - b.order)[0];
  if (s) focusNode(s);
  else if (active) focusWork();
}
// Frame the steps in progress with their nearby prerequisites and dependents.
function focusWork() {
  const act = data.nodes.filter(n => n.status === "progress" || n.status === "blocked");
  if (!act.length) return fitAll();
  const near = new Set();
  act.forEach(n => { near.add(n.id); [...n.deps, ...n.users].forEach(x => { if (Math.abs(byId[x].level - n.level) <= 1) near.add(x); }); });
  const first = act.sort((a, b) => a.order - b.order)[0];
  if (phone()) return focusNode(first.id);
  // Prefer every active step with its neighbours, then the first one with its direct links,
  // at full size or slightly smaller (85% still reads well).
  const own = [first.id, ...first.deps, ...first.users];
  for (const ids of [[...near], own]) for (const k of [1, 0.85]) if (fitsAt(ids, k)) return fitNodes(ids, k, 1);
  fitNodes(own, 1, 1);
}
function bounds(ids) {
  const ps = ids.map(id => graph.pos[id]).filter(Boolean);
  if (!ps.length) return null;
  return { x0: Math.min(...ps.map(p => p.x)) - 30, y0: Math.min(...ps.map(p => p.y)) - 30,
    x1: Math.max(...ps.map(p => p.x)) + graph.W + 30, y1: Math.max(...ps.map(p => p.y)) + graph.H + 30 };
}
function fitsAt(ids, k) {
  const b = bounds(ids), r = viewRect();
  return !!b && (b.x1 - b.x0) * k <= r.width && (b.y1 - b.y0) * k <= r.height;
}
// Show the step with its direct links when that stays readable (60% or more); otherwise centre it.
function frameStep(id) {
  const n = byId[id]; if (!n || !graph || !graph.pos[id]) return;
  const ps = [id, ...n.deps, ...n.users].map(x => graph.pos[x]).filter(Boolean);
  const r = viewRect(), M = 48;
  const w = Math.max(...ps.map(p => p.x)) - Math.min(...ps.map(p => p.x)) + graph.W + 2 * M;
  const h = Math.max(...ps.map(p => p.y)) - Math.min(...ps.map(p => p.y)) + graph.H + 2 * M;
  const k = Math.min(1, r.width / w, r.height / h);
  if (k >= 0.75 && ps.length > 1) fitNodes([id, ...n.deps, ...n.users], 0.75, 1); else focusNode(id);
}
function fitRelated(id) {
  const n = byId[id]; if (!n) return;
  fitNodes([id, ...n.deps, ...n.users], 0.6, 1);
}
let activeIdx = 0;
function activeSteps() { return data.order.map(id => byId[id]).filter(n => n.status === "progress" || n.status === "blocked"); }
function stepActive(d) {
  const a = activeSteps(); if (!a.length) return;
  activeIdx = (activeIdx + d + a.length) % a.length;
  focusNode(a[activeIdx].id); renderToolbar();
}
// Fit the camera around some steps, for example the critical path.
function fitNodes(ids, floor = 0.45, ceil = 1.1) {
  const ps = ids.map(id => graph.pos[id]).filter(Boolean);
  if (!ps.length) return;
  const r = viewRect();
  const x0 = Math.min(...ps.map(p => p.x)) - 30, y0 = Math.min(...ps.map(p => p.y)) - 30;
  const x1 = Math.max(...ps.map(p => p.x)) + graph.W + 30, y1 = Math.max(...ps.map(p => p.y)) + graph.H + 30;
  const k = Math.max(floor, Math.min(ceil, r.width / (x1 - x0), r.height / (y1 - y0)));
  // Too big to fit at a readable size: start at the first step instead of centring.
  const fits = (x1 - x0) * k <= r.width && (y1 - y0) * k <= r.height;
  const p0 = graph.pos[ids[0]];
  if (fits) return setCam(k, (r.width - (x1 - x0) * k) / 2 - x0 * k, (r.height - (y1 - y0) * k) / 2 - y0 * k);
  // Show as much of the group as fits, starting from its top-left corner, and keep the first step on screen.
  const start = (size, a, b) => (b - a) * k > size ? 16 - a * k : (size - (b - a) * k) / 2 - a * k;
  let tx = start(r.width, x0, x1), ty = start(r.height, y0, y1);
  const px0 = (p0.x - 24) * k, px1 = (p0.x + graph.W + 24) * k, py0 = (p0.y - 24) * k, py1 = (p0.y + graph.H + 24) * k;
  if (px1 + tx > r.width) tx = r.width - px1; if (px0 + tx < 0) tx = -px0;
  if (py1 + ty > r.height) ty = r.height - py1; if (py0 + ty < 0) ty = -py0;
  setCam(k, tx, ty);
}
function zoomAt(f, mx, my) {
  const c = cams.get(data.id), r = $("stage").getBoundingClientRect();
  mx ??= r.width / 2; my ??= r.height / 2;
  const nk = Math.min(3, Math.max(0.08, c.k * f));
  setCam(nk, mx - (mx - c.tx) * nk / c.k, my - (my - c.ty) * nk / c.k);
}
function focusNode(id) {
  if (!graph || !graph.pos[id]) return;
  const r = viewRect(), c = cams.get(data.id) || { k: 1 };
  const k = Math.max(c.k, 1), p = graph.pos[id];
  // On a phone with nothing selected the step sits near the top, so its dependents show below it.
  const ty = phone() && !sel() ? 24 - p.y * k : Math.max(8, (r.height - graph.H * k) / 2) - p.y * k;
  setCam(k, r.width / 2 - (p.x + graph.W / 2) * k, ty);
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
    if (n && e.pointerType === "mouse") showTip(n.dataset.id, e, n); else hideTip();
    hoverLinks(n && e.pointerType === "mouse" ? n.dataset.id : null);
  });
  const end = e => {
    pts.delete(e.pointerId);
    if (pinch) { if (pts.size < 2) pinch = null; return; }
    if (drag && !drag.moved) {
      const id = drag.node && drag.node.dataset.id;
      const far = cams.get(data.id).k < 0.5;
      selectStep(id && (id !== sel() || far) ? id : null);
      if (id && far) fitRelated(id);
    }
    drag = null; stage.classList.remove("drag");
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  svg.addEventListener("pointerleave", () => { hideTip(); hoverLinks(null); });
  svg.addEventListener("keydown", e => {
    const n = e.target.closest(".node");
    if (n && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); selectStep(n.dataset.id); }
  });
}

// Hovering a step previews its direct links, without changing the selection.
let hovered = null;
function hoverLinks(id) {
  if (id === hovered || !graph) return;
  hovered = id;
  for (const e of graph.edges) e.el.classList.toggle("hov", !!id && !sel() && (e.from === id || e.to === id));
  for (const nid in graph.els) graph.els[nid].g.classList.toggle("hov", nid === id);
}

// tooltip
const tip = $("tip");
function showTip(id, e, el) {
  const n = byId[id]; if (!n) return;
  const en = entry(id);
  const bits = [`<span class="pill ${n.status}" style="height:18px">${LABEL[n.status]}</span>`, n.size && `size ${esc(n.size)}`, n.hard && `<span class="hardtag">hard</span>`, `order ${n.order}`, en && en.started && n.status === "progress" && runtime(en)].filter(Boolean);
  const text = (en && en.note) || n.check || n.desc;
  tip.innerHTML = `<div class="h">${esc(n.id)}</div><div>${esc(n.title)}</div><div class="l">${bits.join(" · ")}</div>${text ? `<div class="muted">${esc(text.length > 260 ? text.slice(0, 259) + "…" : text)}</div>` : ""}`;
  tip.style.display = "block";
  const w = tip.offsetWidth, h = tip.offsetHeight;
  // Above the card when there is room, otherwise below it, so neighbours stay visible.
  const b = el ? el.getBoundingClientRect() : { left: e.clientX, top: e.clientY, bottom: e.clientY };
  tip.style.left = Math.max(8, Math.min(b.left, innerWidth - w - 8)) + "px";
  tip.style.top = (b.top - h - 8 > 60 ? b.top - h - 8 : Math.min(innerHeight - h - 8, b.bottom + 8)) + "px";
}
function hideTip() { tip.style.display = "none"; }

// order + table
const noRows = () => {
  const onlySearch = query && !filter && !critOn && !offAreas().size;
  return `<div class="state-msg" style="height:auto;padding:48px 16px"><div class="state-card"><h2>No steps match</h2><p class="muted">${onlySearch ? `Nothing matches “${esc(query)}”.` : "The search or filters hide every step."}</p><button class="btn" ${onlySearch ? "data-clear-q" : "data-reset-filters"}>${onlySearch ? "Clear search" : "Reset filters"}</button></div></div>`;
};
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
let showDone = false;
function renderOrder() {
  const { vis } = visibility(), s = sel(), top = listScroll();
  const shown = data.order.map(id => byId[id]).filter(n => !vis[n.id].excluded);
  let lead = 0;
  while (lead < shown.length && shown[lead].status === "done" && !shown[lead].unpushed && shown[lead].id !== s) lead++;
  const fold = !showDone && lead > 3 && !query;
  const foldRow = fold ? `<button class="orow foldrow" data-show-done><span class="n"></span><span class="dot done"></span><span class="id">${lead} done</span><span class="t muted">Steps #1–#${shown[lead - 1].order} are finished. Show them</span><span class="r">▸</span></button>` : "";
  const rows = foldRow + shown.slice(fold ? lead : 0).map(n => {
    const e = entry(n.id);
    const area = data.areas[n.area] && n.area !== n.status && data.areas[n.area] !== n.status ? esc(data.areas[n.area]) : "";
    const meta = [area, n.size && esc(n.size), n.hard && '<span class="hardtag">hard</span>'].filter(Boolean).join(" · ");
    const state = n.status === "progress" ? `<span class="pill progress sm">${esc(since(e))}</span>` : `<span class="pill ${n.unpushed ? "unpushed" : n.status} sm">${n.unpushed ? "not pushed" : LABEL[n.status]}</span>`;
    return `<div class="orow${n.id === s ? " sel" : ""}" data-id="${esc(n.id)}" tabindex="0"><span class="n">#${n.order}</span><span class="dot ${n.unpushed ? "unpushed" : n.status}"></span><span class="id">${esc(n.id)}</span><span class="t" title="${esc(n.title)}">${esc(n.title)}</span><span class="r">${meta ? `<span class="muted">${meta}</span>` : ""}${state}</span></div>`;
  }).join("") || noRows();
  const idw = Math.min(24, Math.max(4, ...data.nodes.map(n => n.id.length)));
  const active = !filter && !query ? data.order.map(id => byId[id]).filter(n => n.status === "progress" || n.status === "blocked") : [];
  const pinned = active.length ? `<div class="pinned"><div class="lvlrow">IN PROGRESS · ${active.length}</div>${active.map(n => `<div class="orow${n.id === s ? " sel" : ""}" data-id="${esc(n.id)}" tabindex="0"><span class="n">#${n.order}</span><span class="dot ${n.status}"></span><span class="id">${esc(n.id)}</span><span class="t">${esc(n.title)}</span><span class="r"><span class="pill ${n.status} sm">${esc(n.status === "blocked" ? "blocked" : since(entry(n.id)))}</span></span></div>`).join("")}</div>` : "";
  $("stage").innerHTML = `<div class="list" style="--idw:${idw}ch">${pinned}<div class="listhead"><b>Dependency order</b><span>One valid build sequence: every step comes after its prerequisites. It is not a priority ranking.</span></div>${rows}</div>`;
  keepScroll(top, s);
}

const COLS = [
  ["order", "#", n => n.order], ["id", "Step", n => n.id], ["title", "Title", n => n.title], ["status", "State", n => n.status],
  ["check", "Done when", n => n.check || n.desc], ["area", "Area", n => data.areas[n.area] || n.area],
  ["level", "Level", n => n.level], ["size", "Size", n => n.size], ["deps", "Needs", n => n.deps.length],
  ["updated", "Updated", n => (entry(n.id) || {}).updated || ""], ["who", "By", n => (entry(n.id) || {}).who || ""],
];
function renderTable() {
  const { vis } = visibility(), s = sel(), top = listScroll();
  const col = COLS.find(c => c[0] === tableSort.key) || COLS[0];
  const rows = data.nodes.filter(n => !vis[n.id].excluded).sort((a, b) => {
    const x = col[2](a), y = col[2](b);
    return (typeof x === "number" && typeof y === "number" ? x - y : String(x).localeCompare(String(y))) * tableSort.dir || a.order - b.order;
  });
  const head = COLS.map(c => `<th class="c-${c[0]}" data-sort="${c[0]}" aria-sort="${tableSort.key === c[0] ? (tableSort.dir > 0 ? "ascending" : "descending") : "none"}"><button class="sortbtn">${c[1]}${tableSort.key === c[0] ? ` <span class="ar">${tableSort.dir > 0 ? "↑" : "↓"}</span>` : ""}</button></th>`).join("");
  const body = rows.map(n => {
    const e = entry(n.id) || {};
    return `<tr data-id="${esc(n.id)}" class="${n.id === s ? "sel" : ""}" tabindex="0">
      <td class="muted c-order">${n.order}</td><td class="id c-id">${esc(n.id)}</td><td class="c-title">${esc(n.title)}</td>
      <td class="c-status"><span class="pill ${n.status}" style="height:20px">${LABEL[n.status]}</span>${n.unpushed ? ' <span class="pill unpushed" style="height:20px">not pushed</span>' : ""}</td>
      <td class="wrap c-check"><div class="clamp" title="${esc(n.check || n.desc)}">${esc(n.check || n.desc)}</div></td>
      <td class="c-area"><i class="dot" style="display:inline-block;vertical-align:-1px;margin-right:5px;background:${areaColor(n.area)};border-color:${areaColor(n.area)}"></i>${esc(data.areas[n.area] || n.area)}</td>
      <td class="c-level">${n.level}</td><td class="c-size">${esc(n.size)}${n.hard ? ' <span class="hardtag">hard</span>' : ""}</td>
      <td class="mono small c-deps">${n.deps.map(esc).join("<br>") || "–"}</td>
      <td class="c-meta">${esc([data.areas[n.area] || n.area, n.size, n.deps.length ? `${n.deps.length} prerequisite${n.deps.length > 1 ? "s" : ""}` : "no prerequisites"].filter(Boolean).join(" · "))}</td>
      ${["order", "id", "title", "status"].includes(tableSort.key) ? "" : `<td class="c-sortval">${esc((COLS.find(c => c[0] === tableSort.key) || COLS[0])[1])}: ${esc(String((COLS.find(c => c[0] === tableSort.key) || COLS[0])[2](n)))}</td>`}
      <td class="muted small c-updated" title="${esc(e.updated || "")}">${e.updated ? ago(e.updated) : ""}</td><td class="small c-who">${esc(e.who || "")}</td></tr>`;
  }).join("");
  const sortSel = `<div class="sortbar"><label>Sort by <select data-sortsel>${COLS.map(c => `<option value="${c[0]}"${c[0] === tableSort.key ? " selected" : ""}>${c[1]}</option>`).join("")}</select></label><button class="btn small" data-sortdir>${tableSort.dir > 0 ? "↑ Ascending" : "↓ Descending"}</button></div>`;
  $("stage").innerHTML = `<div class="list">${sortSel}<table class="t"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table>${rows.length ? "" : noRows()}</div>`;
  keepScroll(top, s);
}
$("main").addEventListener("click", e => {
  if (!route.project || !data) return;
  const th = e.target.closest("th[data-sort]");
  if (th) { tableSort = { key: th.dataset.sort, dir: tableSort.key === th.dataset.sort ? -tableSort.dir : 1 }; renderTable(); $("stage").querySelector(".list").scrollTop = 0; return; }
  const row = e.target.closest(".orow[data-id], tr[data-id]");
  if (row) {
    const id = row.dataset.id;
    if (query) { clearSearch(); return selectStep(id, true); }
    return selectStep(id === sel() ? null : id);
  }
});
$("main").addEventListener("change", e => {
  if (e.target.matches("[data-sortsel]")) { tableSort = { key: e.target.value, dir: 1 }; renderTable(); }
});
$("main").addEventListener("click", e => { if (e.target.closest("[data-sortdir]")) { tableSort.dir = -tableSort.dir; renderTable(); } });
$("main").addEventListener("keydown", e => {
  const row = e.target.closest(".orow[data-id], tr[data-id]");
  if (row && e.key === "Enter") selectStep(row.dataset.id);
});

// ----------------------------------------------------------------- panel ----
const linkRow = (id, plain) => {
  const n = byId[id], e = entry(id);
  const right = n.status === "progress" ? since(e) : plain ? "" : LABEL[n.status] + (n.unpushed ? ", not pushed" : "");
  return `<li data-goto="${esc(id)}" tabindex="0"><span class="dot ${n.unpushed ? "unpushed" : n.status}"></span><span class="id">${esc(id)}</span><span class="t" title="${esc(n.title)}">${esc(n.title)}</span><span class="s">${right}</span></li>`;
};
const linkList = (ids, empty, plain = false) => `<ul class="links">${ids.map(id => linkRow(id, plain)).join("") || `<li class="none">${empty}</li>`}</ul>`;

function renderPanel() {
  const p = $("panel"), keep = p.scrollTop, s = sel();
  $("app").classList.toggle("sheet", !!s && !query);
  // The table needs the width; its overview panel comes back when a row is selected.
  $("work").classList.toggle("wide", viewOf(data.id) === "table" && !s);
  const focused = document.activeElement && document.activeElement.id === "noteIn";
  // An unsent note belongs to its step, so it never follows the selection elsewhere.
  if ($("noteIn") && $("noteIn").dataset.key) drafts.set($("noteIn").dataset.key, $("noteIn").value);
  p.innerHTML = s && !query ? detail(byId[s]) : overview();
  if ($("noteIn")) {
    const key = data.id + "/" + s;
    $("noteIn").dataset.key = key; $("noteIn").value = drafts.get(key) || "";
    $("noteIn").oninput = () => drafts.set(key, $("noteIn").value);
    if (focused) $("noteIn").focus();
  }
  p.scrollTop = keep;
}

function overview() {
  const by = st => data.nodes.filter(n => n.status === st).sort((a, b) => a.order - b.order);
  const prog = by("progress"), blocked = by("blocked"), ready = by("ready");
  const problems = data.problems && data.problems.length ? `<div class="errbox"><b>Plan problems</b><br>${data.problems.map(esc).join("<br>")}</div>` : "";
  const q = query.toLowerCase(), sv = visibility().vis;
  const hits = q ? data.order.map(id => byId[id]).filter(n => !sv[n.id].excluded) : [];
  const scope = filter ? ` in ${LABEL[filter]}` : critOn ? ` on the ${data.critical_computed ? "longest chain" : "critical path"}` : "";
  const found = q ? `<h3 style="margin-top:2px">Matches${scope} · ${hits.length}</h3>${hits.length ? linkList(hits.slice(0, 20).map(n => n.id)) : `<p class="muted small">No matches.</p>`}${hits.length > 20 ? `<p class="muted small">Showing the first 20.</p>` : ""}` : "";
  if (q) return `${problems}${found}`;
  // An active filter lists its steps first, so results stay readable whatever the zoom.
  const { vis: fv } = visibility();
  const chainName = data.critical_computed ? "longest chain" : "critical path";
  const fl = (critOn && !filter ? data.critical : data.order).map(id => byId[id]).filter(n => !fv[n.id].excluded);
  const head = filter ? LABEL[filter][0].toUpperCase() + LABEL[filter].slice(1) + (critOn ? ` on ${chainName}` : "") : chainName[0].toUpperCase() + chainName.slice(1);
  const flist = filter || critOn ? `<h3 style="margin-top:2px">${head}${offAreas().size ? " in shown areas" : ""} · ${fl.length}</h3>${linkList(fl.map(n => n.id), "No steps match these filters.", !!filter)}
    <button class="btn ghost small" data-reset-filters style="margin-top:6px">Reset filters</button>` : "";
  const help = viewOf(data.id) === "graph" ? "Click a step to see its details. Overview shows the whole graph." : "Click a step to see its details.";
  if (flist && !q) return `${problems}${flist}<p class="muted small">${help}</p>`;
  return `${problems}${found}
    ${prog.length ? `<h3 style="margin-top:2px">In progress · ${prog.length}</h3>${linkList(prog.map(n => n.id))}` : ""}
    ${blocked.length ? `<h3>Blocked · ${blocked.length}</h3>${linkList(blocked.map(n => n.id))}` : ""}
    <h3 ${prog.length || blocked.length ? "" : 'style="margin-top:2px"'}>Ready to start · ${ready.length}</h3>
    ${linkList(ready.slice(0, 6).map(n => n.id), "Nothing is ready: every open step waits on a prerequisite.", true)}
    ${ready.length > 6 ? `<button class="btn ghost small" data-filter-ready style="margin-top:4px">Show all ${ready.length} ready steps</button>` : ""}
    <p class="muted small">Ready means every prerequisite is recorded as done. It is not a priority order.</p>
    <h3>${data.critical_computed ? "Longest chain" : "Critical path"} · ${data.critical.length} steps</h3>
    ${linkList(data.critical)}
    ${data.critical_computed ? `<p class="muted small">Counted in steps, not time.</p>` : ""}
    <p class="muted small" style="margin-top:16px">${STATIC ? "Offline snapshot. Mark done here to plan; marks stay in this browser."
      : `Live from ${esc(data.machine || data.host)} (${esc(data.format)} plan). Changes made by agents with the project's CLI show up within seconds.`}</p>`;
}

let detailsOpen = false;
const drafts = new Map();
document.addEventListener("toggle", e => { if (e.target.matches && e.target.matches("details.more")) detailsOpen = e.target.open; }, true);
function detail(n) {
  const e = entry(n.id) || {}, s = n.status;
  const crit = data.critical.includes(n.id);
  const f = (() => { const walk = (start, key) => { const out = new Set(), st = [start]; while (st.length) for (const x of byId[st.pop()][key]) if (!out.has(x)) { out.add(x); st.push(x); } return out; }; return { up: walk(n.id, "deps"), down: walk(n.id, "users") }; })();
  const pills = [`<span class="pill ${s}">${GLYPH[s] || "○"} ${LABEL[s]}</span>`, n.unpushed && `<span class="pill unpushed">not pushed</span>`,
    n.hard && `<span class="pill hard">hard</span>`, crit && `<span class="pill crit">${data.critical_computed ? "longest chain" : "critical path"}</span>`].filter(Boolean).join("");
  const cell = (v, l, t = "") => `<div title="${esc(t || String(v).replace(/<[^>]*>/g, ""))}"><b>${v}</b><span>${l}</span></div>`;
  const meta = `<div class="meta">${cell("#" + n.order, "order", `${n.order} of ${data.nodes.length} in dependency order`)}${cell(n.level, "level")}${cell(esc(n.size || "–"), "size")}${cell(f.down.size, "depend on it", "steps that need this one, directly or not")}
    ${cell(runtime(e), "runtime")}${cell(e.retries ?? 0, "retries")}${cell(e.updated ? ago(e.updated) : "–", "last update", e.updated || "")}${cell(esc(e.who || "–"), "by")}</div>`;
  const hex = e.commit && /^[0-9a-f]{4,64}$/i.test(e.commit);
  const pushState = !hex || !data.repo ? "" : n.unpushed ? ` · <span class="peach-ink">not on ${esc(data.repo.upstream || "upstream")} yet</span>`
    : e.commit in (data.repo.pushed || {}) ? " · pushed" : " · not found in this clone";
  const commit = e.commit ? `<div class="commit">commit <code>${esc(String(e.commit).slice(0, 10))}</code>${pushState}</div>` : "";
  const conflict = s === "done" && n.unmet.length ? `<div class="warnbox">Marked done while ${n.unmet.length} prerequisite${n.unmet.length > 1 ? "s are" : " is"} not done: ${n.unmet.map(id => `<a data-goto="${esc(id)}" href="javascript:void 0">${esc(id)}</a>`).join(", ")}.</div>` : "";
  const unmet = s !== "done" && n.unmet.length ? `<div class="warnbox">Waiting on ${n.unmet.length} prerequisite${n.unmet.length > 1 ? "s" : ""}: ${n.unmet.map(id => `<a data-goto="${esc(id)}" href="javascript:void 0">${esc(id)}</a>`).join(", ")}. ${f.up.size} steps upstream in total.</div>` : "";
  const check = n.check ? `<h3>Done when</h3><div class="check">${esc(n.check)}</div>` : "";
  const desc = n.desc ? `<h3>${n.check ? "Notes" : "Description"}</h3><div class="check">${esc(n.desc)}</div>` : "";
  const noCheck = !n.check && !n.desc ? `<h3>Done when</h3><div class="check empty">No completion check written for this step.</div>` : "";
  // Open steps lead with what you can do; finished steps lead with what they are, and the note box moves down.
  const acts = actions(n, e), late = s === "done";
  return `<button class="grab" data-grow aria-label="Make the details taller or shorter"></button><div class="dhead"><span class="idl">${esc(n.id)}</span><button class="iconbtn x" data-close aria-label="Close details" title="Close (Esc)">✕</button></div>
    <div class="dtitle">${esc(n.title)}</div>
    <div class="darea"><i class="sw" style="background:${areaColor(n.area)}"></i>${esc(data.areas[n.area] || n.area || "no area")}</div>
    <div class="pills">${pills}</div>
    ${check}
    ${late ? "" : acts}
    ${n.hard ? `<p class="small" style="color:var(--red);margin:0 0 8px">Hard: this step may need a redesign.</p>` : ""}
    ${conflict}${unmet}${desc}${noCheck}
    ${e.note && e.note !== n.check ? `<h3>Latest note</h3><div class="note">${esc(e.note)}</div>` : ""}
    <h3>Needs first · ${n.deps.length}</h3>${linkList(n.deps, "Nothing: it can start any time.")}
    <h3>Unblocks · ${n.users.length}</h3>${linkList(n.users, "Nothing depends on it.")}
    ${f.down.size ? `<p class="muted small">${f.down.size} step${f.down.size === 1 ? "" : "s"} depend on this one, directly or not.</p>` : ""}
    ${late && acts ? `<h3>Add a note</h3>${acts}` : ""}
    <details class="more"${detailsOpen ? " open" : ""}><summary>Details</summary>${meta}${commit}</details>
    ${stepLog(n.id)}`;
}

function actions(n, e) {
  if (STATIC) {
    const local = staticDone().has(n.id);
    return n.status === "done" && !local ? "" : `<div class="actions"><div class="btns" style="margin:0"><button class="btn" data-local>${local ? "Mark not done" : "Mark done"}</button><span class="muted small" style="align-self:center">Saved in this browser only</span></div></div>`;
  }
  const can = a => data.actions.includes(a), s = n.status, b = [];
  // Stepwise plans refuse to start or finish a step whose prerequisites are open.
  const gated = data.format === "stepwise" && n.unmet.length ? ' disabled title="Its prerequisites are not done yet"' : "";
  // One filled button per state: Start when ready, Mark done while active, Retry when blocked.
  const main = s === "ready" ? "start" : s === "progress" ? "done" : s === "blocked" ? "retry" : null;
  const cls = a => a === main ? "btn primary" : "btn";
  if (can("start") && s !== "progress" && s !== "done") b.push(`<button class="${cls("start")}" data-act="start"${gated}>Start${s === "waiting" ? " anyway" : ""}</button>`);
  if (can("done") && s !== "done") b.push(`<button class="${cls("done")}" data-act="done"${gated}>Mark done</button>`);
  if (can("retry") && (s === "progress" || s === "blocked")) b.push(`<button class="${cls("retry")}" data-act="retry"${gated}>Retry</button>`);
  if (can("block") && s === "progress") b.push(`<button class="btn" data-act="block">Block</button>`);
  // VELA's CLI starts a step when you log on it, so only offer notes once it has a record.
  if (can("log") && !(data.log_starts && !data.progress[n.id])) b.push(`<button class="btn" data-act="log">Add note</button>`);
  const rec = data.progress[n.id];
  if (can("reset") && rec && rec.state && rec.state !== "todo") b.push(`<button class="btn ghost more-act" data-act="reset" title="Clear this step's progress">Reset…</button>`);
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
  document.querySelectorAll("[data-act]").forEach(b => { b.disabled = true; b.classList.toggle("busy", b.dataset.act === action); });
  try {
    const r = await fetch("api/project/" + encodeURIComponent(data.id) + "/step", {
      method: "POST", headers: { "Content-Type": "application/json", "X-Stepwise": "1" },
      body: JSON.stringify({ action, id, msg }),
    });
    const body = await r.json();
    if (!r.ok) throw new Error(body.error || r.status);
    if (input) { input.value = ""; drafts.delete(data.id + "/" + id); }
    lastFetch = Date.now();
    setData(body);
    toast({ start: `${id} started`, done: `${id} marked done`, block: `${id} blocked`, retry: `${id} retried`, log: "Note added", reset: `${id} reset` }[action]);
  } catch (err) { toast("Could not save: " + err.message, true); }
  finally { busy = false; renderPanel(); }
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
  // Opening a step from the search results shows its details: the search makes way.
  if (g) { e.preventDefault(); if (query) clearSearch(); return selectStep(g.dataset.goto, true); }
  const a = e.target.closest("[data-act]");
  if (a) return act(a.dataset.act);
  if (e.target.closest("[data-close]")) return selectStep(null);
  if (e.target.closest("[data-filter-ready]")) { filter = "ready"; return renderProject(); }
  if (e.target.closest("[data-local]")) { toggleStatic(sel()); return; }
  if (e.target.closest("[data-showall]")) return selectStep(null);
  if (e.target.closest("[data-show-done]")) { showDone = true; return renderOrder(); }
  if (e.target.closest("[data-more-log]")) { logLimit += 50; return renderLog(); }
  if (e.target.closest("[data-log-toggle]")) { logOpen = !logOpen; return renderLog(); }
  if (e.target.closest("[data-grow]")) { $("app").classList.toggle("tall"); return; }
  if (e.target.closest("[data-clear-q]")) return clearSearch();
  if (e.target.closest("[data-reset-filters]")) { $("q").value = query = ""; filter = null; critOn = false; offAreas().clear(); return renderProject(); }
});
$("main").addEventListener("keydown", e => {
  if (e.target.id === "noteIn" && e.key === "Enter") { e.preventDefault(); if (document.querySelector('[data-act="log"]')) act("log"); }
  const g = e.target.closest("li[data-goto]");
  if (g && e.key === "Enter") selectStep(g.dataset.goto, true);
});

// ------------------------------------------------------------------- log ----
const dayLabel = d => d.toDateString() === new Date().toDateString() ? "Today"
  : d.toDateString() === new Date(Date.now() - 864e5).toDateString() ? "Yesterday" : d.toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "short" });
const hhmm = d => isNaN(d) ? "" : d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
function logRowsHtml(rows, seen) {
  let day = "";
  return rows.map(r => {
    const d = new Date(ts(r.t)), lab = isNaN(d) ? "" : dayLabel(d);
    const head = lab !== day ? `<div class="dayhead">${esc(day = lab)}</div>` : "";
    return head + `<div class="logrow${ts(r.t) > seen ? " fresh" : ""}"><span class="tm" title="${esc(r.t)}">${esc(hhmm(d))}</span>
      <div class="hd"><a data-goto="${esc(r.step)}">${esc(r.step)}</a>${kindBadge(r.kind)}${r.who ? `<span class="k">${esc(r.who)}</span>` : ""}</div><div class="m">${esc(r.msg)}</div></div>`;
  }).join("");
}
function stepLog(id) {
  const rows = data.log.filter(r => r.step === id).slice(-200).reverse();
  return `<h3>Log · ${rows.length}</h3>${rows.length ? `<div class="steplog">${logRowsHtml(rows, Infinity)}</div>` : `<div class="empty">Nothing logged for this step yet.</div>`}`;
}
let logLimit = 20, logOpen = false;
function renderLog() {
  const box = $("logsec"), s = sel(), latest = data.log.length ? ts(data.log[data.log.length - 1].t) : 0;
  // With a step selected, its own log sits at the end of the details, so they get the whole column.
  box.hidden = !!s;
  if (s) return;
  const seen = seenLog.has(data.id) ? seenLog.get(data.id) : latest;
  if (STATIC && !data.log.length) { box.innerHTML = `<div class="sechead"><h3>Running log</h3></div><div class="empty">No log in this snapshot.</div>`; return; }
  // Phones show a short log by default so the page stays short.
  const cap = matchMedia("(max-width: 900px)").matches ? logLimit : 200;
  const all = data.log.map((r, i) => ({ ...r, i })).filter(r => !s || r.step === s);
  const rows = all.slice(-cap).reverse();
  box.classList.toggle("open", logOpen);
  box.classList.toggle("collapsed", !logOpen && !phone());
  box.innerHTML = `<div class="sechead"><h3>Running log</h3><span class="muted small">${all.length}</span><button class="btn ghost small" data-log-toggle style="margin-left:auto;height:24px" aria-expanded="${logOpen}">${logOpen ? "Collapse" : "Expand"}</button></div>` +
    (logRowsHtml(rows, seen) + (all.length > rows.length && cap < 200 ? `<button class="btn ghost small" data-more-log style="margin-top:8px">Show ${Math.min(50, all.length - rows.length)} more</button>` : "")
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
$("q").addEventListener("input", () => {
  query = $("q").value.trim();
  if (!data || !data.nodes) return;
  renderStage(); renderPanel();
});
$("q").addEventListener("keydown", e => {
  if (e.key === "Enter" && query && data) {
    const q = query.toLowerCase();
    const m = data.nodes.find(n => n.id.toLowerCase() === q) || data.order.map(id => byId[id]).find(n => matches(n, q));
    if (m) selectStep(m.id, true);
  }
  if (e.key === "Escape") { clearSearch(); $("q").blur(); }
});
$("toolbar").addEventListener("click", e => {
  if (!data || !data.nodes) return;
  const v = e.target.closest("[data-view]");
  if (v) {
    prefs.view[data.id] = v.dataset.view; savePrefs();
    if (matchMedia("(max-width: 900px)").matches && sel()) return selectStep(null);
    return renderProject();
  }
  const f = e.target.closest("[data-filter]");
  if (f) {
    filter = f.dataset.filter || null;
    renderProject();

    return;
  }
});
$("areaBtn").onclick = e => {
  e.stopPropagation();
  const open = $("areaMenu").hidden;
  closeMenus();
  $("areaMenu").hidden = !open; $("areaBtn").setAttribute("aria-expanded", open);
};
$("areaMenu").addEventListener("click", e => {
  e.stopPropagation();
  if (!data || !data.nodes) return;
  const off = offAreas(), keys = Object.keys(data.areas);
  if (e.target.closest("[data-area-all]")) { off.clear(); return renderProject(); }
  const only = e.target.closest("[data-area-only]");
  if (only) { e.preventDefault(); off.clear(); keys.forEach(k => k !== only.dataset.areaOnly && off.add(k)); return renderProject(); }
});
$("areaMenu").addEventListener("change", e => {
  const box = e.target.closest("input[data-area]");
  if (!box || !data) return;
  const off = offAreas();
  box.checked ? off.delete(box.dataset.area) : off.add(box.dataset.area);
  renderProject();
});
$("critBtn").onclick = () => { critOn = !critOn; renderProject(); };
$("ctxBtn").onclick = () => { showContext = !showContext; renderStage(); };
$("edgeBtn").onclick = () => { prefs.edges[data.id] = edgesOf(data.id) === "direct" ? "all" : "direct"; savePrefs(); renderProject(); };
$("zIn").onclick = () => zoomAt(1.2);
$("zOut").onclick = () => zoomAt(1 / 1.2);
$("zFit").onclick = () => fitAll();
$("zFocus").onclick = () => sel() ? fitRelated(sel()) : focusWork();
$("banner").addEventListener("click", e => { if (e.target.closest("[data-reconnect]")) { pollProjects(); pollProject(); } });
$("actPrev").onclick = () => stepActive(-1);
$("actNext").onclick = () => stepActive(1);
$("moreBtn").onclick = () => { const o = !$("toolbar").classList.contains("open"); $("toolbar").classList.toggle("open", o); $("moreBtn").setAttribute("aria-expanded", o); };
function clearSearch() { $("q").value = query = ""; if (data && data.nodes) { renderStage(); renderPanel(); } }
$("qClear").onclick = () => { clearSearch(); $("q").focus(); };
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
  // Segmented choices and switches, matching the toolbar.
  const seg = (key, cur, opts) => `<div class="seg pseg" role="group" data-pref="${key}">${opts.map(([v, l]) => `<button data-v="${v}" aria-pressed="${v === cur}">${l}</button>`).join("")}</div>`;
  const sw = (key, on, label) => `<label class="row"><span>${label}</span><input type="checkbox" class="switch" data-pref="${key}"${on ? " checked" : ""}></label>`;
  $("prefs").innerHTML = `<h3>Appearance</h3>
    <div class="prow"><span>Theme</span>${seg("theme", prefs.theme, [["system", "Auto"], ["latte", "Latte"], ["macchiato", "Macchiato"]])}</div>
    <div class="prow"><span>Density</span>${seg("density", prefs.density, [["compact", "Compact"], ["comfortable", "Comfy"]])}</div>
    <div class="prow"><span>Text size</span><input id="pText" type="range" min="90" max="125" step="5" value="${prefs.text}" aria-label="Text size"></div>
    ${sw("sizes", prefs.sizes, "Size estimates on steps")}
    ${sw("legend", prefs.legend, "Legend in the status bar")}
    ${p ? `<h3>${esc(data.title)}</h3>
    <div class="prow"><span>Direction</span>${seg("dir", dirOf(data.id), [["TB", "Top ↓"], ["LR", "Left →"]])}</div>
    <div class="prow"><span>On select</span>${seg("edges", edgesOf(data.id), [["all", "Whole chain"], ["direct", "Direct"]])}</div>
    ${STATIC ? "" : `<a class="btn small" style="margin-top:4px" href="export/${encodeURIComponent(data.id)}.html">Download offline snapshot</a>`}` : ""}
    <h3>Keys</h3><div class="keys">${[["/", "Find a step"], ["0–9", "Switch project"], ["g o t", "Graph, order, table"], ["f", "Fit everything"], ["w", "Focus work in progress"], ["c", "Critical path"], ["e", "Direct edges"], ["d", "Direction"], ["Esc", "Clear selection"]]
      .map(([k, l]) => `<span>${l}</span><span class="kbd">${k}</span>`).join("")}</div>
    <div class="btns"><button class="btn ghost small" id="pReset">Reset view settings</button></div>`;
  $("prefs").querySelectorAll(".pseg").forEach(g => g.addEventListener("click", e => {
    const b = e.target.closest("button[data-v]"); if (!b) return;
    const key = g.dataset.pref, v = b.dataset.v;
    if (key === "dir") prefs.dir[data.id] = v; else if (key === "edges") prefs.edges[data.id] = v; else prefs[key] = v;
    savePrefs(); applyPrefs(); renderPrefs();
    if (key === "dir" || key === "density") rerenderGraph(); else if (key === "edges") renderProject();
  }));
  $("prefs").querySelectorAll("input.switch").forEach(i => i.addEventListener("change", () => {
    prefs[i.dataset.pref] = i.checked; savePrefs();
    if (i.dataset.pref === "sizes") rerenderGraph(); else renderLegend();
  }));
  $("pText").addEventListener("input", e => { prefs.text = +e.target.value; savePrefs(); applyPrefs(); });
  $("pText").addEventListener("change", () => rerenderGraph());
  $("pReset").addEventListener("click", () => { prefs = { ...DEFAULTS, dir: {}, edges: {}, view: {} }; savePrefs(); applyPrefs(); renderPrefs(); rerenderGraph(); });
}
function rerenderGraph() { graph = null; if (route.project && data && data.nodes) renderProject(); }

// keyboard
addEventListener("keydown", e => {
  const typing = e.target.closest && e.target.closest("input, select, textarea, dialog");
  if (e.key === "Escape") {
    if (!$("menu").hidden || !$("prefs").hidden || !$("areaMenu").hidden) return closeMenus();
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
  if (e.key === "w") return $("zFocus").click();
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
addEventListener("resize", () => keepFramed());
// Keep the selected (or first active) step fully on screen, 24px from the edges.
function ensureVisible() {
  if (!graph) return;
  const id = sel() || (activeSteps()[0] || {}).id, p = id && graph.pos[id];
  if (!p) return;
  const r = $("stage").getBoundingClientRect(), c = cams.get(data.id), M = 24;
  const x = c.tx + p.x * c.k, y = c.ty + p.y * c.k;
  if (x < M || y < M || x + graph.W * c.k > r.width - M || y + graph.H * c.k > r.height - M) focusNode(id);
}
function keepFramed() {
  if (!graph || !data || !cams.has(data.id)) return;
  const r = $("stage").getBoundingClientRect(), o = graph.lastR;
  if (!r.width || !r.height) return;
  if (!o || !o.width || !o.height) { graph.lastR = r; return initialView(); }
  if (o.width === r.width && o.height === r.height) return;
  const c = cams.get(data.id);
  graph.lastR = r;
  setCam(c.k, c.tx + (r.width - o.width) / 2, c.ty + (r.height - o.height) / 2);
  ensureVisible();
}
