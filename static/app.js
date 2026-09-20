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
const viewResult = () => simulation || result; // 当前展示用结果：推演进行中为推演值，否则为基准
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
async function recalcAndRender() {
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
  renderResults();
  markLayerBadges();
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
}

function renderTotals() {
  const res = viewResult();
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
  const res = viewResult();
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
    ${p.failed
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
