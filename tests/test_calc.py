# -*- coding: utf-8 -*-
"""核心计算引擎单元测试：python -m pytest -q 或 python tests/test_calc.py"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.calc import calculate, normalize, simulate, suggest_posts  # noqa: E402

SAMPLE = os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))),
    "data",
    "sample_state.json",
)


class CalcTests(unittest.TestCase):
    def test_simple_two_layers_even_share(self):
        state = {
            "car": {"w": 1000, "d": 1000},
            "layers": [
                {
                    "name": "底",
                    "height": 300,
                    "board": {"x": 0, "y": 0, "w": 1000, "d": 1000, "weight": 100},
                    "wareWeight": 100,
                    "posts": [
                        {"id": "A", "x": 100, "y": 100, "capacity": 0},
                        {"id": "B", "x": 900, "y": 900, "capacity": 0},
                    ],
                },
                {
                    "name": "顶",
                    "height": 300,
                    "board": {"x": 100, "y": 100, "w": 800, "d": 800, "weight": 80},
                    "wareWeight": 120,
                    "posts": [
                        {"id": "C", "x": 200, "y": 200, "capacity": 0},
                        {"id": "D", "x": 800, "y": 800, "capacity": 0},
                    ],
                },
            ],
        }
        r = calculate(state)
        bottom, top = r["layers"]
        # 顶层 (80+120)/2 = 100
        self.assertEqual([p["load"] for p in top["posts"]], [100.0, 100.0])
        # 底层 100+100 + 上层点载荷 200 = 400, /2 = 200
        self.assertEqual(bottom["loadIncoming"], 200.0)
        self.assertEqual(bottom["loadTotal"], 400.0)
        self.assertEqual([p["load"] for p in bottom["posts"]], [200.0, 200.0])
        self.assertEqual(r["totals"]["lostLoad"], 0.0)
        self.assertEqual(r["totals"]["carriedAtBottom"], 400.0)
        # 载荷来源链
        labels = [s["label"] for s in bottom["posts"][0]["sources"]]
        self.assertIn("顶·C", labels)
        self.assertEqual(sum(s["amount"] for s in bottom["posts"][0]["sources"]), 200.0)

    def test_hanging_post_carries_nothing_and_load_is_lost_from_chain(self):
        state = {
            "car": {"w": 1000, "d": 1000},
            "layers": [
                {
                    "name": "底",
                    "board": {"x": 200, "y": 200, "w": 600, "d": 600, "weight": 0},
                    "wareWeight": 0,
                    "posts": [
                        {"id": "A", "x": 300, "y": 300, "capacity": 0},
                    ],
                },
                {
                    "name": "顶",
                    "board": {"x": 200, "y": 200, "w": 600, "d": 600, "weight": 100},
                    "wareWeight": 100,
                    "posts": [
                        {"id": "H", "x": 900, "y": 900, "capacity": 0},  # 悬空：在下层棚板外、台面内
                    ],
                },
            ],
        }
        r = calculate(state)
        bottom, top = r["layers"]
        self.assertTrue(top["posts"][0]["hanging"])
        self.assertEqual(top["posts"][0]["load"], 0.0)
        self.assertEqual(top["lostLoad"], 200.0)
        self.assertEqual(bottom["loadIncoming"], 0.0)
        kinds = {i["type"] for i in r["issues"]}
        self.assertIn("hang", kinds)
        self.assertIn("unsupported", kinds)

    def test_overlap_and_combined_point_load(self):
        state = {
            "car": {"w": 1000, "d": 1000},
            "layers": [
                {
                    "name": "底",
                    "board": {"x": 0, "y": 0, "w": 1000, "d": 1000, "weight": 0},
                    "wareWeight": 0,
                    "posts": [
                        {"id": "A", "x": 500, "y": 500, "capacity": 0},
                    ],
                },
                {
                    "name": "顶",
                    "board": {"x": 0, "y": 0, "w": 1000, "d": 1000, "weight": 100},
                    "wareWeight": 0,
                    "posts": [
                        {"id": "X", "x": 500, "y": 500, "capacity": 0},
                        {"id": "Y", "x": 503, "y": 500, "capacity": 0},  # 3mm < 10mm
                    ],
                },
            ],
        }
        r = calculate(state)
        bottom, top = r["layers"]
        self.assertTrue(all(p["overlap"] for p in top["posts"]))
        # 两根柱各 50，合并点载荷 100 落在下层 (500,500)
        self.assertEqual(bottom["loadIncoming"], 100.0)
        self.assertEqual(len(bottom["posts"][0]["sources"]), 2)
        self.assertIn("overlap", {i["type"] for i in r["issues"]})

    def test_overload_flag(self):
        state = {
            "car": {"w": 1000, "d": 1000},
            "layers": [
                {
                    "name": "底",
                    "board": {"x": 0, "y": 0, "w": 1000, "d": 1000, "weight": 100},
                    "wareWeight": 0,
                    "posts": [
                        {"id": "A", "x": 100, "y": 100, "capacity": 40},
                        {"id": "B", "x": 900, "y": 900, "capacity": 400},
                    ],
                }
            ],
        }
        r = calculate(state)
        p = r["layers"][0]["posts"]
        self.assertTrue(p[0]["overloaded"])
        self.assertFalse(p[1]["overloaded"])

    def test_sample_data_covers_all_issue_types(self):
        with open(SAMPLE, encoding="utf-8") as f:
            state = json.load(f)
        r = calculate(state)
        kinds = {i["type"] for i in r["issues"]}
        self.assertIn("hang", kinds)
        self.assertIn("overlap", kinds)
        self.assertIn("overload", kinds)
        # 载荷守恒：总自重 == 传到台面的载荷 + 丢失
        self.assertAlmostEqual(
            r["totals"]["ownWeight"],
            r["totals"]["carriedAtBottom"] + r["totals"]["lostLoad"],
            places=1,
        )

    def test_tolerant_normalize(self):
        r = normalize({"layers": [{"board": {"w": "abc"}, "posts": [{"x": ""}]}]})
        self.assertEqual(r["layers"][0]["board"]["w"], 0.0)
        self.assertEqual(r["layers"][0]["posts"][0]["x"], 0.0)

    # ---------------- 立柱失效推演 ----------------
    def test_failed_post_redistributes_and_diff(self):
        state = {
            "car": {"w": 1000, "d": 1000},
            "layers": [
                {
                    "name": "底",
                    "board": {"x": 0, "y": 0, "w": 1000, "d": 1000, "weight": 100},
                    "wareWeight": 100,
                    "posts": [
                        {"id": "A", "x": 100, "y": 100, "capacity": 0},
                        {"id": "B", "x": 900, "y": 900, "capacity": 0},
                    ],
                }
            ],
        }
        r = simulate(state, failed=[{"layer": 0, "post": "A"}])
        base, sim, diff = r["baseline"], r["simulation"], r["diff"]
        # 基准不受影响：无失效标记、载荷照旧
        self.assertEqual([p["load"] for p in base["layers"][0]["posts"]], [100.0, 100.0])
        self.assertFalse(any(p.get("failed") for p in base["layers"][0]["posts"]))
        # 推演：A 失效不承载，B 承担全部 200
        pa, pb = sim["layers"][0]["posts"]
        self.assertTrue(pa["failed"])
        self.assertFalse(pa["hanging"])
        self.assertEqual(pa["load"], 0.0)
        self.assertEqual(pb["load"], 200.0)
        self.assertEqual(sim["layers"][0]["supportedCount"], 1)
        self.assertEqual(sim["layers"][0]["failedCount"], 1)
        self.assertEqual(sim["layers"][0]["hangingCount"], 0)
        # 失效产生 info 级提示，而非 hang
        kinds = {i["type"] for i in sim["issues"]}
        self.assertIn("failed", kinds)
        self.assertNotIn("hang", kinds)
        # 差值：A -100、B +100，台面载荷与丢失载荷不变
        d = {p["post"]: p for p in diff["posts"]}
        self.assertEqual(d["A"]["delta"], -100.0)
        self.assertEqual(d["B"]["delta"], 100.0)
        self.assertEqual(diff["carriedAtBottom"]["delta"], 0.0)
        self.assertEqual(diff["lostLoad"]["delta"], 0.0)
        self.assertEqual(diff["newIssues"], [])
        self.assertEqual(r["failed"], [{"layer": 0, "layerName": "底", "post": "A"}])

    def test_failed_only_support_causes_lost_load_and_new_issue(self):
        state = {
            "car": {"w": 1000, "d": 1000},
            "layers": [
                {
                    "name": "底",
                    "board": {"x": 0, "y": 0, "w": 1000, "d": 1000, "weight": 100},
                    "wareWeight": 100,
                    "posts": [{"id": "A", "x": 100, "y": 100, "capacity": 0}],
                }
            ],
        }
        r = simulate(state, failed=[{"layer": 0, "post": "A"}])
        sim, diff = r["simulation"], r["diff"]
        self.assertEqual(sim["totals"]["lostLoad"], 200.0)
        self.assertEqual(sim["totals"]["carriedAtBottom"], 0.0)
        self.assertEqual(diff["lostLoad"]["delta"], 200.0)
        self.assertEqual(diff["carriedAtBottom"]["delta"], -200.0)
        new_types = {(i["type"], i["layer"]) for i in diff["newIssues"]}
        self.assertIn(("unsupported", 0), new_types)

    def test_failed_post_introduces_overload_as_new_issue(self):
        state = {
            "car": {"w": 1000, "d": 1000},
            "layers": [
                {
                    "name": "底",
                    "board": {"x": 0, "y": 0, "w": 1000, "d": 1000, "weight": 100},
                    "wareWeight": 100,
                    "posts": [
                        {"id": "A", "x": 100, "y": 100, "capacity": 150},
                        {"id": "B", "x": 900, "y": 900, "capacity": 0},
                    ],
                }
            ],
        }
        r = simulate(state, failed=[{"layer": 0, "post": "B"}])
        sim, diff = r["simulation"], r["diff"]
        pa = sim["layers"][0]["posts"][0]
        self.assertTrue(pa["overloaded"])
        self.assertEqual(pa["load"], 200.0)
        self.assertEqual(
            [(i["type"], i["post"]) for i in diff["newIssues"]],
            [("overload", "A")],
        )
        # 基准中 A 未超载 → 不计入新增
        self.assertFalse(r["baseline"]["layers"][0]["posts"][0]["overloaded"])

    def test_failed_mark_on_hanging_post_is_ignored(self):
        state = {
            "car": {"w": 1000, "d": 1000},
            "layers": [
                {
                    "name": "底",
                    "board": {"x": 0, "y": 0, "w": 1000, "d": 1000, "weight": 100},
                    "wareWeight": 0,
                    "posts": [
                        {"id": "H", "x": 2000, "y": 2000, "capacity": 0},  # 悬空
                        {"id": "A", "x": 100, "y": 100, "capacity": 0},
                    ],
                }
            ],
        }
        r = simulate(state, failed=[{"layer": 0, "post": "H"}])
        self.assertEqual(r["failed"], [])
        ph = r["simulation"]["layers"][0]["posts"][0]
        self.assertTrue(ph["hanging"])
        self.assertFalse(ph["failed"])
        self.assertEqual(
            [p["load"] for p in r["simulation"]["layers"][0]["posts"]],
            [p["load"] for p in r["baseline"]["layers"][0]["posts"]],
        )

    def test_calculate_failed_param_directly(self):
        state = {
            "car": {"w": 1000, "d": 1000},
            "layers": [
                {
                    "name": "底",
                    "board": {"x": 0, "y": 0, "w": 1000, "d": 1000, "weight": 0},
                    "wareWeight": 90,
                    "posts": [
                        {"id": "A", "x": 100, "y": 100, "capacity": 0},
                        {"id": "B", "x": 200, "y": 200, "capacity": 0},
                        {"id": "C", "x": 300, "y": 300, "capacity": 0},
                    ],
                }
            ],
        }
        r = calculate(state, failed=[(0, "A"), {"layer": 0, "post": "C"}])
        loads = {p["id"]: p["load"] for p in r["layers"][0]["posts"]}
        self.assertEqual(loads, {"A": 0.0, "B": 90.0, "C": 0.0})
        self.assertEqual(r["totals"]["failedCount"], 2)

    # ---------------- 加柱建议 ----------------
    def _overload_state(self):
        # 单层 1000x1000：200 kg 由 2 根容量 40 的柱承担 → 2 根均超载
        return {
            "car": {"w": 1000, "d": 1000},
            "layers": [
                {
                    "name": "底",
                    "board": {"x": 0, "y": 0, "w": 1000, "d": 1000, "weight": 200},
                    "wareWeight": 0,
                    "posts": [
                        {"id": "A", "x": 100, "y": 100, "capacity": 40},
                        {"id": "B", "x": 900, "y": 900, "capacity": 40},
                    ],
                }
            ],
        }

    def test_suggest_removes_overload_and_sorts_by_coords(self):
        r = suggest_posts(self._overload_state(), layer=0, spacing=100, capacity=300)
        self.assertIsNone(r["reason"])
        # 网格 11x11=121，(100,100)、(900,900) 两个候选点距现有柱 0，剔除 → 119
        self.assertEqual(r["gridCount"], 121)
        self.assertEqual(r["feasibleCount"], 119)
        self.assertLessEqual(len(r["plans"]), 5)
        # 3 根柱均摊 200 → 每根 66.67；原柱容量 40 仍超载（2 根），
        # 新柱容量 300 不超载。丢失 0、超载 2、利用率 1.6667 对所有可行点相同 → 按坐标升序
        coords = [(p["post"]["x"], p["post"]["y"]) for p in r["plans"]]
        self.assertEqual(coords, sorted(coords))
        plan = r["plans"][0]
        self.assertEqual((plan["post"]["x"], plan["post"]["y"]), (0.0, 0.0))
        self.assertEqual(plan["post"]["id"], "P1")
        self.assertAlmostEqual(plan["post"]["load"], 66.67, places=1)
        self.assertEqual(plan["metrics"]["overloadCount"], 2)
        self.assertAlmostEqual(plan["metrics"]["maxUtilization"], 200 / 3 / 40, places=2)
        # 对比表：目标层 200 → 200（总载荷不变），超载数 2 → 2（新柱本身不超载）
        row = plan["layers"][0]
        self.assertEqual(row["loadTotal"]["trial"], 200.0)
        self.assertEqual(row["overloadCount"]["base"], 2)

    def test_suggest_feasible_only_inside_support_and_beyond_threshold(self):
        # 承托面 30x30，现有有效柱 (5,5)，间距 10
        state = {
            "car": {"w": 30, "d": 30},
            "layers": [
                {
                    "name": "底",
                    "board": {"x": 0, "y": 0, "w": 30, "d": 30, "weight": 0},
                    "wareWeight": 0,
                    "posts": [{"id": "A", "x": 5, "y": 5, "capacity": 0}],
                }
            ],
        }
        r = suggest_posts(state, 0, 10, 100)
        self.assertEqual(r["gridCount"], 16)  # 4x4 网格点
        # (0,0) 距 (5,5) 仅 7.07 ≤ 10 → 剔除；(10,0) 距 11.18 可行；共 12 个
        self.assertEqual(r["feasibleCount"], 12)
        for p in r["plans"]:
            x, y = p["post"]["x"], p["post"]["y"]
            self.assertTrue(0 <= x <= 30 and 0 <= y <= 30)
            self.assertGreater(((x - 5) ** 2 + (y - 5) ** 2) ** 0.5, 10.0)
        # 距离恰为阈值（10 mm）的点必须剔除（严格大于）
        state2 = {
            "car": {"w": 20, "d": 10},
            "layers": [
                {
                    "name": "底",
                    "board": {"x": 0, "y": 0, "w": 20, "d": 10, "weight": 0},
                    "wareWeight": 0,
                    "posts": [{"id": "A", "x": 0, "y": 0, "capacity": 0}],
                }
            ],
        }
        r2 = suggest_posts(state2, 0, 10, 0)
        pts = [(p["post"]["x"], p["post"]["y"]) for p in r2["plans"]]
        self.assertNotIn((10.0, 0.0), pts)  # 距离恰为 10 → 不可行
        self.assertEqual(r2["feasibleCount"], 3)

    def test_suggest_recovers_lost_load(self):
        # 上层唯一立柱悬空 → 该层 100 kg 全部丢失；在承托面内加柱可完全找回
        state = {
            "car": {"w": 100, "d": 100},
            "layers": [
                {
                    "name": "底",
                    "board": {"x": 0, "y": 0, "w": 100, "d": 100, "weight": 0},
                    "wareWeight": 0,
                    "posts": [{"id": "A", "x": 50, "y": 50, "capacity": 0}],
                },
                {
                    "name": "顶",
                    "board": {"x": 0, "y": 0, "w": 100, "d": 100, "weight": 0},
                    "wareWeight": 100,
                    "posts": [{"id": "H", "x": 500, "y": 500, "capacity": 0}],  # 悬空
                },
            ],
        }
        r = suggest_posts(state, 1, 50, 0)
        self.assertEqual(r["baselineMetrics"]["lostLoad"], 100.0)
        best = r["plans"][0]
        self.assertEqual(best["metrics"]["lostLoad"], 0.0)
        # 顶层 100 kg 经新柱传到下层，再由底层 A 柱传到台面 → 台面 100 kg
        self.assertEqual(best["metrics"]["carriedAtBottom"], 100.0)
        # 容量 0（不限容量）→ 最高利用率为 None（排序时置后）
        self.assertIsNone(best["metrics"]["maxUtilization"])
        # 原悬空柱 H 仍悬空（加柱不改变其状态），但整层恢复有效支撑 → 消除无支撑告警
        removed = [(i["type"], i["layer"]) for i in best["issues"]["removed"]]
        self.assertIn(("unsupported", 1), removed)
        self.assertNotIn(("hang", 1), removed)
        self.assertEqual(best["issues"]["added"], [])

    def test_suggest_no_feasible_point_gives_reason(self):
        state = {
            "car": {"w": 10, "d": 10},
            "layers": [
                {
                    "name": "底",
                    "board": {"x": 0, "y": 0, "w": 10, "d": 10, "weight": 0},
                    "wareWeight": 0,
                    "posts": [{"id": "A", "x": 5, "y": 5, "capacity": 0}],
                }
            ],
        }
        r = suggest_posts(state, 0, 10, 100)
        self.assertEqual(r["plans"], [])
        self.assertEqual(r["feasibleCount"], 0)
        self.assertIn("重叠阈值", r["reason"])

    def test_suggest_zero_size_support_gives_reason(self):
        state = {
            "car": {"w": 0, "d": 0},
            "layers": [
                {
                    "name": "底",
                    "board": {"x": 0, "y": 0, "w": 0, "d": 0, "weight": 0},
                    "wareWeight": 0,
                    "posts": [],
                }
            ],
        }
        r = suggest_posts(state, 0, 100, 100)
        self.assertEqual(r["plans"], [])
        self.assertIn("承托面", r["reason"])

    def test_suggest_grid_too_dense_gives_reason(self):
        state = {
            "car": {"w": 1000, "d": 1000},
            "layers": [
                {
                    "name": "底",
                    "board": {"x": 0, "y": 0, "w": 1000, "d": 1000, "weight": 0},
                    "wareWeight": 0,
                    "posts": [],
                }
            ],
        }
        r = suggest_posts(state, 0, 1, 100)
        self.assertEqual(r["plans"], [])
        self.assertGreater(r["gridCount"], 4096)
        self.assertIn("加大候选网格间距", r["reason"])

    def test_suggest_invalid_params_raise(self):
        state = self._overload_state()
        with self.assertRaises(ValueError):
            suggest_posts(state, 9, 100, 100)       # 层越界
        with self.assertRaises(ValueError):
            suggest_posts(state, 0, 0, 100)         # 间距 0
        with self.assertRaises(ValueError):
            suggest_posts(state, 0, -10, 100)       # 间距为负
        with self.assertRaises(ValueError):
            suggest_posts(state, 0, 100, -5)        # 容量为负
        with self.assertRaises(ValueError):
            suggest_posts(state, "x", 100, 100)     # 层非整数

    def test_suggest_does_not_mutate_input(self):
        state = self._overload_state()
        before = json.loads(json.dumps(state, ensure_ascii=False))
        suggest_posts(state, 0, 100, 300)
        self.assertEqual(state, before)


if __name__ == "__main__":
    unittest.main()
