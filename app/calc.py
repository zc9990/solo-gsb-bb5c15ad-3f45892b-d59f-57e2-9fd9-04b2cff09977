# -*- coding: utf-8 -*-
"""陶瓷窑车层架载荷追踪台 —— 核心计算引擎（与 Flask/前端无关，可独立测试）。

物理模型
========
窑车自下而上由若干层组成。第 i 层包含：
  * 一块矩形棚板 board(x, y, w, d, weight)，其上放置坯件(wareWeight)；
  * 若干立柱 posts，立柱的*顶端*托住本层棚板，*底端*落在第 i-1 层棚板上；
    最底层(i=0)立柱的底端落在窑车台面（car 矩形）内。

载荷自上而下传递：
  上层立柱的底端以“点载荷”形式落在下层棚板上。某层棚板承受的总载荷 =
      棚板自重 + 坯件重量 + 所有落在本板上的上层立柱点载荷
  再按“刚性棚板、有效立柱均摊”的工程简化模型，平均分配给所有
  *非悬空* 的立柱；悬空（底端掉在下层棚板/窑车台面之外）的立柱不承载。
  若整层没有一根有效立柱，则该层总载荷无法下传（记为丢失载荷）。

判定：
  hang     悬空：立柱底端坐标不在承托面（下层棚板或窑车台面）矩形内；
  overlap  落点重叠：同层两根及以上立柱底端坐标距离 <= TOL_MM，即踩在同一落点；
                     重叠点对下层棚板的点载荷为各立柱载荷之和；
  overload 超载：立柱实际分配载荷 > 其容量 capacity；
  failed   失效（推演）：调用方通过 failed 参数显式标记的非悬空立柱，视为不承载，
                     整架按同一规则重新分摊；与悬空区分标记，不修改输入数据。
"""

from __future__ import annotations

import math
from typing import Any, Dict, List, Optional, Tuple

TOL_MM = 10.0  # 落点重叠判定距离（mm）

# 加柱建议：候选网格点试算规模上限（防止间距过小导致穷举爆炸）
MAX_SUGGEST_GRID = 4096
# 加柱建议：最多返回的方案数
MAX_SUGGEST_PLANS = 5


# --------------------------------------------------------------------------
# 工具函数
# --------------------------------------------------------------------------
def _num(v: Any, default: float = 0.0) -> float:
    """宽容地把输入转成 float；非法/None 用 default。"""
    try:
        if v is None or v == "":
            return default
        return float(v)
    except (TypeError, ValueError):
        return default


def r2(v: float) -> float:
    """输出统一保留两位小数，去掉 -0。"""
    out = round(float(v) + 0.0, 2)
    return 0.0 if out == 0 else out


def in_rect(x: float, y: float, rect: Dict[str, float]) -> bool:
    return (
        rect["x"] <= x <= rect["x"] + rect["w"]
        and rect["y"] <= y <= rect["y"] + rect["d"]
    )


def _post_label(layer_name: str, pid: str) -> str:
    return f"{layer_name}·{pid}"


# --------------------------------------------------------------------------
# 输入规范化
# --------------------------------------------------------------------------
def normalize(state: Optional[Dict[str, Any]]) -> Dict[str, Any]:
    state = state or {}
    car_in = state.get("car") or {}
    car = {
        "name": str(car_in.get("name") or "窑车台面"),
        "w": max(0.0, _num(car_in.get("w"), 1200.0)),
        "d": max(0.0, _num(car_in.get("d"), 800.0)),
    }

    layers: List[Dict[str, Any]] = []
    for idx, raw in enumerate(state.get("layers") or []):
        raw = raw or {}
        b = raw.get("board") or {}
        posts = []
        for j, p in enumerate(raw.get("posts") or []):
            p = p or {}
            posts.append(
                {
                    "id": str(p.get("id") or f"P{j + 1}"),
                    "x": _num(p.get("x")),
                    "y": _num(p.get("y")),
                    "capacity": _num(p.get("capacity"), 0.0),
                }
            )
        layers.append(
            {
                "id": str(raw.get("id") or f"L{idx}"),
                "name": str(raw.get("name") or f"第{idx + 1}层"),
                "height": max(0.0, _num(raw.get("height"), 300.0)),
                "board": {
                    "x": _num(b.get("x")),
                    "y": _num(b.get("y")),
                    "w": max(0.0, _num(b.get("w"))),
                    "d": max(0.0, _num(b.get("d"))),
                    "weight": max(0.0, _num(b.get("weight"))),
                },
                "wareWeight": max(0.0, _num(raw.get("wareWeight"))),
                "posts": posts,
            }
        )
    return {"car": car, "layers": layers}


