/* par autoresearch — static offline dashboard renderer.
 *
 * Loads dashboard_site/data.json (real, from scripts/build_dashboard_site.py) if it
 * exists, else falls back to mock_data.json so the page renders before any search.
 * Pure client-side: Plotly is vendored (plotly.min.js), no network at runtime.
 *
 * Node record (flat, from the generator):
 *   {id, parent, operator, family, status, composite, ec, go, repsp, contact,
 *    kept, pareto, tokens, runtime_s}
 * anchor = ESM-2 35M EC val micro-AUPRC (0.765, the primary); nodes ordered by id ("trial").
 */
"use strict";

// ---- palette (read status/role colors from CSS so JS + CSS never drift) --------
function cssv(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
const COL = {
  good: cssv("--good"), gold: cssv("--gold"), anchor: cssv("--anchor"),
  bad: cssv("--bad"), gray: cssv("--gray"), muted: cssv("--muted"),
  grid: cssv("--grid"), ink: cssv("--ink"), panel: cssv("--panel"),
};
// stable, distinct per-family palette (assigned in first-seen / id order)
const FAMILY_PALETTE = [
  "#2563eb", "#16a34a", "#d4a017", "#dc2626", "#7c3aed", "#0891b2",
  "#ea580c", "#db2777", "#65a30d", "#0d9488", "#4f46e5", "#b45309",
];
let familyColor = {};
function colorForFamily(f) {
  if (!(f in familyColor)) familyColor[f] = FAMILY_PALETTE[Object.keys(familyColor).length % FAMILY_PALETTE.length];
  return familyColor[f];
}

const OK = "ok";
const isCross = (n) => n.status === "crashed" || n.status === "failed" || n.status === "smoke_failed";
const isPruned = (n) => n.status === "pruned";
const beatsAnchor = (n, anchor) => n.composite != null && n.composite > anchor;

const fmt = (x) => (x == null || Number.isNaN(x)) ? "—" : (+x).toFixed(3);
const esc = (s) => (s == null ? "" : String(s)).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

// ---- data load: prefer real data.json, else mock_data.json ----------------------
async function loadData() {
  for (const src of ["data.json", "mock_data.json"]) {
    try {
      const r = await fetch(src, { cache: "no-store" });
      if (!r.ok) continue;
      const d = await r.json();
      d.__source = src;
      return d;
    } catch (e) { /* try next */ }
  }
  return null;
}

// ==== summary chips ==============================================================
function renderChips(data) {
  const nodes = data.nodes;
  const anchor = data.anchor;
  const comps = nodes.map((n) => n.composite).filter((v) => v != null);
  const best = comps.length ? Math.max(...comps) : null;
  const beat = nodes.filter((n) => beatsAnchor(n, anchor)).length;
  const kept = nodes.filter((n) => n.kept).length;
  const chips = [
    ["nodes", nodes.length, ""],
    ["best composite", best != null ? best.toFixed(3) : "—", best != null && best > anchor ? "good" : ""],
    ["beating anchor", beat, beat > 0 ? "gold" : ""],
    ["kept", kept, ""],
  ];
  document.getElementById("chips").innerHTML = chips.map((c) =>
    `<div class="chip"><b class="${c[2]}">${c[1]}</b><span>${c[0]}</span></div>`).join("");
}

// ==== metrics-vs-trial plot =====================================================
const METRICS = {
  composite: { label: "EC val micro-AUPRC (primary)", key: "composite", anchored: true },
  go: { label: "GO Fmax", key: "go", anchored: true },
  repsp: { label: "RepSP AUPRC", key: "repsp", anchored: true },
  contact: { label: "Contact P@L (long-range, supervised)", key: "contact", anchored: true },
};

function renderMetricPlot(data, metricName) {
  const meta = METRICS[metricName] || METRICS.composite;
  const key = meta.key;
  // per-metric ESM-2 35M anchor (falls back to the composite anchor for older data.json).
  const anchor = (data.anchors && data.anchors[metricName] != null) ? data.anchors[metricName] : data.anchor;
  // x = node id (== trial / commit order); nodes already sorted by id.
  const nodes = data.nodes;
  const okX = [], okY = [], okHov = [];
  const otX = [], otY = [], otHov = [];      // non-ok (crashed/pruned/failed) but with a value
  const bx = [], by = [];                    // running best (over the shown metric)
  let best = -Infinity;
  nodes.forEach((n) => {
    const v = n[key];
    if (v != null && isFinite(v)) { best = Math.max(best, v); }
    bx.push(n.id); by.push(best > -Infinity ? best : null);
    if (v == null) return;
    const hov = `node ${n.id} · ${esc(n.family)}<br>${esc(n.operator)} · ${esc(n.status)}<br>${meta.label.split(" (")[0]} = ${fmt(v)}`;
    if (n.status === OK) { okX.push(n.id); okY.push(v); okHov.push(hov); }
    else { otX.push(n.id); otY.push(v); otHov.push(hov); }
  });

  const traces = [
    { name: "running best", x: bx, y: by, mode: "lines",
      line: { shape: "hv", color: COL.good, width: 2 }, hoverinfo: "skip" },
    { name: "other (crashed/pruned)", x: otX, y: otY, text: otHov, hoverinfo: "text",
      mode: "markers", marker: { size: 7, color: COL.gray, symbol: "x", opacity: 0.85 } },
    { name: "ok node", x: okX, y: okY, text: okHov, hoverinfo: "text",
      mode: "markers", marker: { size: 9, color: COL.good, line: { color: COL.panel, width: 1 } } },
  ];

  const shapes = [], anns = [];
  if (meta.anchored && anchor != null) {
    const maxX = Math.max(1, ...nodes.map((n) => n.id));
    shapes.push({ type: "line", x0: 0, x1: maxX, y0: anchor, y1: anchor,
      line: { color: COL.anchor, width: 1.6, dash: "dash" } });
    anns.push({ x: 0, y: anchor, text: `  ESM-2 35M anchor = ${anchor}`, showarrow: false,
      font: { size: 11, color: COL.anchor }, xanchor: "left", yanchor: "bottom" });
  }

  const layout = {
    paper_bgcolor: COL.panel, plot_bgcolor: COL.panel,
    font: { color: COL.ink, family: "Arial, Helvetica, sans-serif" },
    margin: { l: 56, r: 18, t: 12, b: 46 }, showlegend: true, uirevision: "keep",
    legend: { orientation: "h", x: 1, y: 1.08, xanchor: "right", bgcolor: "rgba(0,0,0,0)" },
    xaxis: { title: "trial (node id / commit order)", gridcolor: COL.grid, zeroline: false, dtick: 1 },
    yaxis: { title: meta.label, gridcolor: COL.grid, zeroline: false },
    shapes, annotations: anns,
  };
  Plotly.react("metricPlot", traces, layout, { displaylogo: false, responsive: true });
}

// ==== lineage tree / DAG (tidy layout in JS) ====================================
// x = depth (parent chain), y = leaf-DFS order; internal node y = mean of its children.
function treeLayout(nodes) {
  const byId = {};
  nodes.forEach((n) => (byId[n.id] = { n, kids: [], x: 0, y: 0 }));
  const VR = "__root__";
  byId[VR] = { n: { id: VR }, kids: [], x: -1, y: 0, virtual: true };
  nodes.forEach((n) => {
    const p = n.parent;
    if (p != null && byId[p] && p !== n.id) byId[p].kids.push(byId[n.id]);
    else byId[VR].kids.push(byId[n.id]);   // root (parent null) or orphan -> hang off virtual root
  });
  // stable child order: by id (== trial order)
  Object.values(byId).forEach((e) => e.kids.sort((a, b) => a.n.id - b.n.id));
  let leaf = 0;
  (function dfs(e, d) {
    e.x = d;
    if (!e.kids.length) { e.y = leaf++; return; }
    e.kids.forEach((k) => dfs(k, d + 1));
    e.y = (e.kids[0].y + e.kids[e.kids.length - 1].y) / 2;
  })(byId[VR], -1);
  return byId;
}

function renderTree(data) {
  const nodes = data.nodes;
  const anchor = data.anchor;
  const lay = treeLayout(nodes);

  // parent -> child edges as line shapes
  const shapes = [];
  nodes.forEach((n) => {
    const e = lay[n.id];
    const p = n.parent;
    if (p == null || !lay[p] || p === n.id) return;
    const pe = lay[p];
    shapes.push({ type: "line", x0: pe.x, y0: pe.y, x1: e.x, y1: e.y,
      line: { color: "#cbd3dd", width: 1.3 }, layer: "below" });
  });

  // marker size ∝ composite (fallback small for null); one trace per family (legend = color key)
  const compVals = nodes.map((n) => n.composite).filter((v) => v != null);
  const cMin = compVals.length ? Math.min(...compVals) : 0;
  const cMax = compVals.length ? Math.max(...compVals) : 1;
  const sizeFor = (n) => {
    if (n.composite == null) return 8;
    const t = cMax > cMin ? (n.composite - cMin) / (cMax - cMin) : 0.5;
    return 11 + 22 * t;
  };

  const groups = {};
  nodes.forEach((n) => (groups[n.family] = groups[n.family] || []).push(n));
  const traces = [];
  Object.keys(groups).sort().forEach((fam) => {
    const arr = groups[fam];
    traces.push({
      name: fam, type: "scatter", mode: "markers",
      x: arr.map((n) => lay[n.id].x), y: arr.map((n) => lay[n.id].y),
      marker: {
        size: arr.map(sizeFor),
        color: colorForFamily(fam),
        // gold ring for nodes beating the anchor; otherwise a thin neutral ring
        line: {
          color: arr.map((n) => beatsAnchor(n, anchor) ? COL.gold : COL.panel),
          width: arr.map((n) => beatsAnchor(n, anchor) ? 3 : 1),
        },
        // kept -> solid circle; pruned/crashed/failed -> × ; other non-kept ok -> open circle
        symbol: arr.map((n) => isCross(n) ? "x" : (n.kept ? "circle" : "circle-open")),
        opacity: arr.map((n) => isCross(n) ? 0.9 : 1),
      },
      customdata: arr.map((n) => [
        n.id, esc(n.family), esc(n.operator), esc(n.status),
        fmt(n.composite), fmt(n.ec), fmt(n.go), fmt(n.repsp), fmt(n.flip),
        n.kept ? "yes" : "no", n.pareto ? "yes" : "no",
      ]),
      hovertemplate:
        "<b>node %{customdata[0]}</b> · %{customdata[1]}<br>" +
        "operator: %{customdata[2]} · status: %{customdata[3]}<br>" +
        "composite: %{customdata[4]}<br>" +
        "EC %{customdata[5]} · GO %{customdata[6]} · RepSP %{customdata[7]}<br>" +
        "FLIP %{customdata[8]} · kept %{customdata[9]} · pareto %{customdata[10]}<extra></extra>",
    });
  });

  const maxX = Math.max(0, ...nodes.map((n) => lay[n.id].x));
  const layout = {
    paper_bgcolor: COL.panel, plot_bgcolor: COL.panel,
    font: { color: COL.ink, family: "Arial, Helvetica, sans-serif" },
    margin: { l: 16, r: 16, t: 10, b: 40 }, showlegend: true, uirevision: "keep",
    legend: { orientation: "h", x: 0, y: -0.04, bgcolor: "rgba(0,0,0,0)", font: { size: 11 } },
    xaxis: { title: "depth (root → children)", gridcolor: COL.grid, zeroline: false,
             dtick: 1, range: [-1.4, maxX + 1.2] },
    yaxis: { showticklabels: false, gridcolor: COL.panel, zeroline: false, autorange: "reversed" },
    shapes,
  };
  Plotly.react("treePlot", traces, layout, { displaylogo: false, responsive: true });
}

// ==== sortable node table ========================================================
const TABLE_COLS = [
  { k: "id", label: "id", num: true },
  { k: "family", label: "family", num: false },
  { k: "operator", label: "operator", num: false },
  { k: "composite", label: "composite", num: true },
  { k: "ec", label: "ec", num: true },
  { k: "go", label: "go", num: true },
  { k: "repsp", label: "repsp", num: true },
  { k: "kept", label: "kept", num: false },
  { k: "status", label: "status", num: false },
];
let sortKey = "id", sortAsc = true;

function statusClass(n) {
  if (n.status === OK) return "st-ok";
  if (isCross(n)) return "st-bad";
  return "st-other";
}

function renderTable(data) {
  const anchor = data.anchor;
  const rows = data.nodes.slice().sort((a, b) => {
    let va = a[sortKey], vb = b[sortKey];
    if (typeof va === "boolean") va = va ? 1 : 0;
    if (typeof vb === "boolean") vb = vb ? 1 : 0;
    if (va == null) va = -Infinity;
    if (vb == null) vb = -Infinity;
    if (typeof va !== "number" || typeof vb !== "number") { va = String(va); vb = String(vb); }
    const c = va < vb ? -1 : va > vb ? 1 : 0;
    return sortAsc ? c : -c;
  });
  const tb = document.querySelector("#nodeTable tbody");
  tb.innerHTML = rows.map((n) => {
    const beats = beatsAnchor(n, anchor);
    return `<tr>
      <td class="num">${n.id}</td>
      <td><span class="pill" style="color:${colorForFamily(n.family)}">${esc(n.family)}</span></td>
      <td>${esc(n.operator)}</td>
      <td class="num ${beats ? "beats" : ""}">${fmt(n.composite)}</td>
      <td class="num">${fmt(n.ec)}</td>
      <td class="num">${fmt(n.go)}</td>
      <td class="num">${fmt(n.repsp)}</td>
      <td class="${n.kept ? "yes" : "no"}">${n.kept ? "yes" : "no"}</td>
      <td class="${statusClass(n)}">${esc(n.status)}</td>
    </tr>`;
  }).join("");
  document.querySelectorAll("#nodeTable th").forEach((th) => {
    th.className = th.dataset.k === sortKey ? (sortAsc ? "asc" : "desc") : "";
  });
}

function wireTableHeaders(data) {
  const thead = document.querySelector("#nodeTable thead tr");
  thead.innerHTML = TABLE_COLS.map((c) => `<th data-k="${c.k}">${c.label}</th>`).join("");
  document.querySelectorAll("#nodeTable th").forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.k;
      if (k === sortKey) sortAsc = !sortAsc;
      else { sortKey = k; sortAsc = TABLE_COLS.find((c) => c.k === k).num ? false : true; }
      renderTable(data);
    };
  });
}

