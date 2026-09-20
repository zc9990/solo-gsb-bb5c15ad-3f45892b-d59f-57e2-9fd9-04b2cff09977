# -*- coding: utf-8 -*-
"""Flask 服务：静态页面 + 状态持久化 API。

接口
----
GET  /api/state      读取当前架体（输入），首次启动自动载入示例数据
PUT  /api/state      保存编辑后的架体（JSON body）
POST /api/recalc     对给定（或当前持久化）架体重算，返回完整结果
GET  /api/result     直接返回当前持久化架体的重算结果
POST /api/simulate   立柱失效推演：body {"state": 架体JSON(可省), "failed": [{"layer": 0, "post": "P1"}]}，
                     返回基准/推演/差值；只计算，不写盘、不保存失效标记
POST /api/reset      恢复内置示例数据
"""

from __future__ import annotations

import json
import os
import tempfile

from flask import Flask, jsonify, request, send_from_directory

from .calc import calculate, simulate

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATIC_DIR = os.path.join(BASE_DIR, "static")
DATA_DIR = os.environ.get(
    "KILN_DATA_DIR", os.path.join(BASE_DIR, "data")
)
STATE_FILE = os.path.join(DATA_DIR, "state.json")
SAMPLE_FILE = os.path.join(DATA_DIR, "sample_state.json")

app = Flask(__name__, static_folder=None)


def _read_json(path: str):
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _atomic_write_json(path: str, payload) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(path), suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        os.replace(tmp, path)
    finally:
        if os.path.exists(tmp):
            os.remove(tmp)


def load_state():
    if not os.path.exists(STATE_FILE):
        _atomic_write_json(STATE_FILE, _read_json(SAMPLE_FILE))
    return _read_json(STATE_FILE)


@app.route("/")
def index():
    return send_from_directory(STATIC_DIR, "index.html")


@app.route("/static/<path:filename>")
def static_files(filename):
    return send_from_directory(STATIC_DIR, filename)


@app.route("/api/state", methods=["GET"])
def api_get_state():
    return jsonify(load_state())


@app.route("/api/state", methods=["PUT"])
def api_put_state():
    payload = request.get_json(force=True, silent=True)
    if not isinstance(payload, dict):
        return jsonify({"error": "请求体必须是 JSON 对象"}), 400
    _atomic_write_json(STATE_FILE, payload)
    return jsonify({"ok": True, "result": calculate(payload)})


@app.route("/api/recalc", methods=["POST"])
def api_recalc():
    payload = request.get_json(force=True, silent=True)
    state = payload if isinstance(payload, dict) else load_state()
    return jsonify(calculate(state))


@app.route("/api/result", methods=["GET"])
def api_result():
    return jsonify(calculate(load_state()))


@app.route("/api/simulate", methods=["POST"])
def api_simulate():
    """立柱失效推演：只计算，不写盘；失效标记不持久化。"""
    payload = request.get_json(force=True, silent=True)
    payload = payload if isinstance(payload, dict) else {}
    state = payload.get("state")
    if not isinstance(state, dict):
        state = load_state()
    failed = payload.get("failed")
    if not isinstance(failed, list):
        failed = []
    return jsonify(simulate(state, failed))


@app.route("/api/reset", methods=["POST"])
def api_reset():
    sample = _read_json(SAMPLE_FILE)
    _atomic_write_json(STATE_FILE, sample)
    return jsonify({"ok": True, "state": sample, "result": calculate(sample)})


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8000"))
    app.run(host="0.0.0.0", port=port)