# --------------------------------------------------------------------------
# 重叠分组（按平面距离 <= TOL_MM；加柱建议会对数千个候选点反复重算，
# 用网格空间哈希把 O(n^2) 降到接近 O(n)）
# --------------------------------------------------------------------------
def _overlap_groups(points: List[Dict[str, Any]]) -> List[List[int]]:
    n = len(points)
    parent = list(range(n))

    def find(a: int) -> int:
        while parent[a] != a:
            parent[a] = parent[parent[a]]
            a = parent[a]
        return a

    def union(a: int, b: int) -> None:
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[rb] = ra

    # 边长 TOL_MM 的空间哈希桶：只需检查同桶与 8 个相邻桶
    cell: Dict[Tuple[int, int], List[int]] = {}
    for i, p in enumerate(points):
        key = (int(math.floor(p["x"] / TOL_MM)), int(math.floor(p["y"] / TOL_MM)))
        cell.setdefault(key, []).append(i)

    def near_cells(cx: int, cy: int):
        for dx in (-1, 0, 1):
            for dy in (-1, 0, 1):
                yield cell.get((cx + dx, cy + dy))

    for i, p in enumerate(points):
        cx = int(math.floor(p["x"] / TOL_MM))
        cy = int(math.floor(p["y"] / TOL_MM))
        for bucket in near_cells(cx, cy):
            if not bucket:
                continue
            for j in bucket:
                if j <= i:
                    continue
                q = points[j]
                if math.hypot(p["x"] - q["x"], p["y"] - q["y"]) <= TOL_MM:
                    union(i, j)

    groups: Dict[int, List[int]] = {}
    for i in range(n):
        groups.setdefault(find(i), []).append(i)
    return [g for g in groups.values() if len(g) >= 2]


# --------------------------------------------------------------------------
# 主计算
# --------------------------------------------------------------------------
def calculate(
    raw_state: Optional[Dict[str, Any]],
    failed: Optional[List[Any]] = None,
) -> Dict[str, Any]:
    """自顶层向下逐层分摊、累加载荷，返回完整结果（供前端渲染与持久化）。

    failed：失效推演标记，可迭代元素为 {"layer": i, "post": "P1"} 或 (i, "P1")。
    被标记的*非悬空*立柱视为不承载（输出 failed=True，与悬空区分），整架按
    同一规则重新分摊；输入数据本身不被修改。
    """
    return _calculate(normalize(raw_state), failed)


