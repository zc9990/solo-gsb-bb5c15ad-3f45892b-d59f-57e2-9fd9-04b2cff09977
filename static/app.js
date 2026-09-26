/* 陶瓷窑车层架载荷追踪台 —— 原生 JS 前端
 * 编辑重算走 PUT /api/state（自动保存）；立柱失效推演走 POST /api/simulate（只算不存）。
 * 输入变化防抖触发，结果整架同步刷新；后端不可用时用浏览器内同一套算法兜底。
 */
"use strict";

const TOL_MM = 10;
const LAYER_COLORS = ["#4f9dff", "#34c08a", "#c08bff", "#f0b03c", "#ef5b6b", "#3fd6d6"];

let state = null;        // 输入架体（可编辑）
let result = null;       // 后端计算结果（基准）
let simulation = null;   // 失效推演结果（非 null 时视图/明细展示推演值）
let simDiff = null;      // 基准 vs 推演差异（台面载荷/丢失载荷/逐柱差值/新增问题）
let failedSelection = []; // 失效柱选择 [{layer, post}]，仅会话内有效，不保存
let simSeq = 0;          // 推演请求序号，丢弃过期响应
let suggestData = null;  // 加柱建议后端结果（只算不存；结构变化即失效）
let suggestStale = false; // 架体刚编辑、建议正在重算：卡片只展示，点击暂不响应
let suggestPreview = null; // 正在预览的方案 {plan, result}；仅视图覆盖，不写数据
let suggestSeq = 0;      // 加柱建议请求序号
let suggestTimer = null; // 加柱建议参数防抖
let selection = null;    // {kind:'post'|'board', layer, post?}
let sideAxis = "x";
let recalcTimer = null;
const topHit = [];       // 俯视图可点击热区
const sideHit = [];      // 侧视图可点击热区

/* ================= 数值/工具 ================= */
const $ = (sel) => document.querySelector(sel);
const fmt = (v) => (Math.round(v * 100) / 100).toLocaleString("zh-CN", { maximumFractionDigits: 2 });
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const r2 = (v) => Math.round(v * 100) / 100;
const SUGGEST_MAX_GRID = 2500; // 与 app/calc.py 对齐：候选网格点数上限
const baseResult = () => simulation || result; // 面板/汇总用结果（不含加柱预览）
const viewResult = () =>
  suggestPreview ? suggestPreview.result : baseResult(); // 视图/明细：预览方案优先
const debounce = (fn, ms) => (...args) => {
  clearTimeout(recalcTimer);
  recalcTimer = setTimeout(() => fn(...args), ms);
};

function setSaveState(cls, text) {
  const el = $("#saveState");
  el.className = "save-state " + cls;
  el.textContent = text;
}

/* ================= 数据采集（从输入框） ================= */
function collectState() {
  const car = {
    name: "窑车台面",
    w: num(document.querySelector('[data-car="w"]').value),
    d: num(document.querySelector('[data-car="d"]').value),
  };
  const layers = [...document.querySelectorAll(".layer-card")].map((card) => {
    const li = +card.dataset.index;
    const posts = [...card.querySelectorAll(".post-row")].map((row) => ({
      id: row.querySelector('[data-pf="id"]').value.trim() || row.dataset.pid,
      x: num(row.querySelector('[data-pf="x"]').value),
      y: num(row.querySelector('[data-pf="y"]').value),
      capacity: num(row.querySelector('[data-pf="capacity"]').value),
    }));
    return {
      id: card.dataset.layerid,
      name: card.querySelector('[data-lf="name"]').value.trim() || `第${li + 1}层`,
      height: num(card.querySelector('[data-lf="height"]').value),
      board: {
        x: num(card.querySelector('[data-lf="bx"]').value),
        y: num(card.querySelector('[data-lf="by"]').value),
        w: num(card.querySelector('[data-lf="bw"]').value),
        d: num(card.querySelector('[data-lf="bd"]').value),
        weight: num(card.querySelector('[data-lf="bweight"]').value),
      },
      wareWeight: num(card.querySelector('[data-lf="wareWeight"]').value),
      posts,
    };
  });
  state = { car, layers };
  return state;
}

