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
# 重叠分组（并查集，按平面距离 <= TOL_MM）
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

    for i in range(n):
        for j in range(i + 1, n):
            if (
                math.hypot(
                    points[i]["x"] - points[j]["x"],
                    points[i]["y"] - points[j]["y"],
                )
                <= TOL_MM
            ):
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
    state = normalize(raw_state)
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
