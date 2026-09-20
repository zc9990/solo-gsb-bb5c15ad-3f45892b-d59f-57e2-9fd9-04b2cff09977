# -*- coding: utf-8 -*-
"""核心计算引擎单元测试：python -m pytest -q 或 python tests/test_calc.py"""

import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app.calc import calculate, normalize, simulate  # noqa: E402

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


if __name__ == "__main__":
    unittest.main()