/* ================= 重算 + 保存 + 渲染 ================= */
async function recalcAndRender(opts) {
  const skipSuggest = !!(opts && opts.skipSuggest);
  const payload = collectState();
  setSaveState("saving", "重算并保存中…");
  try {
    const res = await fetch("/api/state", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("保存失败");
    const data = await res.json();
    result = data.result;
    state = payload;
    setSaveState("saved", "✓ 已重算并保存 " + new Date().toLocaleTimeString("zh-CN"));
  } catch (err) {
    setSaveState("error", "保存失败，仅本地重算");
    result = calculateLocal(payload);
  }
  selection = selection && stillExists(selection) ? selection : null;
  // 编辑只更新基准；若正在推演，用同一失效选择在新基准上重跑（失效标记不保存）
  if (failedSelection.length) await refreshSimulation();
  else { simulation = null; simDiff = null; }
  // 编辑后旧的加柱建议可能已过期（层/柱/坐标变化）：退出预览并按当前参数重跑。
  // 保留旧卡片展示直到新结果返回，仅把状态标为“重算中”，避免面板闪烁成“未试算”；
  // 旧卡片仅用于展示，其确认/预览入口在重算期间禁用。
  cancelSuggestPreview(true);
  suggestStale = !!suggestData;
  if (suggestStale) $("#sugStatus").textContent = "架体已变 · 重算中…";
  renderResults();
  markLayerBadges();
  if (!skipSuggest) scheduleSuggest();
}

/* ================= 立柱失效推演 =================
 * 失效柱选择只保存在会话内（failedSelection），绝不写入 state / 持久化；
 * 基准 = 当前编辑数据，推演 = 失效柱视为不承载后按原规则整架重新分摊。
 */
function isFailed(li, pid) {
  return failedSelection.some((f) => f.layer === li && f.post === pid);
}

async function toggleFailed(li, pid, on) {
  if (on) {
    if (!isFailed(li, pid)) failedSelection.push({ layer: li, post: pid });
  } else {
    failedSelection = failedSelection.filter((f) => !(f.layer === li && f.post === pid));
  }
  await applySimulation();
}

async function applySimulation() {
  if (failedSelection.length) await refreshSimulation();
  else { simulation = null; simDiff = null; }
  renderResults();
  markLayerBadges();
}

async function refreshSimulation() {
  const seq = ++simSeq;
  const payload = { state, failed: failedSelection };
  let data = null;
  try {
    const res = await fetch("/api/simulate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new Error("simulate failed");
    data = await res.json();
  } catch (e) {
    data = simulateLocal(state, failedSelection); // 离线兜底：与后端同一套算法
  }
  if (seq !== simSeq) return; // 已有更新的推演请求，丢弃过期响应
  simulation = data.simulation;
  simDiff = data.diff;
  // 以实际生效的失效柱为准（失效标记只作用于非悬空柱，编辑后可能不再适用）
  failedSelection = (data.failed || []).map((f) => ({ layer: f.layer, post: f.post }));
}

function clearSimulation() {
  failedSelection = [];
  simulation = null;
  simDiff = null;
  simSeq++; // 使进行中的推演请求失效
  renderResults(); // 立即恢复基准
  markLayerBadges();
}

function stillExists(sel) {
  if (!result) return false;
  const L = result.layers[sel.layer];
  if (!L) return false;
  if (sel.kind === "board") return true;
  return L.posts.some((p) => p.id === sel.post);
}

const scheduleRecalc = debounce(recalcAndRender, 250);

/* ================= 编辑器渲染 ================= */
function renderEditor() {
  const list = $("#layerList");
  list.innerHTML = "";
  state.layers.forEach((layer, i) => list.appendChild(buildLayerCard(layer, i)));
  $('[data-car="w"]').value = state.car.w;
  $('[data-car="d"]').value = state.car.d;
}

function buildLayerCard(layer, i) {
  const card = document.createElement("section");
  card.className = "card layer-card";
  card.dataset.index = i;
  card.dataset.layerid = layer.id;
  card.style.borderLeftColor = LAYER_COLORS[i % LAYER_COLORS.length];

  const tag = i === 0 ? "底层 · 柱落窑车台面"
    : i === state.layers.length - 1 ? "顶层" : `第 ${i + 1} 层`;
  card.innerHTML = `
    <div class="layer-row">
      <div class="layer-name">
        <input type="text" data-lf="name" value="${escapeHtml(layer.name)}" />
        <span class="layer-tag">${tag}</span>
      </div>
      <div class="layer-badges">
        <button class="btn-del" data-act="del-layer" title="删除本层">✕</button>
      </div>
    </div>
    <div class="layer-badges" style="margin-bottom:6px">
      <span class="mini-badge" data-mb="overload">超载 0</span>
      <span class="mini-badge" data-mb="hanging">悬空 0</span>
      <span class="mini-badge" data-mb="overlap">重叠 0</span>
    </div>

    <div class="sub-title">矩形棚板（左下角原点）</div>
    <div class="grid4">
      <label>x <input type="number" step="any" data-lf="bx" value="${layer.board.x}"></label>
      <label>y <input type="number" step="any" data-lf="by" value="${layer.board.y}"></label>
      <label>宽 W <input type="number" step="any" data-lf="bw" value="${layer.board.w}"></label>
      <label>深 D <input type="number" step="any" data-lf="bd" value="${layer.board.d}"></label>
    </div>
    <div class="grid2" style="margin-top:6px">
      <label>棚板自重 (kg) <input type="number" step="any" data-lf="bweight" value="${layer.board.weight}"></label>
      <label>坯件重量 (kg) <input type="number" step="any" data-lf="wareWeight" value="${layer.wareWeight}"></label>
    </div>
    <div class="grid2" style="margin-top:6px">
      <label>立柱高度 H (mm，层间距) <input type="number" step="any" data-lf="height" value="${layer.height}"></label>
    </div>

    <div class="sub-title"><span>立柱（顶端托本板，底端落在下层）</span></div>
    <div class="post-list"></div>
    <button class="btn-add-post" data-act="add-post" type="button">＋ 增加立柱</button>
  `;
  const postList = card.querySelector(".post-list");
  layer.posts.forEach((p, pi) => postList.appendChild(buildPostRow(p, pi)));
  return card;
}

function buildPostRow(p, pi) {
  const row = document.createElement("div");
  row.className = "post-row";
  row.dataset.pid = p.id || `P${pi + 1}`;
  row.innerHTML = `
    <div class="grid3">
      <label>编号 <input type="text" data-pf="id" value="${escapeHtml(p.id)}"></label>
      <label>x(mm) <input type="number" step="any" data-pf="x" value="${p.x}"></label>
      <label>y(mm) <input type="number" step="any" data-pf="y" value="${p.y}"></label>
    </div>
    <div class="grid3 two-col" style="margin-top:4px">
      <label>容量(kg，0=不限) <input type="number" step="any" data-pf="capacity" value="${p.capacity}"></label>
      <button class="btn-del" data-act="del-post" title="删除立柱" style="height:28px;margin-top:14px">✕</button>
    </div>`;
  return row;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function markLayerBadges() {
  if (!result) return;
  document.querySelectorAll(".layer-card").forEach((card) => {
    const L = result.layers[+card.dataset.index];
    if (!L) return;
    const counts = { overload: 0, hanging: 0, overlap: 0 };
    L.posts.forEach((p) => {
      if (p.hanging) counts.hanging++;
      if (p.overlap) counts.overlap++;
      if (p.overloaded) counts.overload++;
    });
    card.querySelector('[data-mb="overload"]').textContent = "超载 " + counts.overload;
    card.querySelector('[data-mb="hanging"]').textContent = "悬空 " + counts.hanging;
    card.querySelector('[data-mb="overlap"]').textContent = "重叠 " + counts.overlap;
  });
}

/* ================= 编辑器事件（委托） ================= */
$("#editor").addEventListener("input", (e) => {
  if (e.target.closest("input")) scheduleRecalc();
});

$("#editor").addEventListener("click", (e) => {
  const btn = e.target.closest("[data-act]");
  if (!btn) return;
  const act = btn.dataset.act;
  const card = e.target.closest(".layer-card");
  collectState();

  if (act === "del-layer") {
    const i = +card.dataset.index;
    if (!confirm(`删除「${state.layers[i].name}」？`)) return;
    state.layers.splice(i, 1);
    renderEditor(); scheduleRecalc();
  } else if (act === "add-post") {
    const i = +card.dataset.index;
    const ids = state.layers[i].posts.map((p) => p.id);
    let k = 1;
    while (ids.includes("P" + k)) k++;
    const lowerBoard = i === 0
      ? { x: 0, y: 0, w: state.car.w, d: state.car.d }
      : state.layers[i - 1].board;
    state.layers[i].posts.push({
      id: "P" + k,
      x: Math.min(lowerBoard.x + 200, lowerBoard.x + Math.max(lowerBoard.w - 10, 0)),
      y: Math.min(lowerBoard.y + 200, lowerBoard.y + Math.max(lowerBoard.d - 10, 0)),
      capacity: 200,
    });
    renderEditor(); scheduleRecalc();
  } else if (act === "del-post") {
    const i = +card.dataset.index;
    const row = e.target.closest(".post-row");
    const posts = card.querySelectorAll(".post-row");
    const pi = [...posts].indexOf(row);
    state.layers[i].posts.splice(pi, 1);
    renderEditor(); scheduleRecalc();
  }
});

$("#btnAddLayer").addEventListener("click", () => {
  collectState();
  const i = state.layers.length;
  state.layers.push({
    id: "L" + (i + 1),
    name: `第${i + 1}层${i === 0 ? "（底层）" : i >= 2 ? "（顶层）" : ""}`,
    height: 300,
    board: { x: 100, y: 100, w: Math.max(200, state.car.w - 200), d: Math.max(200, state.car.d - 200), weight: 150 },
    wareWeight: 200,
    posts: [],
  });
  renderEditor(); scheduleRecalc();
});

$("#btnReset").addEventListener("click", async () => {
  if (!confirm("恢复为内置示例数据？当前编辑将被覆盖。")) return;
  const res = await fetch("/api/reset", { method: "POST" });
  const data = await res.json();
  state = data.state; result = data.result;
  selection = null;
  failedSelection = []; simulation = null; simDiff = null; simSeq++;
  suggestData = null; suggestStale = false; suggestPreview = null; suggestSeq++;
  clearTimeout(suggestTimer);
  $("#sugPreviewBar").hidden = true;
  renderEditor(); renderResults(); markLayerBadges();
  setSaveState("saved", "✓ 已恢复示例 " + new Date().toLocaleTimeString("zh-CN"));
});

/* 侧视图切换 */
document.querySelectorAll(".seg-btn").forEach((b) => b.addEventListener("click", () => {
  document.querySelectorAll(".seg-btn").forEach((x) => x.classList.remove("active"));
  b.classList.add("active");
  sideAxis = b.dataset.axis;
  drawSide();
}));

/* ================= 结果汇总/告警 ================= */
function renderResults() {
  renderTotals();
  renderIssues();
  drawTop();
  drawSide();
  renderDetail();
  renderSimPanel();
  renderSuggestOutput();
  syncSugLayerOptions();
}

function renderTotals() {
  const res = baseResult();
  const t = res.totals;
  const issues = res.issues;
  const errs = issues.filter((x) => x.level === "error").length;
  const warns = issues.filter((x) => x.level === "warn").length;
  $("#totals").innerHTML = `
    ${simulation ? `<div class="stat sim"><div class="k">失效推演中</div><div class="v">🔮 ${failedSelection.length}<small> 根立柱失效</small></div></div>` : ""}
    <div class="stat"><div class="k">层数</div><div class="v">${t.layerCount}<small> 层</small></div></div>
    <div class="stat"><div class="k">立柱总数</div><div class="v">${t.postCount}<small> 根</small></div></div>
    <div class="stat"><div class="k">架体总自重</div><div class="v">${fmt(t.ownWeight)}<small> kg（板+坯）</small></div></div>
    <div class="stat"><div class="k">传到台面总载荷</div><div class="v">${fmt(t.carriedAtBottom)}<small> kg</small></div></div>
    <div class="stat ${t.lostLoad > 0 ? "danger" : ""}"><div class="k">悬空丢失载荷</div><div class="v">${fmt(t.lostLoad)}<small> kg</small></div></div>
    <div class="stat ${errs ? "danger" : warns ? "warn" : ""}"><div class="k">告警</div><div class="v">${errs}<small> 严重 / ${warns} 提醒</small></div></div>`;
}

function renderIssues() {
  const res = baseResult();
  const ul = $("#issueList");
  const badge = $("#issueCount");
  badge.textContent = res.issues.length;
  badge.className = "badge" + (res.issues.some((x) => x.level === "error") ? " has-error" : "");
  if (!res.issues.length) {
    ul.innerHTML = `<li class="muted" style="cursor:default">✓ 未发现悬空、落点重叠或超载。</li>`;
    return;
  }
  ul.innerHTML = "";
  res.issues.forEach((iss) => {
    const li = document.createElement("li");
    li.className = iss.level;
    const labelMap = { overload: "超载", hang: "悬空", unsupported: "无支撑", overlap: "落点重叠", invalid: "数据", failed: "失效" };
    li.innerHTML = `<span class="itype">${labelMap[iss.type] || iss.type}</span><span>${escapeHtml(iss.message)}</span>`;
    li.addEventListener("click", () => {
      if (iss.post == null) {
        selection = { kind: "board", layer: iss.layer };
      } else {
        selection = { kind: "post", layer: iss.layer, post: iss.post };
      }
      renderDetail(); drawTop(); drawSide();
    });
    ul.appendChild(li);
  });
}

/* ================= Canvas 公共 ================= */
function setupCanvas(canvas) {
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || 500;
  const cssH = canvas.clientHeight || 360;
  canvas.width = cssW * dpr;
  canvas.height = cssH * dpr;
  const ctx = canvas.getContext("2d");
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { ctx, w: cssW, h: cssH };
}

function postColor(p) {
  if (p.failed) return "#ff5c8a";   // 失效（推演）：与悬空紫色区分
  if (p.hanging) return "#c061e8";
  if (p.overloaded) return "#ef5b6b";
  if (p.overlap) return "#ff8c42";
  return "#34c08a";
}
function isSelected(kind, li, pid) {
  return selection && selection.kind === kind && selection.layer === li && (kind === "board" || selection.post === pid);
}

/* ================= 俯视图 ================= */
function topTransform() {
  const car = viewResult().car;
  const pad = 46;
  const cw = Math.max(car.w, 1);
  const cd = Math.max(car.d, 1);
  const c = $("#topView");
  const W = c.clientWidth || 560;
  const H = Math.max(360, Math.min(560, W * cd / cw + pad * 2));
  c.style.height = H + "px";
  const scale = Math.min((W - pad * 2) / cw, (H - pad * 2) / cd);
  // 台面居中
  const ox = (W - cw * scale) / 2;
  const oy = (H - cd * scale) / 2;
  return {
    scale, ox, oy,
    X: (x) => ox + x * scale,
    Y: (y) => oy + cd * scale - y * scale, // 屏幕 y 向下，世界 y 向上
  };
}

function drawTop() {
  if (!viewResult()) return;
  const canvas = $("#topView");
  const { ctx, w, h } = setupCanvas(canvas);
  topHit.length = 0;
  const tr = topTransform();
  const res = viewResult();
  const car = res.car;

  ctx.clearRect(0, 0, w, h);

  // 台面
  ctx.fillStyle = "rgba(79,157,255,0.07)";
  ctx.strokeStyle = "#3a5a8c";
  ctx.lineWidth = 1.5;
  ctx.fillRect(tr.X(0), tr.Y(car.d), car.w * tr.scale, car.d * tr.scale);
  ctx.strokeRect(tr.X(0), tr.Y(car.d), car.w * tr.scale, car.d * tr.scale);
  ctx.fillStyle = "#8b97ad";
  ctx.font = "10px sans-serif";
  ctx.fillText(`${car.name} ${fmt(car.w)}×${fmt(car.d)} mm`, tr.X(0) + 4, tr.Y(0) + 12);

  // 棚板（半透明，自下而上绘制，上层覆盖在下层之上）
  res.layers.forEach((L, li) => {
    const b = L.board;
    const col = LAYER_COLORS[li % LAYER_COLORS.length];
    ctx.fillStyle = col + "26";
    if (isSelected("board", li)) ctx.fillStyle = col + "55";
    ctx.strokeStyle = col;
    ctx.lineWidth = isSelected("board", li) ? 2.2 : 1.3;
    ctx.fillRect(tr.X(b.x), tr.Y(b.y + b.d), b.w * tr.scale, b.d * tr.scale);
    ctx.strokeRect(tr.X(b.x), tr.Y(b.y + b.d), b.w * tr.scale, b.d * tr.scale);
    ctx.fillStyle = col;
    ctx.fillText(`${L.name} ${fmt(b.w)}×${fmt(b.d)}`, tr.X(b.x) + 4, tr.Y(b.y + b.d) + 11);
    topHit.push({
      kind: "board", layer: li,
      x: tr.X(b.x), y: tr.Y(b.y + b.d), ww: b.w * tr.scale, hh: b.d * tr.scale,
    });
  });

  // 重叠落点（画虚线圆圈强调）
  res.layers.forEach((L) => {
    L.posts.forEach((p) => {
      const cx = tr.X(p.x), cy = tr.Y(p.y);
      if (p.overlap) {
        ctx.beginPath();
        ctx.arc(cx, cy, 9, 0, Math.PI * 2);
        ctx.strokeStyle = "#ff8c42";
        ctx.setLineDash([3, 3]);
        ctx.lineWidth = 1.5;
        ctx.stroke();
        ctx.setLineDash([]);
      }
    });
  });

  // 立柱
  res.layers.forEach((L, li) => {
    L.posts.forEach((p) => {
      const cx = tr.X(p.x), cy = tr.Y(p.y);
      const col = postColor(p);
      const sel = isSelected("post", li, p.id);
      ctx.beginPath();
      ctx.arc(cx, cy, sel ? 7 : 4.5, 0, Math.PI * 2);
      ctx.fillStyle = col;
      ctx.globalAlpha = p.hanging ? 0.35 : p.failed ? 0.6 : 1; // 悬空/失效柱半透明
      ctx.fill();
      ctx.globalAlpha = 1;
      if (p.hanging) {
        // 悬空：红紫色 ✕ 画在圆点之上
        ctx.strokeStyle = "#c061e8";
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.moveTo(cx - 6, cy - 6); ctx.lineTo(cx + 6, cy + 6);
        ctx.moveTo(cx + 6, cy - 6); ctx.lineTo(cx - 6, cy + 6);
        ctx.stroke();
      }
      if (p.failed) {
        // 失效（推演）：粉色 ⊘ 标记，与悬空 ✕ 区分
        ctx.strokeStyle = "#ff5c8a";
        ctx.lineWidth = 1.8;
        ctx.beginPath();
        ctx.arc(cx, cy, 6.5, 0, Math.PI * 2);
        ctx.stroke();
        ctx.beginPath();
        ctx.moveTo(cx - 4.5, cy + 4.5); ctx.lineTo(cx + 4.5, cy - 4.5);
        ctx.stroke();
      }
      if (sel) {
        ctx.strokeStyle = "#fff";
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      if (isSugNewPost(li, p)) {
        // 加柱建议预览：青色粗圆环 + “新”，区别于失效推演的粉色 ⊘
        ctx.beginPath();
        ctx.arc(cx, cy, 10, 0, Math.PI * 2);
        ctx.strokeStyle = "#28e0d2";
        ctx.lineWidth = 2.5;
        ctx.stroke();
        ctx.fillStyle = "#28e0d2";
        ctx.font = "bold 9px sans-serif";
        ctx.fillText("新", cx - 5, cy - 12);
      }
      ctx.fillStyle = "#cdd7ea";
      ctx.font = "9px sans-serif";
      ctx.fillText(`${p.id} ${fmt(p.load)}`, cx + 8, cy - 5);
      topHit.push({ kind: "post", layer: li, post: p.id, x: cx, y: cy, r: 9 });
    });
  });
}

/* 俯视图点击/悬停 */
$("#topView").addEventListener("click", (e) => {
  const hit = pickHit(e, $("#topView"), topHit);
  if (hit) {
    selection = hit.kind === "post"
      ? { kind: "post", layer: hit.layer, post: hit.post }
      : { kind: "board", layer: hit.layer };
    renderDetail(); drawTop(); drawSide();
  }
});

/* ================= 侧视图 ================= */
function sideGeometry() {
  const res = viewResult();
  const car = res.car;
  // 沿观察轴的台面长度
  const axisLen = sideAxis === "x" ? car.w : car.d;
  let zMax = res.layers.reduce((s, L) => s + L.height, 0);
  zMax = Math.max(zMax, 1);
  const c = $("#sideView");
  const W = c.clientWidth || 460;
  const padX = 46, padTop = 30, padBottom = 36;
  const H = Math.max(360, Math.min(560, W * 0.62));
  c.style.height = H + "px";
  const sx = (W - padX * 2) / Math.max(axisLen, 1);
  const sy = (H - padTop - padBottom) / zMax;
  const X = (v) => padX + v * sx;
  const Z = (z) => H - padBottom - z * sy;
  return { axisLen, zMax, X, Z, padBottom, W, H };
}

function drawSide() {
  if (!viewResult()) return;
  const canvas = $("#sideView");
  const { ctx, w, h } = setupCanvas(canvas);
  sideHit.length = 0;
  const g = sideGeometry();
  const res = viewResult();
  const car = res.car;

  ctx.clearRect(0, 0, w, h);

  // 台面（z=0 粗线）
  ctx.strokeStyle = "#3a5a8c";
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(g.X(0), g.Z(0));
  ctx.lineTo(g.X(g.axisLen), g.Z(0));
  ctx.stroke();
  ctx.fillStyle = "#8b97ad";
  ctx.font = "10px sans-serif";
  ctx.fillText(`${car.name}（${sideAxis.toUpperCase()} 向 ${fmt(g.axisLen)} mm）`, g.X(0) + 4, g.Z(0) + 18);

  // 各棚板高度：zPos[i] 为第 i 层棚板（= 第 i 层立柱顶端）的累计高度
  const boardRects = [];
  const zPos = [];
  let acc = 0;
  res.layers.forEach((L, li) => {
    acc += L.height;
    zPos.push(acc);
    const b = L.board;
    const v0 = sideAxis === "x" ? b.x : b.y;
    const v1 = v0 + (sideAxis === "x" ? b.w : b.d);
    boardRects.push({ z: acc, v0, v1, li });
  });

  // 立柱：顶端在本层棚板 zPos[i]，底端落在下层棚板 zPos[i-1]（底层为台面 0）
  res.layers.forEach((L, li) => {
    const zTop = zPos[li];
    const zBottom = li === 0 ? 0 : zPos[li - 1];
    L.posts.forEach((p) => {
      const v = sideAxis === "x" ? p.x : p.y;
      const col = postColor(p);
      const sel = isSelected("post", li, p.id);
      const broken = p.hanging || p.failed; // 悬空/失效均不承载：柱身“短一截”
      ctx.strokeStyle = col;
      ctx.lineWidth = sel ? 3 : 1.8;
      if (broken) ctx.setLineDash([5, 4]);
      ctx.beginPath();
      ctx.moveTo(g.X(v), g.Z(zTop));
      // 悬空/失效柱底端画不到承托面：在层间 60% 处终止，视觉上表现为“短一截”
      const zEnd = broken ? zBottom + (zTop - zBottom) * 0.35 : zBottom;
      ctx.lineTo(g.X(v), g.Z(zEnd));
      ctx.stroke();
      ctx.setLineDash([]);

      // 底端落点标记
      ctx.beginPath();
      ctx.arc(g.X(v), g.Z(zEnd), sel ? 6 : 4, 0, Math.PI * 2);
      if (p.hanging) {
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5;
        ctx.stroke(); // 空心：未接触承托面
        const x0 = g.X(v), y0 = g.Z(zEnd);
        ctx.beginPath();
        ctx.moveTo(x0 - 4, y0 - 4); ctx.lineTo(x0 + 4, y0 + 4);
        ctx.moveTo(x0 + 4, y0 - 4); ctx.lineTo(x0 - 4, y0 + 4);
        ctx.stroke();
      } else if (p.failed) {
        // 失效（推演）：空心圆 + 斜杠 ⊘，与悬空 ✕ 区分
        ctx.strokeStyle = col;
        ctx.lineWidth = 1.5;
        ctx.stroke();
        const x0 = g.X(v), y0 = g.Z(zEnd);
        ctx.beginPath();
        ctx.moveTo(x0 - 4, y0 + 4); ctx.lineTo(x0 + 4, y0 - 4);
        ctx.stroke();
      } else {
        ctx.fillStyle = col;
        ctx.fill();
      }

      // 加柱建议预览：底端落点加青色粗圆环
      if (isSugNewPost(li, p)) {
        ctx.beginPath();
        ctx.arc(g.X(v), g.Z(zEnd), 7, 0, Math.PI * 2);
        ctx.strokeStyle = "#28e0d2";
        ctx.lineWidth = 2.2;
        ctx.stroke();
      }

      // 编号 + 载荷（柱身上端）
      ctx.fillStyle = "#cdd7ea";
      ctx.font = "9px sans-serif";
      ctx.fillText(`${p.id}:${fmt(p.load)}`, g.X(v) + 3, g.Z(zTop) - 3);
      sideHit.push({
        kind: "post", layer: li, post: p.id,
        x: g.X(v), z0: g.Z(zTop), z1: g.Z(zEnd),
      });
    });
  });

  // 棚板线（最后画，覆盖在柱线上）
  boardRects.forEach(({ z: zz, v0, v1, li }) => {
    const col = LAYER_COLORS[li % LAYER_COLORS.length];
    ctx.strokeStyle = col;
    ctx.lineWidth = isSelected("board", li) ? 4 : 2.5;
    ctx.beginPath();
    ctx.moveTo(g.X(v0), g.Z(zz));
    ctx.lineTo(g.X(v1), g.Z(zz));
    ctx.stroke();
    const L = res.layers[li];
    ctx.fillStyle = col;
    ctx.font = "10px sans-serif";
    ctx.fillText(`${L.name} 合计 ${fmt(L.loadTotal)} kg`, g.X(v0) + 3, g.Z(zz) - 7);
    sideHit.push({
      kind: "board", layer: li,
      x0: g.X(v0), x1: g.X(v1), zz: g.Z(zz),
    });
  });

  // z 轴刻度（每层高度）
  ctx.strokeStyle = "#2a3650";
  ctx.fillStyle = "#8b97ad";
  ctx.lineWidth = 1;
  let zz = 0;
  res.layers.forEach((L) => {
    ctx.beginPath();
    ctx.moveTo(g.X(0) - 5, g.Z(zz));
    ctx.lineTo(g.X(0), g.Z(zz));
    ctx.stroke();
    zz += L.height;
  });
  ctx.beginPath();
  ctx.moveTo(g.X(0) - 5, g.Z(zz));
  ctx.lineTo(g.X(0), g.Z(zz));
  ctx.stroke();
  ctx.fillText(`总高 ${fmt(zz)} mm`, g.X(0) - 40, g.Z(zz) - 5);
}

$("#sideView").addEventListener("click", (e) => {
  const rect = $("#sideView").getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  // 柱
  let best = null, bestD = 1e9;
  const distToSeg = (px, pz, x, z0, z1) => {
    const t = Math.max(0, Math.min(1, (pz - z0) / (z1 - z0 || 1)));
    return Math.hypot(px - x, pz - (z0 + t * (z1 - z0)));
  };
  for (const h of sideHit) {
    if (h.kind === "post") {
      const d = distToSeg(mx, my, h.x, h.z0, h.z1);
      if (d < bestD && d < 10) { bestD = d; best = { kind: "post", layer: h.layer, post: h.post }; }
    }
  }
  if (!best) {
    for (const h of sideHit) {
      if (h.kind === "board" && mx >= h.x0 && mx <= h.x1 && Math.abs(my - h.zz) < 8) {
        best = { kind: "board", layer: h.layer };
        break;
      }
    }
  }
  if (best) {
    selection = best;
    renderDetail(); drawTop(); drawSide();
  }
});

function pickHit(e, canvas, hits) {
  const rect = canvas.getBoundingClientRect();
  const mx = e.clientX - rect.left, my = e.clientY - rect.top;
  // 优先立柱
  let best = null, bestD = 1e9;
  for (const h of hits) {
    if (h.kind === "post") {
      const d = Math.hypot(mx - h.x, my - h.y);
      if (d < h.r + 3 && d < bestD) { bestD = d; best = h; }
    }
  }
  if (best) return best;
  for (const h of hits) {
    if (h.kind === "board" && mx >= h.x && mx <= h.x + h.ww && my >= h.y && my <= h.y + h.hh) return h;
  }
  return null;
}

/* ================= 明细面板 ================= */
function renderDetail() {
  const title = $("#detailTitle");
  const body = $("#detailBody");
  if (!selection) {
    title.textContent = "载荷来源明细";
    body.innerHTML = `<p class="muted">点击俯视图/侧视图中的立柱或棚板，查看其载荷来源链。${simulation ? "当前处于失效推演模式，显示推演后的来源链。" : ""}</p>`;
    return;
  }
  const L = viewResult().layers[selection.layer];
  if (selection.kind === "board") return renderBoardDetail(L);
  const p = L && L.posts.find((x) => x.id === selection.post);
  if (p) renderPostDetail(L, p);
}

function statusPills(p) {
  const pills = [];
  // 选中的是加柱建议预览柱：标记为“预览”，数据尚未写入
  if (selection && selection.kind === "post" && isSugNewPost(selection.layer, p)) {
    pills.push(`<span class="pill sug">建议新柱 · 预览</span>`);
  }
  if (p.failed) pills.push(`<span class="pill failed">失效 · 推演</span>`);
  else pills.push(p.hanging ? `<span class="pill hang">悬空</span>` : `<span class="pill ok">有效</span>`);
  if (p.overloaded) pills.push(`<span class="pill bad">超载</span>`);
  if (p.overlap) pills.push(`<span class="pill ovl">与 ${p.overlapWith.join("、")} 落点重叠</span>`);
  return pills.join(" ");
}

function baseLoadOf(L, p) {
  // 基准（未推演）中同层同编号立柱的载荷，用于失效柱说明
  const BL = result && result.layers[L.index];
  const bp = BL && BL.posts.find((x) => x.id === p.id);
  return bp ? bp.load : 0;
}

function renderPostDetail(L, p) {
  $("#detailTitle").textContent = `${L.name} · 立柱 ${p.id}${simulation ? "（推演）" : ""}`;
  const rows = (p.sources || []).map((s) =>
    `<tr><td>${escapeHtml(s.label)}</td><td>${fmt(s.amount)}</td></tr>`).join("");
  const body = $("#detailBody");
  body.innerHTML = `
    <div class="detail-head">
      <span>底端坐标 <b>(${fmt(p.x)}, ${fmt(p.y)})</b></span>
      <span>载荷 <b>${fmt(p.load)} kg</b></span>
      <span>容量 <b>${p.capacity > 0 ? `${fmt(p.capacity)} kg` : "不限"}</b></span>
      ${p.capacity > 0 ? `<span>利用率 <b>${Math.round(p.load / p.capacity * 100)}%</b></span>` : ""}
    </div>
    <div class="detail-head">${statusPills(p)}</div>
    ${selection && isSugNewPost(L.index, p)
      ? `<p class="kvline" style="color:#28e0d2">这是加柱建议的<b>预览立柱</b>，当前架体数据尚未改动；在加柱建议面板点「✓ 确认写入并重算保存」才会写入架体，点「✕ 取消预览」则恢复原状。</p>`
      : p.failed
      ? `<p class="kvline" style="color:#ff5c8a">该柱在推演中被标记为失效，不参与均摊；基准中载荷 ${fmt(baseLoadOf(L, p))} kg 改由本层其余有效柱承担。点击其他立柱可查看推演后的载荷来源链。</p>`
      : p.hanging
      ? `<p class="kvline" style="color:#c061e8">该柱底端未落在${L.supportName}矩形范围内，不参与均摊；本层载荷由其余有效立柱承担。</p>`
      : `<table class="src-table">
          ${rows}
          <tr class="sum"><td>本柱载荷合计（${L.supportedCount} 根有效柱均摊 ${fmt(L.loadTotal)} kg）</td><td>${fmt(p.load)}</td></tr>
        </table>`}
  `;
}

function renderBoardDetail(L) {
  $("#detailTitle").textContent = `${L.name} · 棚板${simulation ? "（推演）" : ""}`;
  const postTable = incomingRowsHtml(L);
  $("#detailBody").innerHTML = `
    <div class="detail-head">
      <span>位置 <b>(${fmt(L.board.x)}, ${fmt(L.board.y)})</b></span>
      <span>尺寸 <b>${fmt(L.board.w)}×${fmt(L.board.d)} mm</b></span>
      <span>承托面 <b>${L.supportName}</b></span>
    </div>
    <p class="kvline">
      棚板自重：<b>${fmt(L.board.weight)} kg</b><br>
      坯件重量：<b>${fmt(L.wareWeight)} kg</b><br>
      上层立柱传来点载荷合计：<b>${fmt(L.loadIncoming)} kg</b><br>
      棚板承受总载荷：<b>${fmt(L.loadTotal)} kg</b><br>
      有效立柱 ${L.supportedCount} 根 / 悬空 ${L.hangingCount} 根${L.failedCount ? ` / 失效 ${L.failedCount} 根` : ""}，
      下传合计 <b>${fmt(L.loadCarried)} kg</b>
      ${L.lostLoad > 0 ? `<br><span style="color:#ef5b6b">无有效支撑，丢失载荷 ${fmt(L.lostLoad)} kg</span>` : ""}
    </p>
    ${postTable}`;
}

function incomingRowsHtml(L) {
  // 展示本板总载荷分摊到每根立柱的结果明细（悬空/失效柱载荷为 0）
  const rows = L.posts.map((p) =>
    `<tr><td>立柱 ${escapeHtml(p.id)} (${fmt(p.x)},${fmt(p.y)}) ${p.failed ? "—失效·推演" : p.hanging ? "—悬空" : ""}</td><td>${fmt(p.load)}</td></tr>`
  ).join("");
  return `<table class="src-table">${rows}<tr class="sum"><td>下传合计</td><td>${fmt(L.loadCarried)}</td></tr></table>`;
}

/* ================= 失效推演面板 ================= */
function renderSimPanel() {
  renderSimPicker();
  renderSimOutput();
}

function renderSimPicker() {
  const box = $("#simPicker");
  if (!box) return;
  box.innerHTML = "";
  if (!result) return;
  // 勾选列表基于基准结果：悬空柱本就不承载，不可选为失效柱
  result.layers.forEach((L, li) => {
    const row = document.createElement("div");
    row.className = "sim-layer";
    const name = document.createElement("span");
    name.className = "sim-layer-name";
    name.textContent = L.name;
    row.appendChild(name);
    const chips = document.createElement("div");
    chips.className = "sim-chips";
    if (!L.posts.length) {
      chips.innerHTML = `<span class="muted" style="font-size:11px">（无立柱）</span>`;
    }
    L.posts.forEach((p) => {
      const checked = isFailed(li, p.id);
      const chip = document.createElement("label");
      chip.className = "sim-chip" + (p.hanging ? " hanging" : "") + (checked ? " checked" : "");
      chip.title = p.hanging
        ? "悬空柱本就不承载，无需失效推演"
        : `基准载荷 ${fmt(p.load)} kg，勾选后视为失效（不承载）`;
      chip.innerHTML = p.hanging
        ? `<input type="checkbox" disabled> ${escapeHtml(p.id)} <small>悬空</small>`
        : `<input type="checkbox" ${checked ? "checked" : ""}> ${escapeHtml(p.id)} <small>${fmt(p.load)}kg</small>`;
      if (!p.hanging) {
        chip.querySelector("input").addEventListener("change", (e) => {
          toggleFailed(li, p.id, e.target.checked);
        });
      }
      chips.appendChild(chip);
    });
    row.appendChild(chips);
    box.appendChild(row);
  });
}

function renderSimOutput() {
  const out = $("#simOutput");
  const status = $("#simStatus");
  const btn = $("#btnClearSim");
  if (!out) return;
  const active = !!(simulation && simDiff);
  status.textContent = active ? `推演中 · 失效 ${failedSelection.length} 根` : "未启用";
  status.className = "badge" + (active ? " has-sim" : "");
  btn.disabled = !active && !failedSelection.length;
  if (!active) {
    out.innerHTML = `<p class="muted" style="margin:8px 0 0">当前显示基准结果。勾选失效柱后，此处并排展示基准与推演的台面载荷、丢失载荷及每根立柱载荷差值，并单独列出推演新增的超载 / 无支撑项。</p>`;
    return;
  }
  const d = simDiff;
  const cmpCard = (label, pair, badWhen) => {
    const bad = badWhen === "up" ? pair.delta > 0 : pair.delta < 0;
    return `<div class="stat ${bad ? "danger" : ""}">
      <div class="k">${label}</div>
      <div class="v">${fmt(pair.base)} → ${fmt(pair.sim)}<small> kg</small></div>
      <div class="delta ${pair.delta > 0 ? "up" : pair.delta < 0 ? "down" : ""}">Δ ${pair.delta > 0 ? "+" : ""}${fmt(pair.delta)} kg</div>
    </div>`;
  };
  const labelMap = { overload: "超载", unsupported: "无支撑" };
  const newIssuesHtml = d.newIssues.length
    ? d.newIssues.map((iss) =>
        `<li class="${iss.level}" data-layer="${iss.layer}" data-post="${iss.post == null ? "" : escapeHtml(iss.post)}">
           <span class="itype">${labelMap[iss.type] || iss.type}</span><span>${escapeHtml(iss.message)}</span>
         </li>`).join("")
    : `<li class="muted" style="cursor:default">✓ 推演未新增超载或无支撑项。</li>`;
  const rows = d.posts.map((p) => `
    <tr class="${p.failed ? "is-failed" : ""}">
      <td>${escapeHtml(p.layerName)}</td>
      <td>${escapeHtml(p.post)}${p.failed ? ' <span class="tag-failed">失效</span>' : p.hanging ? ' <span class="tag-hang">悬空</span>' : ""}</td>
      <td>${fmt(p.base)}</td>
      <td>${fmt(p.sim)}</td>
      <td class="${p.delta > 0 ? "up" : p.delta < 0 ? "down" : ""}">${p.delta > 0 ? "+" : ""}${fmt(p.delta)}</td>
    </tr>`).join("");
  out.innerHTML = `
    <div class="sim-compare">
      ${cmpCard("传到台面总载荷（基准 → 推演）", d.carriedAtBottom, "down")}
      ${cmpCard("丢失载荷（基准 → 推演）", d.lostLoad, "up")}
    </div>
    <div class="sim-cols">
      <div>
        <div class="sub-title">推演新增超载 / 无支撑</div>
        <ul id="simNewIssues">${newIssuesHtml}</ul>
      </div>
      <div>
        <div class="sub-title">每根立柱载荷差值（基准 → 推演，kg）</div>
        <div class="diff-table-wrap">
          <table class="src-table diff-table">
            <tr class="head"><td>层</td><td>立柱</td><td>基准</td><td>推演</td><td>差值</td></tr>
            ${rows}
          </table>
        </div>
      </div>
    </div>`;
  // 新增问题可点击定位到对应立柱/棚板
  out.querySelectorAll("#simNewIssues li[data-layer]").forEach((li) => {
    li.addEventListener("click", () => {
      const layer = +li.dataset.layer;
      selection = li.dataset.post
        ? { kind: "post", layer, post: li.dataset.post }
        : { kind: "board", layer };
      renderDetail(); drawTop(); drawSide();
    });
  });
}

$("#btnClearSim").addEventListener("click", clearSimulation);

/* ================= 加柱建议（What-if） =================
 * 目标层承托面内、与现有有效柱距离 > 10mm 的网格点逐点试算新增一根立柱；
 * 试算结果只保存在会话内（suggestData），点击方案仅在视图中预览，
 * 确认后才经 collectState + PUT /api/state 写入架体（走原有自动保存），
 * 取消预览 / 重新编辑 / 切换参数均不改动任何架体数据。
 */
function syncSugLayerOptions() {
  const sel = $("#sugLayer");
  if (!sel || !result) return;
  const prev = sel.value;
  const html = result.layers.map((L, li) =>
    `<option value="${li}">第 ${li + 1} 层 · ${escapeHtml(L.name)}</option>`).join("");
  if (sel.innerHTML !== html) sel.innerHTML = html;
  // 尽量保留原选择；结构变化导致越界时回退到最后一层
  sel.value = prev && +prev < result.layers.length ? prev : String(result.layers.length - 1);
}

function scheduleSuggest() {
  if (!result) return;
  clearTimeout(suggestTimer);
  suggestTimer = setTimeout(runSuggest, 300);
}

async function runSuggest() {
  if (!state || !result) return;
  syncSugLayerOptions();
  const layer = +$("#sugLayer").value;
  const spacing = num($("#sugSpacing").value);
  const capacity = Math.max(0, num($("#sugCapacity").value));
  const seq = ++suggestSeq;
  const status = $("#sugStatus");
  status.textContent = "试算中…";
  status.className = "badge";
  // 参数变化后旧预览失效（预览中的方案属于旧参数）
  cancelSuggestPreview(true);
  let data = null;
  try {
    const res = await fetch("/api/suggest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ state, layer, spacing, capacity }),
    });
    if (!res.ok) throw new Error("suggest failed");
    data = await res.json();
  } catch (e) {
    data = suggestLocal(state, layer, spacing, capacity); // 离线兜底：与后端同一套算法
  }
  if (seq !== suggestSeq) return; // 已有更新的试算请求，丢弃过期响应
  suggestData = data;
  suggestStale = false;
  renderSuggestOutput();
}

function renderSuggestOutput() {
  const out = $("#sugOutput");
  const status = $("#sugStatus");
  if (!out) return;
  if (!suggestData) {
    status.textContent = "未试算";
    status.className = "badge";
    out.innerHTML = `<p class="muted" style="margin:8px 0 0">设置目标层、候选网格间距与新柱容量后点击「开始逐点试算」；编辑架体后会按当前参数自动重新试算。</p>`;
    return;
  }
  const d = suggestData;
  if (!d.feasible) {
    status.textContent = "无可行点";
    status.className = "badge has-error";
    out.innerHTML = `
      <div class="sug-infeasible">
        <b>⚠ 没有可加柱的位置</b>
        <p>${escapeHtml(d.reason)}</p>
        <p class="muted" style="font-size:11px">
          可尝试：调大/调小候选网格间距、增大承托棚板尺寸，或先移动与候选点冲突的现有立柱。
          本操作只试算，未改动架体数据。
        </p>
      </div>`;
    return;
  }
  const bm = d.baselineMetrics;
  status.textContent = `${d.tried} 个可行点 · 前 ${d.proposals.length} 方案`;
  status.className = "badge has-sug";
  const pct = (u) => (u == null ? "—" : Math.round(u * 100) + "%");
  const metric = (label, val, base, bad) =>
    `<div class="stat sug-mini ${bad ? "danger" : ""}"><div class="k">${label}</div>
      <div class="v">${val}</div><div class="delta">基准 ${base}</div></div>`;
  out.innerHTML = `
    <div class="sug-summary muted">
      目标层 <b>${escapeHtml(d.proposals[0].layerName)}</b>：承托面内网格 ${d.gridCount} 点，
      排除与现有有效柱距离 ≤ ${d.toleranceMm} mm 的点后，<b>${d.tried}</b> 个可行点逐点整架重算；
      基准丢失 ${fmt(bm.lostLoad)} kg · 超载 ${bm.overloadCount} 根 · 最高利用率 ${pct(bm.maxUtilization)}
    </div>
    <div class="sug-list">
      ${d.proposals.map((p, i) => {
        const m = p.metrics;
        const added = p.diff.addedIssues, removed = p.diff.removedIssues;
        const sel = suggestPreview && suggestPreview.plan === p;
        return `
        <div class="sug-card${sel ? " selected" : ""}" data-i="${i}">
          <div class="sug-card-head">
            <span class="sug-rank">方案 ${i + 1}</span>
            <span class="sug-coord">新柱 ${escapeHtml(p.postId)} · 坐标 (${fmt(p.x)}, ${fmt(p.y)})${p.capacity > 0 ? ` · 容量 ${fmt(p.capacity)} kg` : " · 容量不限"}</span>
          </div>
          <div class="sug-metrics">
            ${metric("丢失载荷 (kg)", fmt(m.lostLoad), fmt(bm.lostLoad), m.lostLoad > 0)}
            ${metric("超载数 (根)", m.overloadCount, bm.overloadCount, m.overloadCount > 0)}
            ${metric("最高利用率", pct(m.maxUtilization), pct(bm.maxUtilization), m.maxUtilization > 1)}
          </div>
          <div class="sug-layer-table-wrap">
            <table class="src-table sug-layer-table">
              <tr class="head"><td>层</td><td>板载合计 基准→方案</td><td>下传 基准→方案</td><td>丢失 基准→方案</td><td>有效柱</td></tr>
              ${p.diff.layers.map((row) => `
                <tr class="${row.index === p.layer ? "sug-target" : ""}">
                  <td>${escapeHtml(row.name)}${row.index === p.layer ? " ◀" : ""}</td>
                  <td>${fmt(row.loadTotal.base)} → <b>${fmt(row.loadTotal.cand)}</b></td>
                  <td>${fmt(row.loadCarried.base)} → ${fmt(row.loadCarried.cand)}</td>
                  <td class="${row.lostLoad.cand > 0 ? "up" : row.lostLoad.delta < 0 ? "down" : ""}">${fmt(row.lostLoad.base)} → ${fmt(row.lostLoad.cand)}</td>
                  <td>${row.supportedCount.base} → ${row.supportedCount.cand}</td>
                </tr>`).join("")}
            </table>
          </div>
          <div class="sug-issues">
            <div class="sug-issue-col">
              <div class="sub-title">消除告警 ${removed.length}</div>
              ${removed.length
                ? `<ul class="sug-issue-list">${removed.map((iss) => sugIssueHtml(iss, "removed")).join("")}</ul>`
                : `<div class="muted" style="font-size:11px">无</div>`}
            </div>
            <div class="sug-issue-col">
              <div class="sub-title">新增告警 ${added.length}</div>
              ${added.length
                ? `<ul class="sug-issue-list">${added.map((iss) => sugIssueHtml(iss, "added")).join("")}</ul>`
                : `<div class="muted" style="font-size:11px">✓ 无新增告警</div>`}
            </div>
          </div>
          <div class="sug-card-foot">
            <span class="muted" style="font-size:11px">点击卡片在俯视图预览</span>
            <span>
              <button class="btn btn-sug btn-sm" type="button" data-act="preview" data-i="${i}">👁 预览</button>
              <button class="btn btn-sug btn-sm" type="button" data-act="confirm" data-i="${i}">✓ 确认写入</button>
            </span>
          </div>
        </div>`;
      }).join("")}
    </div>`;
  out.querySelectorAll(".sug-card").forEach((card) => {
    const i = +card.dataset.i;
    card.addEventListener("click", (e) => {
      if (suggestStale) return; // 重算中：旧卡片只展示，不响应预览/确认
      const btn = e.target.closest("button[data-act]");
      if (btn && btn.dataset.act === "confirm") {
        previewSuggestPlan(d.proposals[i]);
        confirmSuggestPreview();
      } else {
        previewSuggestPlan(d.proposals[i]); // 卡片或「预览」按钮：仅预览
      }
    });
  });
  if (suggestStale) {
    out.querySelectorAll(".sug-card button").forEach((b) => { b.disabled = true; });
    out.insertAdjacentHTML("beforeend",
      `<p class="muted" style="font-size:11px;margin:4px 0 0">架体已修改，正在按当前参数重新试算…</p>`);
  }
}

const SUG_ISSUE_LABELS = { overload: "超载", hang: "悬空", unsupported: "无支撑", overlap: "落点重叠", invalid: "数据" };
function sugIssueHtml(iss, kind) {
  return `<li class="${kind}" data-layer="${iss.layer}" data-post="${iss.post == null ? "" : escapeHtml(iss.post)}">
    <span class="itype">${SUG_ISSUE_LABELS[iss.type] || iss.type}</span>
    <span>${escapeHtml(iss.message)}</span></li>`;
}

function isSugNewPost(li, p) {
  return suggestPreview
    && li === suggestPreview.plan.layer
    && p.id === suggestPreview.plan.postId
    && p.x === suggestPreview.plan.x
    && p.y === suggestPreview.plan.y;
}

function previewSuggestPlan(plan) {
  suggestPreview = { plan, result: plan.result };
  selection = { kind: "post", layer: plan.layer, post: plan.postId };
  $("#sugPreviewBar").hidden = false;
  $("#sugPreviewText").innerHTML =
    `👁 预览中：${escapeHtml(plan.layerName)} 新增立柱 <b>${escapeHtml(plan.postId)}</b> @ (${fmt(plan.x)}, ${fmt(plan.y)})，
     试算载荷 <b>${fmt(plan.result.layers[plan.layer].posts.find((q) => q.id === plan.postId).load)} kg</b>。
     尚未写入架体；确认后才会保存，取消不改数据。`;
  renderSuggestOutput();
  drawTop();
  drawSide();
  renderDetail();
}

async function confirmSuggestPreview() {
  if (!suggestPreview) return;
  const p = suggestPreview.plan;
  collectState(); // 以编辑器当前内容为准（避免覆盖尚未采集的输入）
  const layer = state.layers[p.layer];
  if (!layer) { cancelSuggestPreview(); runSuggest(); return; }
  // 重新生成不与现有编号冲突的新柱号（编辑器内编号可能已变化）
  const ids = new Set(layer.posts.map((q) => q.id));
  let k = 1, id = p.postId;
  while (ids.has(id)) { id = "P" + (++k); }
  layer.posts.push({ id, x: p.x, y: p.y, capacity: p.capacity });
  const bar = $("#sugPreviewBar");
  bar.hidden = true;
  suggestPreview = null;
  suggestData = null;
  renderEditor();
  // 经 PUT /api/state 触发原有自动保存；保存后显式重跑一次建议（避免重复触发）
  await recalcAndRender({ skipSuggest: true });
  runSuggest();
}

function cancelSuggestPreview(silent) {
  if (!suggestPreview) {
    if (!silent) {
      $("#sugPreviewBar").hidden = true;
      renderSuggestOutput();
    }
    return;
  }
  suggestPreview = null;
  $("#sugPreviewBar").hidden = true;
  selection = null;
  if (!silent) {
    renderSuggestOutput();
    drawTop();
    drawSide();
    renderDetail();
  }
}

$("#btnSuggest").addEventListener("click", runSuggest);
$("#sugLayer").addEventListener("change", runSuggest);
$("#sugSpacing").addEventListener("input", scheduleSuggest);
$("#sugCapacity").addEventListener("input", scheduleSuggest);
$("#btnSugConfirm").addEventListener("click", confirmSuggestPreview);
$("#btnSugCancel").addEventListener("click", () => cancelSuggestPreview());

/* ================= 画布随窗口缩放重绘 ================= */
window.addEventListener("resize", debounce(() => { drawTop(); drawSide(); }, 150));

/* ================= 启动 ================= */
async function init() {
  setSaveState("", "加载中…");
  try {
    const res = await fetch("/api/result");
    const r = await res.json();
    result = r;
    const sres = await fetch("/api/state");
    state = await sres.json();
  } catch (err) {
    alert("无法连接后端计算服务：" + err);
    return;
  }
  renderEditor();
  renderResults();
  markLayerBadges();
  setSaveState("saved", "✓ 就绪 " + new Date().toLocaleTimeString("zh-CN"));
  runSuggest();
}
init();

/* ======================================================================
 * 离线兜底：后端不可用时在浏览器内执行同一套分摊算法（逻辑与 app/calc.py 对齐）
 * ==================================================================== */
function calculateLocal(raw, failed) {
  const failedSet = new Set((failed || []).map((f) => `${f.layer}|${f.post}`));
  const car = {
    name: (raw.car && raw.car.name) || "窑车台面",
    w: Math.max(0, num(raw.car && raw.car.w)),
    d: Math.max(0, num(raw.car && raw.car.d)),
  };
  const layers = (raw.layers || []).map((l0, idx) => {
    const b0 = l0.board || {};
    return {
      id: l0.id || "L" + idx,
      name: l0.name || "第" + (idx + 1) + "层",
      height: Math.max(0, num(l0.height)),
      board: { x: num(b0.x), y: num(b0.y), w: Math.max(0, num(b0.w)), d: Math.max(0, num(b0.d)), weight: Math.max(0, num(b0.weight)) },
      wareWeight: Math.max(0, num(l0.wareWeight)),
      posts: (l0.posts || []).map((p0, j) => ({ id: p0.id || "P" + (j + 1), x: num(p0.x), y: num(p0.y), capacity: num(p0.capacity) })),
    };
  });
  const n = layers.length;
  const inRect = (x, y, r) => x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.d;
  const R = (v) => Math.round(v * 100) / 100;
  const incoming = Array.from({ length: n }, () => []);
  const issues = [];
  const outLayers = [];
  let totalOwn = 0, totalLost = 0;
  const carRect = { x: 0, y: 0, w: car.w, d: car.d };

  for (let i = n - 1; i >= 0; i--) {
    const L = layers[i], b = L.board;
    const bw = b.weight, ww = L.wareWeight;
    totalOwn += bw + ww;
    const points = incoming[i];
    const loadIn = points.reduce((s, p) => s + p.items.reduce((a, it) => a + it.amount, 0), 0);
    const total = bw + ww + loadIn;
    const supportRect = i === 0 ? carRect : { x: layers[i - 1].board.x, y: layers[i - 1].board.y, w: layers[i - 1].board.w, d: layers[i - 1].board.d };
    const supportName = i === 0 ? car.name : layers[i - 1].name + "棚板";

    const posts = L.posts.map((p) => {
      const hanging = !inRect(p.x, p.y, supportRect);
      const isFailed = !hanging && failedSet.has(i + "|" + p.id);
      if (hanging) issues.push({ level: "error", type: "hang", layer: i, post: p.id,
        message: `${L.name} 立柱 ${p.id}（${R(p.x)}, ${R(p.y)}）底端悬空，未落在${supportName}范围内，不承载` });
      else if (isFailed) issues.push({ level: "info", type: "failed", layer: i, post: p.id,
        message: `${L.name} 立柱 ${p.id} 被标记为失效（推演），按不承载参与整架重新分摊` });
      return { id: p.id, x: R(p.x), y: R(p.y), capacity: R(p.capacity), load: 0, hanging, failed: isFailed, overlap: false, overloaded: false, overlapWith: [], sources: [] };
    });
    const supported = posts.filter((p) => !p.hanging && !p.failed);
    const unsupported = supported.length === 0;
    let lost = 0;
    if (unsupported && total > 0) {
      lost = total; totalLost += lost;
      const hangN = posts.filter((p) => p.hanging).length;
      const failN = posts.filter((p) => p.failed).length;
      issues.push({ level: "error", type: "unsupported", layer: i, post: null,
        message: failN && L.posts.length
          ? `${L.name}全部 ${L.posts.length} 根立柱均不承载（悬空 ${hangN} 根、失效 ${failN} 根），棚板载荷 ${R(total)} kg 无支撑、无法下传`
          : `${L.name}没有有效立柱，棚板载荷 ${R(total)} kg 无支撑、无法下传` });
    }
    const c = supported.length;
    if (c > 0) {
      const share = total / c;
      supported.forEach((po) => {
        po.load = R(share);
        po.overloaded = po.capacity > 0 && share > po.capacity + 1e-9;
        const sources = [];
        if (bw > 0) sources.push({ label: "本层棚板自重", amount: R(bw / c) });
        if (ww > 0) sources.push({ label: "本层坯件重量", amount: R(ww / c) });
        points.forEach((pt) => pt.items.forEach((it) => sources.push({ label: it.chain, amount: R(it.amount / c) })));
        const agg = {};
        sources.forEach((s) => { agg[s.label] = (agg[s.label] || 0) + s.amount; });
        po.sources = Object.entries(agg).map(([label, amount]) => ({ label, amount: R(amount) }));
      });
    }
    // 重叠分组（并查集，距离 <= TOL_MM，与 app/calc.py 对齐）
    const Np = supported.length;
    const parent = Array.from({ length: Np }, (_, k) => k);
    const find = (a) => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
    for (let a = 0; a < Np; a++) {
      for (let bb2 = a + 1; bb2 < Np; bb2++) {
        if (Math.hypot(supported[a].x - supported[bb2].x, supported[a].y - supported[bb2].y) <= TOL_MM) {
          parent[find(bb2)] = find(a);
        }
      }
    }
    const groupsMap = {};
    for (let a = 0; a < Np; a++) (groupsMap[find(a)] = groupsMap[find(a)] || []).push(a);
    const groups = Object.values(groupsMap).filter((g) => g.length >= 2);
    groups.forEach((group) => {
      const ids = group.map((g) => supported[g].id);
      group.forEach((g) => {
        supported[g].overlap = true;
        supported[g].overlapWith = ids.filter((x) => x !== supported[g].id);
      });
      issues.push({ level: "warn", type: "overlap", layer: i, post: ids[0],
        message: `${L.name} 立柱 ${ids.join("、")} 底端落在同一坐标，对${supportName}的合并点载荷 ${R(group.reduce((s, g) => s + supported[g].load, 0))} kg` });
    });
    supported.forEach((po) => {
      if (po.overloaded) issues.push({ level: "error", type: "overload", layer: i, post: po.id,
        message: `${L.name} 立柱 ${po.id} 超载：载荷 ${po.load} kg > 容量 ${po.capacity} kg` });
    });
    // 向下传点载荷；重叠簇合并为一个点
    if (i > 0 && !unsupported) {
      const clustered = new Set();
      groups.forEach((g) => g.forEach((x) => clustered.add(x)));
      const pushPoint = (members) => {
        const rep = supported[members[0]];
        const items = [];
        members.forEach((g) => {
          const q = supported[g];
          const own = (bw + ww) / c;
          if (own > 0) items.push({ chain: `${L.name}·${q.id}`, amount: own });
          points.forEach((pt) => pt.items.forEach((it) => items.push({ chain: `${it.chain} → ${L.name}·${q.id}`, amount: it.amount / c })));
        });
        const agg = {};
        items.forEach((it) => { agg[it.chain] = (agg[it.chain] || 0) + it.amount; });
        incoming[i - 1].push({ x: rep.x, y: rep.y, items: Object.entries(agg).map(([chain, amount]) => ({ chain, amount: R(amount) })) });
      };
      groups.forEach((g) => pushPoint(g));
      supported.forEach((po, idx) => { if (!clustered.has(idx)) pushPoint([idx]); });
    }
    outLayers.push({
      index: i, id: L.id, name: L.name, height: R(L.height),
      board: { x: R(b.x), y: R(b.y), w: R(b.w), d: R(b.d), weight: R(b.weight) },
      wareWeight: R(ww), supportKind: i === 0 ? "car" : "board", supportName,
      supportRect: { ...supportRect, x: R(supportRect.x), y: R(supportRect.y), w: R(supportRect.w), d: R(supportRect.d) },
      loadOwn: R(bw + ww), loadIncoming: R(loadIn), loadTotal: R(total),
      loadCarried: R(posts.reduce((s, p) => s + p.load, 0)), lostLoad: R(lost),
      supportedCount: c,
      hangingCount: posts.filter((p) => p.hanging).length,
      failedCount: posts.filter((p) => p.failed).length,
      posts,
    });
  }
  outLayers.reverse();
  const order = { overload: 0, hang: 1, unsupported: 2, failed: 3, overlap: 4, invalid: 5 };
  issues.sort((a, z) =>
    (order[a.type] ?? 9) - (order[z.type] ?? 9)
    || a.layer - z.layer
    || String(a.post || "").localeCompare(String(z.post || "")));
  return {
    car, layers: outLayers, issues,
    totals: {
      ownWeight: R(totalOwn),
      carriedAtBottom: outLayers.length ? outLayers[0].loadCarried : 0,
      lostLoad: R(totalLost),
      postCount: outLayers.reduce((s, L) => s + L.posts.length, 0),
      failedCount: outLayers.reduce((s, L) => s + (L.failedCount || 0), 0),
      layerCount: n,
    },
    toleranceMm: TOL_MM,
  };
}

/* 失效推演离线兜底：基准 vs 推演并排对比（与 app/calc.py 的 simulate 对齐） */
function simulateLocal(raw, failed) {
  const baseline = calculateLocal(raw);
  const simulation = calculateLocal(raw, failed);
  const applied = [];
  simulation.layers.forEach((L) => L.posts.forEach((p) => {
    if (p.failed) applied.push({ layer: L.index, layerName: L.name, post: p.id });
  }));
  return { baseline, simulation, failed: applied, diff: diffResults(baseline, simulation) };
}

function diffResults(base, sim) {
  const key = (e) => `${e.type}|${e.layer}|${e.post}`;
  const baseKeys = new Set(base.issues.map(key));
  const newIssues = sim.issues.filter(
    (e) => (e.type === "overload" || e.type === "unsupported") && !baseKeys.has(key(e))
  );
  const basePosts = {};
  base.layers.forEach((L) => L.posts.forEach((p) => { basePosts[L.index + "|" + p.id] = p; }));
  const posts = [];
  sim.layers.forEach((L) => L.posts.forEach((p) => {
    const b = basePosts[L.index + "|" + p.id] || { load: 0 };
    posts.push({
      layer: L.index, layerName: L.name, post: p.id,
      base: b.load, sim: p.load, delta: r2(p.load - b.load),
      failed: !!p.failed, hanging: !!p.hanging, overloaded: !!p.overloaded,
    });
  }));
  const pair = (k) => ({ base: base.totals[k], sim: sim.totals[k], delta: r2(sim.totals[k] - base.totals[k]) });
  return {
    carriedAtBottom: pair("carriedAtBottom"),
    lostLoad: pair("lostLoad"),
    posts,
    newIssues,
  };
}

/* ======================================================================
 * 加柱建议离线兜底：与 app/calc.py 的 suggest_posts 对齐（纯试算，不改输入）
 * ==================================================================== */
function suggestLocal(raw, layer, spacing, capacity) {
  const payload = (feasible, reason, extra) => ({
    feasible, reason, layer, spacing: R0(spacing), capacity: R0(Math.max(0, num(capacity))),
    toleranceMm: TOL_MM, tried: 0, gridCount: 0, topN: 5,
    baseline: null, proposals: [], ...(extra || {}),
  });
  const R0 = (v) => Math.round(num(v) * 100) / 100;
  const li = Math.trunc(num(layer));
  const gap = num(spacing);
  const cap = Math.max(0, num(capacity));
  if (!Number.isFinite(li)) return payload(false, "未选择有效的目标层，请先选择要加柱的层。");
  const n = (raw.layers || []).length;
  if (!(li >= 0 && li < n)) return payload(false, `目标层序号 ${li} 不存在（当前共 ${n} 层），请重新选择。`);
  if (!(gap > 0)) return payload(false, "候选网格间距必须大于 0 mm，请调大间距后重试。");

  // 深拷贝（试算要往里加柱，不能污染编辑器数据）
  const st = JSON.parse(JSON.stringify(raw));
  const layers = st.layers || [];
  const support = li === 0
    ? { x: 0, y: 0, w: Math.max(0, num(st.car && st.car.w)), d: Math.max(0, num(st.car && st.car.d)) }
    : (() => { const b = layers[li - 1].board || {}; return { x: num(b.x), y: num(b.y), w: Math.max(0, num(b.w)), d: Math.max(0, num(b.d)) }; })();
  const supportName = li === 0 ? ((st.car && st.car.name) || "窑车台面") : layers[li - 1].name + "棚板";
  if (!(support.w > 0) || !(support.d > 0)) {
    return payload(false, `${supportName}宽/深为 0，没有可放置新柱的承托面，请先修正该棚板尺寸。`);
  }

  const nx = Math.floor(support.w / gap + 1e-9) + 1;
  const ny = Math.floor(support.d / gap + 1e-9) + 1;
  const gridCount = nx * ny;
  if (gridCount > SUGGEST_MAX_GRID) {
    return payload(false,
      `按间距 ${R0(gap)} mm 生成的候选网格共 ${gridCount} 个点，超过逐点试算上限 ${SUGGEST_MAX_GRID} 个；请调大候选网格间距后重试。`,
      { gridCount });
  }

  const baseline = calculateLocal(st);
  const validPts = baseline.layers[li].posts.filter((p) => !p.hanging).map((p) => [p.x, p.y]);
  const ids = new Set(layers[li].posts.map((p) => p.id));
  let kk = 1; while (ids.has("P" + kk)) kk++;
  const newId = "P" + kk;

  const scored = [];
  let tried = 0;
  for (let ix = 0; ix < nx; ix++) {
    let cx = support.x + ix * gap;
    if (cx > support.x + support.w + 1e-9) cx = support.x + support.w;
    for (let iy = 0; iy < ny; iy++) {
      let cy = support.y + iy * gap;
      if (cy > support.y + support.d + 1e-9) cy = support.y + support.d;
      if (validPts.some(([px, py]) => Math.hypot(cx - px, cy - py) <= TOL_MM + 1e-9)) continue;
      tried++;
      const trial = JSON.parse(JSON.stringify(st));
      trial.layers[li].posts.push({ id: newId, x: cx, y: cy, capacity: cap });
      const res = calculateLocal(trial);
      const lostLoad = res.totals.lostLoad;
      const overloadN = res.issues.filter((e) => e.type === "overload").length;
      let maxUtil = 0;
      res.layers.forEach((L) => L.posts.forEach((p) => {
        if (p.capacity > 0) maxUtil = Math.max(maxUtil, p.load / p.capacity);
      }));
      scored.push({ lostLoad, overloadN, maxUtil, x: cx, y: cy, res });
    }
  }
  if (!scored.length) {
    return payload(false,
      `承托面（${supportName}）内 ${gridCount} 个网格点${validPts.length ? `、全部落在现有有效柱 ${TOL_MM} mm 重叠阈值范围内` : ""}，没有满足“承托面内且与现有有效柱距离大于重叠阈值”的可加柱位置。`,
      { baseline, gridCount });
  }
  scored.sort((a, b) =>
    (a.lostLoad - b.lostLoad)
    || (a.overloadN - b.overloadN)
    || (a.maxUtil - b.maxUtil)
    || (a.x - b.x)
    || (a.y - b.y));
  const proposals = scored.slice(0, 5).map((s) => ({
    layer: li,
    layerName: layers[li].name,
    postId: newId,
    x: R0(s.x), y: R0(s.y), capacity: R0(cap),
    metrics: { lostLoad: s.lostLoad, overloadCount: s.overloadN, maxUtilization: Math.round(s.maxUtil * 1e4) / 1e4 },
    result: s.res,
    diff: suggestDiffLocal(baseline, s.res),
  }));
  const bOvl = baseline.issues.filter((e) => e.type === "overload").length;
  let bUtil = 0;
  baseline.layers.forEach((L) => L.posts.forEach((p) => {
    if (p.capacity > 0) bUtil = Math.max(bUtil, p.load / p.capacity);
  }));
  return {
    feasible: true, reason: "", layer: li, spacing: R0(gap), capacity: R0(cap),
    toleranceMm: TOL_MM, tried, gridCount, topN: 5,
    baseline, proposals,
    baselineMetrics: { lostLoad: baseline.totals.lostLoad, overloadCount: bOvl, maxUtilization: Math.round(bUtil * 1e4) / 1e4 },
  };
}

function suggestDiffLocal(base, cand) {
  const keyOf = (e) => `${e.type}|${e.layer}|${e.post}`;
  const baseMap = new Map(base.issues.filter((e) => e.level !== "info").map((e) => [keyOf(e), e]));
  const candMap = new Map(cand.issues.filter((e) => e.level !== "info").map((e) => [keyOf(e), e]));
  const added = [], removed = [];
  candMap.forEach((e, k) => { if (!baseMap.has(k)) added.push(e); });
  baseMap.forEach((e, k) => { if (!candMap.has(k)) removed.push(e); });
  const sortFn = (a, z) => a.layer - z.layer || a.type.localeCompare(z.type) || String(a.post).localeCompare(String(z.post));
  added.sort(sortFn); removed.sort(sortFn);
  const baseLayers = new Map(base.layers.map((L) => [L.index, L]));
  const rows = cand.layers.map((L) => {
    const b = baseLayers.get(L.index) || {};
    const pair = (key) => ({ base: b[key] || 0, cand: L[key], delta: r2(L[key] - (b[key] || 0)) });
    return {
      index: L.index, name: L.name,
      loadTotal: pair("loadTotal"), loadCarried: pair("loadCarried"), lostLoad: pair("lostLoad"),
      supportedCount: { base: b.supportedCount || 0, cand: L.supportedCount },
    };
  });
  const pairT = (key) => ({ base: base.totals[key], cand: cand.totals[key], delta: r2(cand.totals[key] - base.totals[key]) });
  return {
    totals: { carriedAtBottom: pairT("carriedAtBottom"), lostLoad: pairT("lostLoad") },
    layers: rows, addedIssues: added, removedIssues: removed,
  };
}