def _calculate(
    state: Dict[str, Any],
    failed: Optional[List[Any]] = None,
) -> Dict[str, Any]:
    """与 calculate 相同，但入参必须是 normalize() 后的架体（供批量试算复用）。"""
    failed_set = _normalize_failed(failed)
    car = state["car"]
    layers = state["layers"]
    n = len(layers)

    car_rect = {"x": 0.0, "y": 0.0, "w": car["w"], "d": car["d"]}
    issues: List[Dict[str, Any]] = []

    # incoming[i]：由第 i+1 层立柱底端施加在第 i 层棚板上的点载荷。
    # 每个点载荷 {"x","y","items":[{"chain","amount"}]}，sum(items)=总点载荷。
    incoming: List[List[Dict[str, Any]]] = [[] for _ in range(n)]

    result_layers: List[Dict[str, Any]] = []

    total_own = 0.0
    total_lost = 0.0

    for i in range(n - 1, -1, -1):
        layer = layers[i]
        board = layer["board"]
        name = layer["name"]
        bw, ww = board["weight"], layer["wareWeight"]
        total_own += bw + ww

        points = incoming[i]
        load_in = sum(sum(it["amount"] for it in p["items"]) for p in points)
        board_total = bw + ww + load_in

        # 承托面：底层为窑车台面，其余为下一层棚板
        if i == 0:
            support_kind, support_rect, support_name = (
                "car",
                car_rect,
                car["name"],
            )
        else:
            lb = layers[i - 1]["board"]
            support_kind = "board"
            support_rect = {"x": lb["x"], "y": lb["y"], "w": lb["w"], "d": lb["d"]}
            support_name = layers[i - 1]["name"] + "棚板"

        posts_out: List[Dict[str, Any]] = []
        supported_idx: List[int] = []
        hang_n = 0
        fail_n = 0
        for p in layer["posts"]:
            hanging = not in_rect(p["x"], p["y"], support_rect)
            is_failed = not hanging and (i, p["id"]) in failed_set
            po = {
                "id": p["id"],
                "x": r2(p["x"]),
                "y": r2(p["y"]),
                "capacity": r2(p["capacity"]),
                "load": 0.0,
                "hanging": hanging,
                "failed": is_failed,
                "overlap": False,
                "overloaded": False,
                "overlapWith": [],
                "sources": [],
            }
            posts_out.append(po)
            if hanging:
                hang_n += 1
                issues.append(
                    {
                        "level": "error",
                        "type": "hang",
                        "layer": i,
                        "post": p["id"],
                        "message": (
                            f"{name} 立柱 {p['id']}（{r2(p['x'])}, {r2(p['y'])}）"
                            f"底端悬空，未落在{support_name}范围内，不承载"
                        ),
                    }
                )
            elif is_failed:
                fail_n += 1
                issues.append(
                    {
                        "level": "info",
                        "type": "failed",
                        "layer": i,
                        "post": p["id"],
                        "message": (
                            f"{name} 立柱 {p['id']} 被标记为失效（推演），"
                            f"按不承载参与整架重新分摊"
                        ),
                    }
                )
            else:
                supported_idx.append(len(posts_out) - 1)

        c = len(supported_idx)
        unsupported = c == 0
        lost = 0.0
        if unsupported and layer["posts"]:
            lost = board_total
            total_lost += lost
            if fail_n:
                reason = f"均不承载（悬空 {hang_n} 根、失效 {fail_n} 根）"
            else:
                reason = "均悬空"
            issues.append(
                {
                    "level": "error",
                    "type": "unsupported",
                    "layer": i,
                    "post": None,
                    "message": (
                        f"{name}全部 {len(layer['posts'])} 根立柱{reason}，"
                        f"棚板载荷 {r2(board_total)} kg 无有效支撑、无法下传"
                    ),
                }
            )
        elif unsupported:
            # 没有录入立柱（如留空的顶层）：载荷同样无支撑
            lost = board_total
            total_lost += lost
            if board_total > 0:
                issues.append(
                    {
                        "level": "warn",
                        "type": "unsupported",
                        "layer": i,
                        "post": None,
                        "message": f"{name}未录入立柱，载荷 {r2(board_total)} kg 无支撑",
                    }
                )

        # 有效立柱均摊棚板总载荷，并构建载荷来源
        if c > 0:
            share = board_total / c
            for k in supported_idx:
                po = posts_out[k]
                po["load"] = r2(share)
                po["overloaded"] = p_capacity_over(po, share)
                sources: List[Dict[str, Any]] = []
                if bw > 0:
                    sources.append({"label": "本层棚板自重", "amount": r2(bw / c)})
                if ww > 0:
                    sources.append({"label": "本层坯件重量", "amount": r2(ww / c)})
                for pt in points:
                    for it in pt["items"]:
                        sources.append(
                            {"label": it["chain"], "amount": r2(it["amount"] / c)}
                        )
                po["sources"] = _merge_sources(sources)

        # 落点重叠（仅在有效立柱之间判定）
        overlap_sets = _overlap_groups(
            [{"x": posts_out[k]["x"], "y": posts_out[k]["y"]} for k in supported_idx]
        )
        for gi, group in enumerate(overlap_sets):
            members = [supported_idx[g] for g in group]
            ids = [posts_out[m]["id"] for m in members]
            combined = r2(sum(posts_out[m]["load"] for m in members))
            for m in members:
                po = posts_out[m]
                po["overlap"] = True
                po["overlapWith"] = [pid for pid in ids if pid != po["id"]]
            issues.append(
                {
                    "level": "warn",
                    "type": "overlap",
                    "layer": i,
                    "post": ids[0],
                    "message": (
                        f"{name} 立柱 {'、'.join(ids)} 底端落在同一坐标"
                        f"（{posts_out[members[0]]['x']}, {posts_out[members[0]]['y']}），"
                        f"对{support_name}的合并点载荷 {combined} kg"
                    ),
                }
            )

        # 超载告警
        for po in posts_out:
            if po["overloaded"]:
                issues.append(
                    {
                        "level": "error",
                        "type": "overload",
                        "layer": i,
                        "post": po["id"],
                        "message": (
                            f"{name} 立柱 {po['id']} 超载："
                            f"载荷 {po['load']} kg > 容量 {po['capacity']} kg"
                        ),
                    }
                )

        # 本层有效立柱以“点载荷”施加到下层棚板；重叠落点合并为一个点
        if i > 0 and not unsupported:
            grouped_members = set()
            for group in overlap_sets:
                members = [supported_idx[g] for g in group]
                grouped_members.update(members)
                rep = posts_out[members[0]]
                items: List[Dict[str, Any]] = []
                for m in members:
                    items.extend(_prop_items(layer["name"], posts_out[m], bw, ww, points, c))
                incoming[i - 1].append(
                    {
                        "x": rep["x"],
                        "y": rep["y"],
                        "items": [
                            {"chain": k, "amount": r2(v)}
                            for k, v in _sum_items(items).items()
                        ],
                    }
                )
            for k in supported_idx:
                if k in grouped_members:
                    continue
                po = posts_out[k]
                items = _prop_items(layer["name"], po, bw, ww, points, c)
                incoming[i - 1].append(
                    {
                        "x": po["x"],
                        "y": po["y"],
                        "items": [
                            {"chain": k2, "amount": r2(v2)}
                            for k2, v2 in _sum_items(items).items()
                        ],
                    }
                )

        carried = r2(sum(po["load"] for po in posts_out))
        result_layers.append(
            {
                "index": i,
                "id": layer["id"],
                "name": name,
                "height": r2(layer["height"]),
                "board": {
                    "x": r2(board["x"]),
                    "y": r2(board["y"]),
                    "w": r2(board["w"]),
                    "d": r2(board["d"]),
                    "weight": r2(board["weight"]),
                },
                "wareWeight": r2(ww),
                "supportKind": support_kind,
                "supportName": support_name,
                "supportRect": {k: r2(v) for k, v in support_rect.items()},
                "loadOwn": r2(bw + ww),
                "loadIncoming": r2(load_in),
                "loadTotal": r2(board_total),
                "loadCarried": carried,
                "lostLoad": r2(lost),
                "supportedCount": c,
                "hangingCount": hang_n,
                "failedCount": fail_n,
                "posts": posts_out,
            }
        )

    result_layers.reverse()  # 恢复自下而上

    # 输入校验类提示
    for i, layer in enumerate(layers):
        if layer["board"]["w"] <= 0 or layer["board"]["d"] <= 0:
            issues.append(
                {
                    "level": "warn",
                    "type": "invalid",
                    "layer": i,
                    "post": None,
                    "message": f"{layer['name']}棚板宽/深为 0，请检查棚板尺寸",
                }
            )
        ids = [p["id"] for p in layer["posts"]]
        if len(ids) != len(set(ids)):
            issues.append(
                {
                    "level": "warn",
                    "type": "invalid",
                    "layer": i,
                    "post": None,
                    "message": f"{layer['name']}存在重复立柱编号，请修正",
                }
            )

    order = {"overload": 0, "hang": 1, "unsupported": 2, "failed": 3, "overlap": 4, "invalid": 5}
    issues.sort(key=lambda e: (order.get(e["type"], 9), e["layer"], str(e["post"])))

    bottom_carried = (
        result_layers[0]["loadCarried"] if result_layers else 0.0
    )
    return {
        "car": {"name": car["name"], "w": r2(car["w"]), "d": r2(car["d"])},
        "layers": result_layers,
        "issues": issues,
        "totals": {
            "ownWeight": r2(total_own),
            "carriedAtBottom": bottom_carried,
            "lostLoad": r2(total_lost),
            "postCount": sum(len(l["posts"]) for l in result_layers),
            "failedCount": sum(l["failedCount"] for l in result_layers),
            "layerCount": n,
        },
        "toleranceMm": TOL_MM,
    }