// ==== boot ======================================================================
(async function main() {
  const data = await loadData();
  const srcNote = document.getElementById("srcNote");
  if (!data) {
    document.getElementById("app").innerHTML =
      `<div class="empty">Could not load <code>data.json</code> or <code>mock_data.json</code>.<br>` +
      `Generate data with <code>scripts/build_dashboard_site.py</code>.</div>`;
    return;
  }
  const usingMock = data.__source === "mock_data.json";
  srcNote.innerHTML = usingMock
    ? `sample data (<code>mock_data.json</code>) — no real search yet`
    : (data.generated_at ? `data.json · generated ${esc(data.generated_at)}` : `data.json`);

  renderChips(data);

  if (!data.nodes.length) {
    // valid empty site: no nodes committed yet
    ["metricSection", "treeSection", "tableSection"].forEach((id) =>
      document.getElementById(id).innerHTML =
        `<div class="empty">No nodes committed yet. Once the search runs, this fills in automatically.</div>`);
    return;
  }

  const sel = document.getElementById("metricSel");
  sel.innerHTML = Object.entries(METRICS).map(([k, m]) =>
    `<option value="${k}">${m.label}</option>`).join("");
  sel.value = "composite";
  sel.onchange = () => renderMetricPlot(data, sel.value);
  renderMetricPlot(data, "composite");

  renderTree(data);
  wireTableHeaders(data);
  renderTable(data);

  window.addEventListener("resize", () => {
    Plotly.Plots.resize("metricPlot");
    Plotly.Plots.resize("treePlot");
  });
})();
