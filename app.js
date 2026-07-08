/* par autoresearch — static offline dashboard renderer.
 *
 * Loads dashboard_site/data.json (from scripts/build_dashboard_site.py) if it exists, else falls back to
 * mock_data.json so the page renders before any search. Pure client-side: Plotly is vendored, no network.
 *
 * The payload is METRIC-GENERIC: `metric_keys` lists the dotted metric names present in the records
 * ("ec.micro_auprc", "contact.attn_p_at_l", ...) and each node carries a `metrics` map. Adding, renaming
 * or removing an eval metric therefore needs no change here.
 *
 * There is deliberately NO `composite` column and NO lineage tree:
 *   - `composite` is an alias for `ec.micro_auprc` (eval/run.py::composite_score). Showing one number
 *     twice under two names invites the reader to treat it as two pieces of evidence.
 *   - the tree encoded parent links, but the search's value is in the metrics, not the genealogy.
 */
"use strict";

function cssv(v) { return getComputedStyle(document.documentElement).getPropertyValue(v).trim(); }
const COL = {
  good: cssv("--good"), gold: cssv("--gold"), anchor: cssv("--anchor"),
  bad: cssv("--bad"), gray: cssv("--gray"), muted: cssv("--muted"),
  grid: cssv("--grid"), ink: cssv("--ink"), panel: cssv("--panel"),
};
const FAMILY_PALETTE = [
  "#2563eb", "#16a34a", "#d4a017", "#dc2626", "#7c3aed", "#0891b2",
  "#ea580c", "#db2777", "#65a30d", "#0d9488", "#4f46e5", "#b45309",
];
const familyColor = {};
function colorForFamily(f) {
  if (!(f in familyColor)) familyColor[f] = FAMILY_PALETTE[Object.keys(familyColor).length % FAMILY_PALETTE.length];
  return familyColor[f];
}

const OK = "ok";
const isCross = (n) => n.status === "crashed" || n.status === "failed" || n.status === "smoke_failed";