def p_capacity_over(po: Dict[str, Any], load: float) -> bool:
    return po["capacity"] > 0 and load > po["capacity"] + 1e-9


def _merge_sources(sources: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    agg: Dict[str, float] = {}
    for s in sources:
        agg[s["label"]] = agg.get(s["label"], 0.0) + s["amount"]
    return [{"label": k, "amount": r2(v)} for k, v in agg.items()]


def _sum_items(items: List[Dict[str, Any]]) -> Dict[str, float]:
    agg: Dict[str, float] = {}
    for it in items:
        agg[it["chain"]] = agg.get(it["chain"], 0.0) + it["amount"]
    return agg


def _prop_items(
    layer_name: str,
    po: Dict[str, Any],
    bw: float,
    ww: float,
    points: List[Dict[str, Any]],
    c: int,
) -> List[Dict[str, Any]]:
    """生成本层立柱底端施加到下层棚板的点载荷来源链。"""
    label = _post_label(layer_name, po["id"])
    items: List[Dict[str, Any]] = []
    own = (bw + ww) / c
    if own > 0:
        items.append({"chain": label, "amount": own})
    for pt in points:
        for it in pt["items"]:
            items.append(
                {"chain": f"{it['chain']} → {label}", "amount": it["amount"] / c}
            )
    return items


# --------------------------------------------------------------------------
# 立柱失效推演（What-if）：基准 vs 推演并排对比
# --------------------------------------------------------------------------
def _normalize_failed(failed: Optional[List[Any]]) -> set:
    """把失效标记规范化为 {(layer_index, post_id)}；非法项静默忽略。"""
    out = set()
    for item in failed or []:
        li: Any = None
        pid: Any = None
        if isinstance(item, dict):
            li, pid = item.get("layer"), item.get("post")
        elif isinstance(item, (list, tuple)) and len(item) == 2:
            li, pid = item
        try:
            li = int(li)
        except (TypeError, ValueError):
            continue
        if pid is None or str(pid) == "":
            continue
        out.add((li, str(pid)))
    return out


def simulate(
    raw_state: Optional[Dict[str, Any]],
    failed: Optional[List[Any]] = None,
) -> Dict[str, Any]:
    """以当前输入为基准，将指定立柱标记为失效后整架重算，返回基准/推演/差值。

    不修改、不持久化任何输入；失效标记仅作用于本次调用。
    """
    baseline = calculate(raw_state)
    simulation = calculate(raw_state, failed=failed)
    applied = [
        {"layer": L["index"], "layerName": L["name"], "post": p["id"]}
        for L in simulation["layers"]
        for p in L["posts"]
        if p.get("failed")
    ]
    return {
        "baseline": baseline,
        "simulation": simulation,
        "failed": applied,
        "diff": _diff_results(baseline, simulation),
    }


def _diff_results(base: Dict[str, Any], sim: Dict[str, Any]) -> Dict[str, Any]:
    """基准 vs 推演：台面载荷/丢失载荷对比、每根立柱载荷差值、新增超载或无支撑。"""

    def issue_key(e: Dict[str, Any]) -> Tuple[str, int, str]:
        return (e["type"], e["layer"], str(e["post"]))

    base_keys = {issue_key(e) for e in base["issues"]}
    new_issues = [
        e
        for e in sim["issues"]
        if e["type"] in ("overload", "unsupported") and issue_key(e) not in base_keys
    ]

    base_posts = {
        (L["index"], p["id"]): p for L in base["layers"] for p in L["posts"]
    }
    posts: List[Dict[str, Any]] = []
    for L in sim["layers"]:
        for p in L["posts"]:
            b = base_posts.get((L["index"], p["id"])) or {}
            base_load = b.get("load", 0.0)
            posts.append(
                {
                    "layer": L["index"],
                    "layerName": L["name"],
                    "post": p["id"],
                    "base": base_load,
                    "sim": p["load"],
                    "delta": r2(p["load"] - base_load),
                    "failed": bool(p.get("failed")),
                    "hanging": bool(p.get("hanging")),
                    "overloaded": bool(p.get("overloaded")),
                }
            )

    def pair(key: str) -> Dict[str, float]:
        b = base["totals"][key]
        s = sim["totals"][key]
        return {"base": b, "sim": s, "delta": r2(s - b)}

    return {
        "carriedAtBottom": pair("carriedAtBottom"),
        "lostLoad": pair("lostLoad"),
        "posts": posts,
        "newIssues": new_issues,
    }


# --------------------------------------------------------------------------
# 加柱建议（Suggest Post）：在目标层候选网格上逐点试算新增一根立柱
# --------------------------------------------------------------------------
def _support_rect_for(norm: Dict[str, Any], i: int) -> Dict[str, float]:
    """第 i 层立柱底端的承托面矩形（底层为窑车台面，其余为下一层棚板）。"""
    if i == 0:
        car = norm["car"]
        return {"x": 0.0, "y": 0.0, "w": car["w"], "d": car["d"]}
    lb = norm["layers"][i - 1]["board"]
    return {"x": lb["x"], "y": lb["y"], "w": lb["w"], "d": lb["d"]}


def _fast_trial_scores(
    norm: Dict[str, Any],
    li: int,
    cap: float,
    feasible: List[Tuple[float, float]],
    tol: float = TOL_MM,
) -> List[Tuple[float, int, Optional[float], float, float]]:
    """加柱建议批量快路：对每个可行点试算新柱，只产出排序所需打分。

    与 _calculate 同一物理规则（刚性棚板、有效柱均摊、悬空不承载、重叠点
    合并下传），但不生成来源链 / 告警文案 / 逐值 round，也不构建对外结果
    结构——逐点试算量可达数千次，这里省去绝大部分开销。返回
    (lostLoad, overloadCount, maxUtilization(None=全部不限容量), x, y)。
    """
    layers = norm["layers"]
    n = len(layers)
    car = norm["car"]

    # 各层承托面矩形与基准“有效柱”（非悬空）坐标/容量
    support_rects = [_support_rect_for(norm, i) for i in range(n)]
    base_xy: List[List[Tuple[float, float]]] = []
    base_caps: List[List[float]] = []
    for i, L in enumerate(layers):
        pairs: List[Tuple[float, float]] = []
        cs: List[float] = []
        rect = support_rects[i]
        for p in L["posts"]:
            if in_rect(p["x"], p["y"], rect):
                pairs.append((p["x"], p["y"]))
                cs.append(p["capacity"])
        base_xy.append(pairs)
        base_caps.append(cs)

    scores: List[Tuple[float, int, Optional[float], float, float]] = []
    for x, y in feasible:
        xy = [list(pairs) for pairs in base_xy]
        caps = [list(cs) for cs in base_caps]
        xy[li].append((x, y))
        caps[li].append(cap)

        # incoming_items[i]：落到第 i 层棚板上的点载荷（未合并），
        # 每个点 (x, y, load)；先求本层总载荷，重叠点合并后再下传。
        incoming_items: List[List[Tuple[float, float, float]]] = [
            [] for _ in range(n)
        ]
        total_lost = 0.0
        overload_n = 0
        max_util: Optional[float] = None

        for i in range(n - 1, -1, -1):
            L = layers[i]
            b = L["board"]
            board_total = b["weight"] + L["wareWeight"] + sum(
                ld for _, _, ld in incoming_items[i]
            )
            c = len(xy[i])
            if c == 0:
                total_lost += board_total
                continue  # 无有效柱：载荷丢失，不向下传递
            share = board_total / c
            for cp in caps[i]:
                if cp > 0:
                    if share > cp + 1e-9:
                        overload_n += 1
                    u = share / cp
                    if max_util is None or u > max_util:
                        max_util = u

            # 重叠落点（距离 <= tol）合并为一个点载荷，下传到第 i-1 层
            if i > 0:
                cell = max(tol, 1e-9)
                merged: Dict[Tuple[int, int], Tuple[float, float, float]] = {}

                def find_bucket(px: float, py: float):
                    gx = int(math.floor(px / cell))
                    gy = int(math.floor(py / cell))
                    for dx in (-1, 0, 1):
                        for dy in (-1, 0, 1):
                            kk = (gx + dx, gy + dy)
                            if kk in merged:
                                mx, my, _ = merged[kk]
                                if math.hypot(px - mx, py - my) <= tol:
                                    return kk
                    return None

                for px, py in xy[i]:
                    key = find_bucket(px, py)
                    if key is None:
                        key = (int(math.floor(px / cell)), int(math.floor(py / cell)))
                        merged[key] = (px, py, share)
                    else:
                        mx, my, mload = merged[key]
                        merged[key] = (mx, my, mload + share)
                for mx, my, mload in merged.values():
                    incoming_items[i - 1].append((mx, my, mload))

        scores.append((total_lost, overload_n, max_util, x, y))
    return scores


def _issue_key(e: Dict[str, Any]) -> Tuple[str, int, str]:
    return (e["type"], e["layer"], str(e["post"]))


def _count_overloaded(res: Dict[str, Any]) -> int:
    return sum(
        1
        for L in res["layers"]
        for p in L["posts"]
        if p.get("overloaded")
    )


def _max_utilization(res: Dict[str, Any]) -> Optional[float]:
    """整架最高利用率 = max(load/capacity)；容量为 0（不限容量）的立柱不参与。

    所有立柱均不限容量时返回 None（排序时排在最后）。
    """
    best: Optional[float] = None
    for L in res["layers"]:
        for p in L["posts"]:
            if p.get("capacity", 0.0) > 0:
                u = p["load"] / p["capacity"]
                if best is None or u > best:
                    best = u
    return best


def _layer_rows(base: Dict[str, Any], trial: Dict[str, Any]) -> List[Dict[str, Any]]:
    """逐层载荷对比：本层总载荷 / 丢失载荷 / 下传载荷 / 超载柱数。"""
    rows: List[Dict[str, Any]] = []
    for bL, tL in zip(base["layers"], trial["layers"]):
        b_ov = sum(1 for p in bL["posts"] if p.get("overloaded"))
        t_ov = sum(1 for p in tL["posts"] if p.get("overloaded"))
        rows.append(
            {
                "layer": tL["index"],
                "name": tL["name"],
                "loadTotal": {"base": bL["loadTotal"], "trial": tL["loadTotal"]},
                "lostLoad": {"base": bL["lostLoad"], "trial": tL["lostLoad"]},
                "loadCarried": {"base": bL["loadCarried"], "trial": tL["loadCarried"]},
                "overloadCount": {"base": b_ov, "trial": t_ov},
            }
        )
    return rows


def _issue_changes(base: Dict[str, Any], trial: Dict[str, Any]) -> Dict[str, Any]:
    """新增 / 消除告警（以 (type, layer, post) 为键对比）。"""
    base_map = {_issue_key(e): e for e in base["issues"]}
    trial_map = {_issue_key(e): e for e in trial["issues"]}
    added = [trial_map[k] for k in trial_map.keys() - base_map.keys()]
    removed = [base_map[k] for k in base_map.keys() - trial_map.keys()]

    def _order(items: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        order = {
            "overload": 0, "hang": 1, "unsupported": 2,
            "failed": 3, "overlap": 4, "invalid": 5,
        }
        return sorted(items, key=lambda e: (order.get(e["type"], 9), e["layer"], str(e["post"])))

    return {"added": _order(added), "removed": _order(removed)}


def suggest_posts(
    raw_state: Optional[Dict[str, Any]],
    layer: Any,
    spacing: Any,
    capacity: Any,
) -> Dict[str, Any]:
    """加柱建议：在目标层的承托面内按候选网格逐点试算新增一根立柱。

    参数
    ----
    raw_state : 当前架体输入（不被修改、不被持久化）
    layer     : 目标层索引（自下而上，0 为底层）
    spacing   : 候选网格间距 mm（>0）
    capacity  : 新柱容量 kg（0 表示不限容量，不计利用率）

    可行点条件：候选点在承托面矩形内，且与目标层*现有有效立柱*（非悬空）
    底端平面距离严格大于 TOL_MM（避免与现有落点重叠）。

    排序（全部升序）：丢失载荷 → 超载数 → 最高利用率（无容量限制柱的方案
    排最后）→ 坐标（x、y）；仅返回前 MAX_SUGGEST_PLANS 个方案。

    只计算、不写盘：每个方案附带试算后的完整结果与逐层/告警对比，由前端
    预览并经用户确认后，才通过原有 PUT /api/state 写入架体。
    """
    norm = normalize(raw_state)
    layers = norm["layers"]
    n = len(layers)

    try:
        li = int(layer)
    except (TypeError, ValueError):
        raise ValueError("目标层索引必须是整数")
    if not 0 <= li < n:
        raise ValueError(f"目标层 {layer!r} 不存在：当前共 {n} 层（索引 0~{n - 1}）")

    try:
        gap = float(spacing)
    except (TypeError, ValueError):
        raise ValueError("候选网格间距必须是数值（mm）")
    if not math.isfinite(gap) or gap <= 0:
        raise ValueError("候选网格间距必须大于 0")

    try:
        cap = float(capacity)
    except (TypeError, ValueError):
        raise ValueError("新柱容量必须是数值（kg，0=不限容量）")
    if not math.isfinite(cap) or cap < 0:
        raise ValueError("新柱容量不能为负；0 表示不限容量")

    rect = _support_rect_for(norm, li)
    if rect["w"] <= 0 or rect["d"] <= 0:
        return {
            "layer": li,
            "layerName": layers[li]["name"],
            "spacing": r2(gap),
            "capacity": r2(cap),
            "gridCount": 0,
            "feasibleCount": 0,
            "plans": [],
            "baseline": None,
            "reason": (
                f"{layers[li]['name']}的承托面宽或深为 0"
                f"（{r2(rect['w'])}×{r2(rect['d'])} mm），没有可落柱的位置，"
                "请先修正承托面尺寸"
            ),
        }

    baseline = _calculate(norm)
    # 目标层现有*有效立柱*（非悬空）坐标；用 normalize 后的未截断坐标判距，
    # 避免边界点因 r2 两位小数被误纳/误排
    existing_effective = [
        (p["x"], p["y"])
        for p in layers[li]["posts"]
        if in_rect(p["x"], p["y"], rect)
    ]

    x0, y0 = rect["x"], rect["y"]
    x1, y1 = x0 + rect["w"], y0 + rect["d"]
    nx = int(math.floor((x1 - x0) / gap)) + 1
    ny = int(math.floor((y1 - y0) / gap)) + 1
    grid_count = nx * ny
    if grid_count > MAX_SUGGEST_GRID:
        return {
            "layer": li,
            "layerName": layers[li]["name"],
            "spacing": r2(gap),
            "capacity": r2(cap),
            "gridCount": grid_count,
            "feasibleCount": 0,
            "plans": [],
            "baseline": baseline,
            "reason": (
                f"候选网格过密：间距 {r2(gap)} mm 在承托面"
                f"（{r2(rect['w'])}×{r2(rect['d'])} mm）上产生 {grid_count} 个候选点，"
                f"超过试算上限 {MAX_SUGGEST_GRID} 个，请加大候选网格间距后重试"
            ),
        }

    # 新柱编号：取目标层未占用的 P 系列编号
    used_ids = {p["id"] for p in layers[li]["posts"]}
    new_id = None
    k = 1
    while new_id is None:
        cand = f"P{k}"
        if cand not in used_ids:
            new_id = cand
        k += 1

    feasible: List[Tuple[float, float]] = []
    for ix in range(nx):
        x = x0 + ix * gap
        if x > x1 + 1e-9:
            continue
        for iy in range(ny):
            y = y0 + iy * gap
            if y > y1 + 1e-9:
                continue
            # 与现有有效柱距离必须严格大于重叠阈值 TOL_MM
            too_close = any(
                math.hypot(x - ex, y - ey) <= TOL_MM
                for ex, ey in existing_effective
            )
            if not too_close:
                feasible.append((x, y))

    if not feasible:
        reason = (
            f"{layers[li]['name']}承托面内的 {grid_count} 个网格候选点，"
            f"全部与现有有效立柱落点距离 ≤ {TOL_MM:g} mm（重叠阈值），"
            "没有可新增立柱的位置；可减小现有立柱密度后再试"
        ) if grid_count else f"{layers[li]['name']}承托面内没有候选网格点"
        return {
            "layer": li,
            "layerName": layers[li]["name"],
            "spacing": r2(gap),
            "capacity": r2(cap),
            "gridCount": grid_count,
            "feasibleCount": 0,
            "plans": [],
            "baseline": baseline,
            "reason": reason,
        }

    base_lost = baseline["totals"]["lostLoad"]
    base_over = _count_overloaded(baseline)
    base_util = _max_utilization(baseline)

    # 快路：逐点只算排序打分（不含来源链/告警文案），避免数千次完整重算。
    # 快路直接给出精确的载荷/利用率（不做 r2 两位截断），可直接用于排序；
    # 仅对最终入选的前 5 个点再跑完整 _calculate 产出对外展示结果。
    fast_sorted = sorted(
        _fast_trial_scores(norm, li, cap, feasible),
        key=lambda t: (
            t[0], t[1], t[2] if t[2] is not None else math.inf, t[3], t[4]
        ),
    )
    chosen_pts = fast_sorted[:MAX_SUGGEST_PLANS]

    # 入选的少数点：在目标层临时追加新柱，用完整 _calculate 产出对比/预览结果
    posts_list = layers[li]["posts"]
    trial_post = {"id": new_id, "x": 0.0, "y": 0.0, "capacity": cap}
    posts_list.append(trial_post)
    scored: List[Tuple[float, int, float, float, float, Dict[str, Any]]] = []
    try:
        for _, _, _, x, y in chosen_pts:
            trial_post["x"], trial_post["y"] = x, y
            trial = _calculate(norm)

            lost = trial["totals"]["lostLoad"]
            over = _count_overloaded(trial)
            util = _max_utilization(trial)  # None=无容量受限柱，排序置后
            scored.append(
                (lost, over, util if util is not None else math.inf, x, y, trial)
            )
    finally:
        posts_list.pop()

    scored.sort(key=lambda t: (t[0], t[1], t[2], t[3], t[4]))

    plans: List[Dict[str, Any]] = []
    for rank, (lost, over, util, x, y, trial) in enumerate(
        scored[:MAX_SUGGEST_PLANS]
    ):
        new_post = next(
            p for p in trial["layers"][li]["posts"] if p["id"] == new_id
        )
        util_val = None if util == math.inf else util
        changes = _issue_changes(baseline, trial)
        plans.append(
            {
                "rank": rank + 1,
                "post": {
                    "id": new_id,
                    "x": r2(x),
                    "y": r2(y),
                    "capacity": r2(cap),
                    "load": new_post["load"],
                    "overloaded": bool(new_post["overloaded"]),
                },
                "metrics": {
                    "lostLoad": r2(lost),
                    "overloadCount": over,
                    "maxUtilization": (
                        None if util_val is None else round(util_val, 4)
                    ),
                    "carriedAtBottom": trial["totals"]["carriedAtBottom"],
                },
                "layers": _layer_rows(baseline, trial),
                "issues": changes,
                "result": trial,
            }
        )

    return {
        "layer": li,
        "layerName": layers[li]["name"],
        "spacing": r2(gap),
        "capacity": r2(cap),
        "gridCount": grid_count,
        "feasibleCount": len(feasible),
        "baselineMetrics": {
            "lostLoad": base_lost,
            "overloadCount": base_over,
            "maxUtilization": None if base_util is None else round(base_util, 4),
            "carriedAtBottom": baseline["totals"]["carriedAtBottom"],
        },
        "plans": plans,
        "reason": None,
        "toleranceMm": TOL_MM,
    }
