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
    def _suggest_state(self):
        # 单层：200 kg 由 1 根容量 50 的柱承担（超载、利用率 4.0）
        return {
            "car": {"w": 1000, "d": 1000},
            "layers": [
                {
                    "name": "底",
                    "board": {"x": 0, "y": 0, "w": 1000, "d": 1000, "weight": 100},
                    "wareWeight": 100,
                    "posts": [
                        {"id": "A", "x": 100, "y": 100, "capacity": 50},
                    ],
                }
            ],
        }

    def test_suggest_returns_top5_sorted_and_resolves_overload(self):
        state = self._suggest_state()
        r = suggest_posts(state, layer=0, spacing=200, capacity=0)
        self.assertTrue(r["feasible"], r["reason"])
        self.assertLessEqual(len(r["proposals"]), 5)
        self.assertEqual(r["tried"], 36)  # 1000mm 台面、200mm 网格 → 6×6
        self.assertEqual(r["gridCount"], 36)
        # 排序：（丢失载荷、超载数、最高利用率、x、y）升序
        keys = [
            (
                p["metrics"]["lostLoad"],
                p["metrics"]["overloadCount"],
                p["metrics"]["maxUtilization"],
                p["x"],
                p["y"],
            )
            for p in r["proposals"]
        ]
        self.assertEqual(keys, sorted(keys))
        # 最优方案：加一根不限容量柱后 2 根有效柱各 100，仍超 50 → 超载未消除
        # 换成容量 200 的新柱：A 仍超载（100 > 50，利用率 2.0 为全架最高），
        # 新柱 100/200=0.5 不超载；最高利用率即 A 的 2.0
        r2p = suggest_posts(state, layer=0, spacing=200, capacity=200)["proposals"][0]
        self.assertEqual(r2p["metrics"]["overloadCount"], 1)
        self.assertAlmostEqual(r2p["metrics"]["maxUtilization"], 2.0, places=3)
        target = r2p["result"]["layers"][0]
        self.assertEqual(target["supportedCount"], 2)
        loads = sorted(p["load"] for p in target["posts"])
        self.assertEqual(loads, [100.0, 100.0])
        # 新增柱编号不与现有编号冲突，且与 A 的距离 > 10mm
        self.assertEqual(r2p["postId"], "P1")
        self.assertGreater((r2p["x"] - 100) ** 2 + (r2p["y"] - 100) ** 2, 100.0)

        # 载荷 90、A 容量 50：基准 90>50 超载 1 根；加一根柱后各 45，超载清零、
        # 最高利用率 45/50=0.9，方案 diff 应记录消除的超载告警
        state2 = {
            "car": {"w": 1000, "d": 1000},
            "layers": [
                {
                    "name": "底",
                    "board": {"x": 0, "y": 0, "w": 1000, "d": 1000, "weight": 90},
                    "wareWeight": 0,
                    "posts": [{"id": "A", "x": 100, "y": 100, "capacity": 50}],
                }
            ],
        }
        base = calculate(state2)
        self.assertEqual(sum(1 for e in base["issues"] if e["type"] == "overload"), 1)
        q = suggest_posts(state2, layer=0, spacing=200, capacity=0)["proposals"][0]
        self.assertEqual(q["metrics"]["overloadCount"], 0)
        self.assertAlmostEqual(q["metrics"]["maxUtilization"], 0.9, places=3)
        self.assertEqual(
            [(i["type"], i["post"]) for i in q["diff"]["removedIssues"]],
            [("overload", "A")],
        )
        self.assertEqual(q["diff"]["addedIssues"], [])

    def test_suggest_added_post_not_overlap_within_tolerance(self):
        state = {
            "car": {"w": 200, "d": 200},
            "layers": [
                {
                    "name": "底",
                    "board": {"x": 0, "y": 0, "w": 200, "d": 200, "weight": 10},
                    "wareWeight": 0,
                    "posts": [
                        {"id": "A", "x": 100, "y": 100, "capacity": 0},
                    ],
                }
            ],
        }
        # 间距 100 → 网格点 0/100/200；(100,100) 与 A 重合（距离 0 ≤ 10）须被剔除
        r = suggest_posts(state, layer=0, spacing=100, capacity=0)
        self.assertTrue(r["feasible"])
        self.assertEqual(r["gridCount"], 9)
        self.assertEqual(r["tried"], 8)
        for p in r["proposals"]:
            self.assertFalse(
                any(q["overlap"] for q in p["result"]["layers"][0]["posts"])
            )
            self.assertNotEqual((p["x"], p["y"]), (100.0, 100.0))

    def test_suggest_zero_capacity_not_counted_in_utilization(self):
        state = self._suggest_state()
        r = suggest_posts(state, layer=0, spacing=500, capacity=0)
        p = r["proposals"][0]
        target = p["result"]["layers"][0]
        # 新柱容量 0：利用率仍只看 A（100/50=2.0），新柱本身不参与利用率
        self.assertAlmostEqual(p["metrics"]["maxUtilization"], 2.0, places=3)
        self.assertTrue(target["posts"][-1]["capacity"] == 0)

    def test_suggest_resolves_lost_load_when_all_posts_hang(self):
        state = {
            "car": {"w": 1000, "d": 1000},
            "layers": [
                {
                    "name": "底",
                    "board": {"x": 200, "y": 200, "w": 600, "d": 600, "weight": 0},
                    "wareWeight": 0,
                    "posts": [{"id": "A", "x": 500, "y": 500, "capacity": 0}],
                },
                {
                    "name": "顶",
                    "board": {"x": 200, "y": 200, "w": 600, "d": 600, "weight": 100},
                    "wareWeight": 100,
                    "posts": [
                        {"id": "H", "x": 900, "y": 900, "capacity": 0},  # 悬空
                    ],
                },
            ],
        }
        # 在顶层承托面（底层棚板 200..800）内加柱，丢失载荷应清零
        r = suggest_posts(state, layer=1, spacing=200, capacity=0)
        self.assertTrue(r["feasible"], r["reason"])
        p = r["proposals"][0]
        self.assertEqual(p["metrics"]["lostLoad"], 0.0)
        self.assertEqual(
            p["result"]["layers"][1]["posts"][-1]["id"], p["postId"]
        )
        removed = {(i["type"], i["layer"]) for i in p["diff"]["removedIssues"]}
        # 新增有效柱后本层不再“无支撑”；原有悬空柱 H 仍悬空（hang 保留）
        self.assertIn(("unsupported", 1), removed)
        self.assertNotIn(("hang", 1), removed)

    def test_suggest_no_feasible_point_when_support_covered(self):
        # 承托面 10×10、有效柱在中心 (5,5)、间距 10：四个角点距中心 √50≈7.07 ≤ 10，
        # 全部落在重叠阈值内 → 无可行点，reason 需说明是重叠阈值导致
        state = {
            "car": {"w": 10, "d": 10},
            "layers": [
                {
                    "name": "底",
                    "board": {"x": 0, "y": 0, "w": 10, "d": 10, "weight": 10},
                    "wareWeight": 0,
                    "posts": [{"id": "A", "x": 5, "y": 5, "capacity": 0}],
                }
            ],
        }
        r = suggest_posts(state, layer=0, spacing=10, capacity=0)
        self.assertFalse(r["feasible"])
        self.assertEqual(r["tried"], 0)
        self.assertIn("重叠阈值", r["reason"])
        # 承托面宽/深为 0：没有承托面，同样无可行点
        tiny = {
            "car": {"w": 0, "d": 0},
            "layers": [
                {"name": "底", "board": {"x": 0, "y": 0, "w": 0, "d": 0, "weight": 0},
                 "wareWeight": 0, "posts": []}
            ],
        }
        r0 = suggest_posts(tiny, layer=0, spacing=100, capacity=0)
        self.assertFalse(r0["feasible"])
        self.assertIn("承托面", r0["reason"])

    def test_suggest_invalid_arguments(self):
        state = self._suggest_state()
        self.assertFalse(suggest_posts(state, layer=9, spacing=100, capacity=0)["feasible"])
        bad = suggest_posts(state, layer=0, spacing=0, capacity=0)
        self.assertFalse(bad["feasible"])
        self.assertIn("间距", bad["reason"])
        huge = suggest_posts(state, layer=0, spacing=1, capacity=0)
        self.assertFalse(huge["feasible"])
        self.assertGreater(huge["gridCount"], 2500)
        self.assertIn("2500", huge["reason"])

    def test_suggest_does_not_mutate_input(self):
        import copy as _copy
        state = self._suggest_state()
        snap = _copy.deepcopy(state)
        suggest_posts(state, layer=0, spacing=200, capacity=123)
        self.assertEqual(state, snap)

    def test_support_rect_is_lower_board_for_upper_layer(self):
        state = {
            "car": {"w": 1000, "d": 1000},
            "layers": [
                {"name": "底", "board": {"x": 300, "y": 300, "w": 400, "d": 400, "weight": 0},
                 "wareWeight": 0, "posts": [{"id": "A", "x": 500, "y": 500, "capacity": 0}]},
                {"name": "顶", "board": {"x": 300, "y": 300, "w": 400, "d": 400, "weight": 10},
                 "wareWeight": 0, "posts": []},
            ],
        }
        r = suggest_posts(state, layer=1, spacing=200, capacity=0)
        self.assertTrue(r["feasible"], r["reason"])
        # 所有候选点必须在下层棚板矩形 [300,700]×[300,700] 内
        for p in r["proposals"]:
            self.assertTrue(300 <= p["x"] <= 700 and 300 <= p["y"] <= 700)
            self.assertFalse(p["result"]["layers"][1]["posts"][-1]["hanging"])


if __name__ == "__main__":
    unittest.main()