const esc = (s) => (s == null ? "" : String(s)).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const fmt = (x, d = 3) => (x == null || Number.isNaN(x)) ? "—" : (+x).toFixed(d);
const fmtParams = (x) => x == null ? "—" : (x / 1e6).toFixed(1) + "M";
const fmtTokens = (x) => x == null ? "—" : (x / 1e9).toFixed(2) + "B";
const fmtEF = (x) => x == null ? "—" : (+x).toFixed(3);
const fmtRuntime = (s) => {
  if (s == null) return "—";
  const h = Math.floor(s / 3600), m = Math.round((s % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
};
// The GPU is identified by UUID and resolved to its nvidia-smi row; an unmatched UUID is shown as such
// rather than silently printing a (permutable) CUDA index as if it were the nvidia-smi one.
const fmtGpu = (g) => {
  if (!g || !g.name) return "—";
  const short = g.name.replace(/^NVIDIA\s+/, "");
  if (!g.matched) return `${short} <span class="warn" title="UUID not found in nvidia-smi">?</span>`;
  return `${short} <span class="dim">#${g.smi_index}</span>`;
};

// A metric beats the anchor if it is above it — unless smaller is better for that metric (e.g. ec.ce).
function beats(data, key, v) {
  const a = data.anchors && data.anchors[key];
  if (a == null || v == null) return false;
  return (data.lower_is_better || []).includes(key) ? v < a : v > a;
}

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
  const nodes = data.nodes, primary = data.primary;
  const vals = nodes.map((n) => n.metrics[primary]).filter((v) => v != null);
  const best = vals.length ? Math.max(...vals) : null;
  const beat = nodes.filter((n) => beats(data, primary, n.metrics[primary])).length;
  const kept = nodes.filter((n) => n.kept).length;
  // Total measured compute actually spent — the iso-FLOP audit trail, summed.
  const ef = nodes.map((n) => n.flops && n.flops.exaflops).filter((v) => v != null);
  const efTotal = ef.reduce((a, b) => a + b, 0);
  const anchor = data.anchors[primary];
  // The anchor bounds compute, not size. Surface the largest model in the run so a 5×-parameter win at
  // 1.0× compute is visible at a glance rather than buried in a sorted column.
  const pr = nodes.map((n) => n.params_ratio).filter((v) => v != null);
  const maxPR = pr.length ? Math.max(...pr) : null;
  const chips = [
    ["nodes", nodes.length, ""],
    [`best ${primary}`, best != null ? best.toFixed(3) : "—", best != null && best > anchor ? "good" : ""],
    ["beating anchor", beat, beat > 0 ? "gold" : ""],
    ["kept", kept, ""],
    ["ExaFLOPs spent", ef.length ? efTotal.toFixed(1) : "—", ""],
    ["biggest model (× baseline)", maxPR != null ? maxPR.toFixed(2) + "×" : "—", maxPR >= 1.5 ? "gold" : ""],
  ];
  document.getElementById("chips").innerHTML = chips.map((c) =>
    `<div class="chip"><b class="${c[2]}">${c[1]}</b><span>${c[0]}</span></div>`).join("");
}

// ==== metrics-vs-trial plot =====================================================
function renderMetricPlot(data, key) {
  const anchor = data.anchors ? data.anchors[key] : null;
  const lower = (data.lower_is_better || []).includes(key);
  const nodes = data.nodes;
  const okX = [], okY = [], okHov = [];
  const otX = [], otY = [], otHov = [];
  const bx = [], by = [];
  let best = lower ? Infinity : -Infinity;
  nodes.forEach((n) => {
    const v = n.metrics[key];
    if (v != null && isFinite(v)) best = lower ? Math.min(best, v) : Math.max(best, v);
    bx.push(n.id); by.push(isFinite(best) ? best : null);
    if (v == null) return;
    const hov = `node ${n.id} · ${esc(n.family)}<br>${esc(n.operator)} · ${esc(n.status)}<br>${key} = ${fmt(v, 4)}`;
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
  if (anchor != null) {
    const maxX = Math.max(1, ...nodes.map((n) => n.id));
    shapes.push({ type: "line", x0: 0, x1: maxX, y0: anchor, y1: anchor,
      line: { color: COL.anchor, width: 1.6, dash: "dash" } });
    anns.push({ x: 0, y: anchor, text: `  ESM-2 35M anchor = ${anchor}`, showarrow: false,
      font: { size: 11, color: COL.anchor }, xanchor: "left", yanchor: "bottom" });
  }

  Plotly.react("metricPlot", traces, {
    paper_bgcolor: COL.panel, plot_bgcolor: COL.panel,
    font: { color: COL.ink, family: "Arial, Helvetica, sans-serif" },
    margin: { l: 62, r: 18, t: 12, b: 46 }, showlegend: true, uirevision: "keep",
    legend: { orientation: "h", x: 1, y: 1.08, xanchor: "right", bgcolor: "rgba(0,0,0,0)" },
    xaxis: { title: "trial (node id / commit order)", gridcolor: COL.grid, zeroline: false },
    yaxis: { title: key + (lower ? "  (lower is better)" : ""), gridcolor: COL.grid, zeroline: false },
    shapes, annotations: anns,
  }, { displaylogo: false, responsive: true });
}

// ==== sortable node table ========================================================
// Fixed columns, then one column per recorded metric, then the compute/provenance columns.
function tableCols(data) {
  const cols = [
    { k: "id", label: "id", num: true, get: (n) => n.id, cell: (n) => `${n.id}` },
    { k: "family", label: "family", num: false, get: (n) => n.family,
      cell: (n) => `<span class="pill" style="color:${colorForFamily(n.family)}">${esc(n.family)}</span>` },
    { k: "operator", label: "operator", num: false, get: (n) => n.operator, cell: (n) => esc(n.operator) },
  ];
  data.metric_keys.forEach((key) => cols.push({
    k: "m:" + key, label: key, num: true, metric: key,
    get: (n) => n.metrics[key],
    cell: (n) => `<span class="${beats(data, key, n.metrics[key]) ? "beats" : ""}">${fmt(n.metrics[key], 4)}</span>`,
  }));
  cols.push(
    { k: "n_params", label: "params", num: true, get: (n) => n.n_params, cell: (n) => fmtParams(n.n_params) },
    { k: "tokens", label: "tokens", num: true, get: (n) => n.tokens, cell: (n) => fmtTokens(n.tokens) },
    { k: "ef", label: "ExaFLOPs", num: true, get: (n) => n.flops && n.flops.exaflops,
      cell: (n) => fmtEF(n.flops && n.flops.exaflops) },
    { k: "iso", label: "iso-FLOP ×", num: true, get: (n) => n.flops && n.flops.iso_flop_ratio,
      cell: (n) => fmt(n.flops && n.flops.iso_flop_ratio, 2) },
    // Sits IMMEDIATELY beside iso-FLOP ×, deliberately. The anchor has a size floor and NO ceiling: at equal
    // compute, parameters are the free variable. A per-sequence AdaLN modulation MLP, a top-1 MoE, or a
    // cheaper mixer (linear attention, hourglass) re-spending its saving all legitimately carry more. A win
    // at 5× params and 1.0× compute is a consequence of the anchor, not a mechanism result — so it is shown,
    // never left implicit. ≥1.5× is flagged; ≤0.5× (a shrunk recurrence) is dimmed, not warned.
    { k: "params_ratio", label: "params ×", num: true, get: (n) => n.params_ratio,
      cell: (n) => n.params_ratio == null ? "—"
        : `<span class="${n.params_ratio >= 1.5 ? "warn" : n.params_ratio <= 0.5 ? "dim" : ""}"${
            n.params_ratio >= 1.5 ? ' title="carries ≥1.5× the baseline\'s parameters at the same compute — the anchor permits this; read the win accordingly"' : ""
          }>${n.params_ratio.toFixed(2)}×</span>` },
    { k: "runtime_s", label: "runtime", num: true, get: (n) => n.runtime_s, cell: (n) => fmtRuntime(n.runtime_s) },
    { k: "gpu", label: "GPU", num: false, get: (n) => (n.gpu && n.gpu.name) || "", cell: (n) => fmtGpu(n.gpu) },
    { k: "kept", label: "kept", num: false, get: (n) => (n.kept ? 1 : 0),
      cell: (n) => `<span class="${n.kept ? "yes" : "no"}">${n.kept ? "yes" : "no"}</span>` },
    { k: "status", label: "status", num: false, get: (n) => n.status,
      cell: (n) => `<span class="${n.status === OK ? "st-ok" : isCross(n) ? "st-bad" : "st-other"}">${esc(n.status)}</span>` },
  );
  return cols;
}

let sortKey = "id", sortAsc = true;

function renderTable(data, cols) {
  const col = cols.find((c) => c.k === sortKey) || cols[0];
  const rows = data.nodes.slice().sort((a, b) => {
    let va = col.get(a), vb = col.get(b);
    if (va == null) va = col.num ? -Infinity : "";
    if (vb == null) vb = col.num ? -Infinity : "";
    if (typeof va !== "number" || typeof vb !== "number") { va = String(va); vb = String(vb); }
    const c = va < vb ? -1 : va > vb ? 1 : 0;
    return sortAsc ? c : -c;
  });
  document.querySelector("#nodeTable tbody").innerHTML = rows.map((n) =>
    "<tr>" + cols.map((c) => `<td class="${c.num ? "num" : ""}">${c.cell(n)}</td>`).join("") + "</tr>"
  ).join("");
  document.querySelectorAll("#nodeTable th").forEach((th) => {
    th.className = th.dataset.k === sortKey ? (sortAsc ? "asc" : "desc") : "";
  });
}

function wireTable(data, cols) {
  document.querySelector("#nodeTable thead tr").innerHTML =
    cols.map((c) => `<th data-k="${c.k}" title="${esc(c.label)}">${esc(c.label)}</th>`).join("");
  document.querySelectorAll("#nodeTable th").forEach((th) => {
    th.onclick = () => {
      const k = th.dataset.k;
      if (k === sortKey) sortAsc = !sortAsc;
      else { sortKey = k; sortAsc = !cols.find((c) => c.k === k).num; }
      renderTable(data, cols);
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
  srcNote.innerHTML = data.__source === "mock_data.json"
    ? `sample data (<code>mock_data.json</code>) — no real search yet`
    : (data.generated_at ? `data.json · generated ${esc(data.generated_at)}` : `data.json`);

  renderChips(data);

  if (!data.nodes.length) {
    ["metricSection", "tableSection"].forEach((id) =>
      document.getElementById(id).innerHTML =
        `<div class="empty">No nodes committed yet. Once the search runs, this fills in automatically.</div>`);
    return;
  }

  const sel = document.getElementById("metricSel");
  sel.innerHTML = data.metric_keys.map((k) =>
    `<option value="${k}">${k}${k === data.primary ? "  (primary)" : ""}</option>`).join("");
  sel.value = data.primary;
  sel.onchange = () => renderMetricPlot(data, sel.value);
  renderMetricPlot(data, data.primary);

  const cols = tableCols(data);
  wireTable(data, cols);
  renderTable(data, cols);

  window.addEventListener("resize", () => Plotly.Plots.resize("metricPlot"));
})();
