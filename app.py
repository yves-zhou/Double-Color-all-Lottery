#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
双色球中奖识别 Web 服务

提供两个接口：
  POST /api/check  — 接收彩票照片，调用视觉 API 识别号码与期号，
                      自动从中彩网拉取开奖号码，返回逐注比对结果。
  GET  /api/health — 健康检查。
"""

import base64
import datetime
import json
import os
import re
import sys
import tempfile
import traceback
from typing import Any, Dict, List, Optional, Tuple

from flask import Flask, jsonify, render_template, request
from flask_cors import CORS

# ── 项目根（ssq_web/）───────────────────────────────────────────
_BASE_DIR = os.path.dirname(os.path.abspath(__file__))
_CONFIG_PATH = os.path.join(_BASE_DIR, "config.json")

# ── Flask 初始化 ─────────────────────────────────────────────────
app = Flask(__name__)
CORS(app)

# ============================================================
#  配置加载
# ============================================================

def load_config() -> Dict[str, str]:
    """加载 API 配置。优先级：环境变量 > config.json。"""
    result: Dict[str, str] = {}

    # 1. 先从 config.json 读取（作为默认值）
    if os.path.isfile(_CONFIG_PATH):
        try:
            with open(_CONFIG_PATH, "r", encoding="utf-8") as f:
                cfg = json.load(f)
            if isinstance(cfg, dict):
                for key in ("api_key", "base_url", "model"):
                    if key in cfg and isinstance(cfg[key], str) and cfg[key]:
                        result[key] = cfg[key]
        except (json.JSONDecodeError, OSError):
            pass

    # 2. 环境变量覆盖（用于生产环境部署）
    env_map = {
        "api_key":  "SSQ_API_KEY",
        "base_url": "SSQ_BASE_URL",
        "model":    "SSQ_MODEL",
    }
    for cfg_key, env_key in env_map.items():
        val = os.environ.get(env_key, "").strip()
        if val:
            result[cfg_key] = val

    return result

# ============================================================
#  号码校验 & 中奖判定（纯函数，无副作用）
# ============================================================

def validate_red_balls(reds: List[int]) -> Optional[str]:
    """校验红球。返回 None = 通过。"""
    if len(reds) != 6:
        return f"红球需要恰好 6 个号码，当前 {len(reds)} 个"
    for num in reds:
        if not isinstance(num, int) or num < 1 or num > 33:
            return f"红球号码 1~33，非法值: {num}"
    if len(set(reds)) != 6:
        return "红球号码不能重复"
    return None


def validate_blue_ball(blue: int) -> Optional[str]:
    """校验蓝球。"""
    if not isinstance(blue, int) or blue < 1 or blue > 16:
        return f"蓝球号码 1~16，非法值: {blue}"
    return None


def check_prize(user_reds: List[int], user_blue: int,
                win_reds: List[int], win_blue: int) -> Tuple[int, str]:
    """返回 (等级, 描述)。等级 0 = 未中奖。"""
    red_hit = len(set(user_reds) & set(win_reds))
    blue_hit = (user_blue == win_blue)

    if red_hit == 6 and blue_hit:
        return (1, "一等奖（6+1）")
    elif red_hit == 6 and not blue_hit:
        return (2, "二等奖（6+0）")
    elif red_hit == 5 and blue_hit:
        return (3, "三等奖（5+1）")
    elif (red_hit == 5 and not blue_hit) or (red_hit == 4 and blue_hit):
        return (4, "四等奖（5+0 或 4+1）")
    elif (red_hit == 4 and not blue_hit) or (red_hit == 3 and blue_hit):
        return (5, "五等奖（4+0 或 3+1）")
    elif blue_hit:
        return (6, "六等奖（蓝球中）")
    else:
        return (0, "未中奖")


def format_balls(reds: List[int], blue: int) -> str:
    red_str = " ".join(f"{r:02d}" for r in sorted(reds))
    return f"红球 [{red_str}]  蓝球 [{blue:02d}]"

# ============================================================
#  视觉 API 识别（OpenAI 兼容接口）
# ============================================================

_VISION_SYSTEM_PROMPT = """你是一个双色球彩票信息提取器。仔细查看图片，提取图中所有双色球相关信息。

规则：
- 红球：1-33 中选 6 个（同一注不重复），蓝球：1-16 中选 1 个
- 将图片中见到的每一注号码提取出来
- 找出开奖期号（通常格式为 7 位数字，如 2026061），如果找不到期号，period 设为空字符串 ""
- 必须返回严格的 JSON，不要加任何解释、说明或 markdown 标记
- JSON 格式：
  {"period": "2026061", "entries": [{"reds": [1, 2, 3, 4, 5, 6], "blue": 7}, {"reds": [10, 12, 14, 16, 18, 20], "blue": 5}]}

如果图中没有看到任何有效投注号码，entries 返回空数组，period 返回空字符串。"""


def _encode_image(image_path: str) -> str:
    """将图片编码为 base64 data URL。"""
    if not os.path.isfile(image_path):
        raise FileNotFoundError(f"图片文件不存在：{image_path}")
    ext = os.path.splitext(image_path)[1].lower().lstrip(".")
    mime_map = {
        "jpg": "image/jpeg", "jpeg": "image/jpeg",
        "png": "image/png", "gif": "image/gif",
        "webp": "image/webp", "bmp": "image/bmp",
    }
    mime_type = mime_map.get(ext, "image/jpeg")
    with open(image_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    return f"data:{mime_type};base64,{b64}"


def _call_vision_api(image_path: str) -> str:
    """调用视觉模型，返回原始文本。"""
    from openai import OpenAI

    cfg = load_config()
    api_key = cfg.get("api_key", "").strip()
    if not api_key:
        raise RuntimeError("未配置 API 密钥，请在 config.json 中设置 api_key")

    base_url = cfg.get("base_url", "").strip() or "https://api.openai.com/v1"
    model = cfg.get("model", "").strip() or "gpt-4o"

    client = OpenAI(api_key=api_key, base_url=base_url)
    data_url = _encode_image(image_path)

    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": _VISION_SYSTEM_PROMPT},
            {"role": "user", "content": [
                {"type": "image_url", "image_url": {"url": data_url}},
            ]},
        ],
        max_tokens=2048,
        temperature=0.0,
    )
    return (response.choices[0].message.content or "").strip()


def _parse_vision_response(raw_text: str) -> Tuple[str, List[Tuple[List[int], int, str]]]:
    """解析视觉模型返回 JSON → (period, entries)。"""
    try:
        data = json.loads(raw_text)
    except json.JSONDecodeError:
        match = re.search(r"\{.*\}", raw_text, re.DOTALL)
        if match:
            try:
                data = json.loads(match.group())
            except json.JSONDecodeError:
                raise ValueError(f"视觉模型返回格式无法解析。原始输出：\n{raw_text}")
        else:
            raise ValueError(f"视觉模型返回格式无法解析。原始输出：\n{raw_text}")

    if not isinstance(data, dict):
        raise ValueError(f"视觉模型返回非对象格式。原始输出：\n{raw_text}")

    period = str(data.get("period", "")).strip()
    raw_entries = data.get("entries", [])
    if not isinstance(raw_entries, list):
        raise ValueError(f"entries 字段不是数组。原始输出：\n{raw_text}")

    labels = "ABCDEFGHIJKLMNOPQRSTUVWXYZ"
    entries: List[Tuple[List[int], int, str]] = []

    for item in raw_entries:
        try:
            reds_raw = item.get("reds", [])
            blue_raw = item.get("blue")
        except AttributeError:
            continue
        if not isinstance(reds_raw, list) or len(reds_raw) != 6:
            continue
        if not isinstance(blue_raw, int) and not (isinstance(blue_raw, float) and blue_raw == int(blue_raw)):
            continue
        blue_raw = int(blue_raw)
        try:
            reds_int = [int(r) for r in reds_raw]
        except (ValueError, TypeError):
            continue
        if not all(1 <= r <= 33 for r in reds_int):
            continue
        if not (1 <= blue_raw <= 16):
            continue
        reds = sorted(reds_int)
        if len(set(reds)) != 6:
            continue
        label = labels[len(entries)] if len(entries) < 26 else f"注{len(entries) + 1}"
        entries.append((reds, blue_raw, label))

    return period, entries

# ============================================================
#  中彩网开奖号码抓取
# ============================================================

_CWL_API_URL = "https://www.cwl.gov.cn/cwl_admin/front/cwlkj/search/kjxx/findDrawNotice"


def fetch_winning_numbers(period: str) -> Tuple[List[int], int, str]:
    """从中彩网 API 获取开奖号码。返回 (reds, blue, period_display)。"""
    import requests as _requests

    params = {
        "name": "ssq",
        "issueCount": "",
        "issueStart": period,
        "issueEnd": period,
        "dayStart": "",
        "dayEnd": "",
        "pageNo": "1",
        "pageSize": "1",
        "week": "",
        "systemType": "PC",
    }

    try:
        resp = _requests.get(_CWL_API_URL, params=params, timeout=15)
        resp.raise_for_status()
        payload = resp.json()
    except _requests.exceptions.Timeout:
        raise RuntimeError("请求中彩网超时，请检查网络后重试")
    except _requests.exceptions.ConnectionError:
        raise RuntimeError("无法连接中彩网，请检查网络")
    except _requests.exceptions.RequestException as e:
        raise RuntimeError(f"网络请求失败：{e}")
    except ValueError:
        raise RuntimeError("中彩网返回数据无法解析，请稍后重试")

    results = payload.get("result", [])
    if not results:
        raise RuntimeError(f"期号 {period} 暂无开奖数据（可能尚未开奖或期号不存在）")

    item = results[0]
    code = str(item.get("code", period))
    red_str = str(item.get("red", ""))
    blue_str = str(item.get("blue", ""))

    if not red_str or not blue_str:
        raise RuntimeError(f"期号 {period} 开奖数据不完整")

    try:
        reds = sorted([int(x.strip()) for x in red_str.split(",")])
        blue = int(blue_str.strip())
    except (ValueError, TypeError):
        raise RuntimeError(f"解析期号 {period} 开奖号码失败")

    if len(reds) != 6 or not all(1 <= r <= 33 for r in reds):
        raise RuntimeError(f"期号 {period} 红球数据异常")
    if not (1 <= blue <= 16):
        raise RuntimeError(f"期号 {period} 蓝球数据异常")

    return reds, blue, code

# ============================================================
#  Flask 路由
# ============================================================

@app.route("/")
def index():
    return render_template("index.html")


@app.route("/api/health", methods=["GET"])
def health():
    return jsonify({"status": "ok", "message": "双色球中奖识别服务运行中"})


@app.route("/api/check", methods=["POST"])
def check():
    """
    接收彩票照片，全自动识别 + 比对。

    请求：multipart/form-data，字段名 file
    返回 JSON 见下方 _build_result / _build_error
    """
    # ── 1. 校验上传文件 ──────────────────────────────────
    if "file" not in request.files:
        return _build_error("未收到文件，请上传彩票照片", stage="upload"), 400

    f = request.files["file"]
    if f.filename == "" or f.filename is None:
        return _build_error("文件名为空", stage="upload"), 400

    # 保存到临时文件
    suffix = os.path.splitext(f.filename or "ticket.jpg")[1] or ".jpg"
    fd, tmp_path = tempfile.mkstemp(suffix=suffix)
    try:
        os.close(fd)
        f.save(tmp_path)

        # ── 2. 视觉 API 识别 ──────────────────────────────
        try:
            raw_text = _call_vision_api(tmp_path)
        except ImportError:
            return _build_error("服务器未安装 openai 库，请联系管理员", stage="vision"), 500
        except RuntimeError as e:
            return _build_error(str(e), stage="vision"), 500
        except Exception as e:
            return _build_error(f"视觉 API 调用失败：{e}", stage="vision"), 500

        # ── 3. 解析识别结果 ───────────────────────────────
        try:
            period, entries = _parse_vision_response(raw_text)
        except ValueError as e:
            return _build_error(str(e), stage="parse", raw_output=raw_text), 422

        if not entries:
            return _build_error(
                "未能从图片中识别到有效投注号码，请确认照片清晰、包含双色球彩票",
                stage="parse",
                raw_output=raw_text,
            ), 422

        # ── 4. 获取中奖号码 ───────────────────────────────
        win_reds: List[int]
        win_blue: int
        fetch_error: Optional[str] = None

        if period:
            try:
                win_reds, win_blue, period_display = fetch_winning_numbers(period)
            except RuntimeError as e:
                fetch_error = str(e)
                # 没有中奖号码就无法比对，返回识别结果 + 错误
                return _build_result(
                    period=period,
                    entries=entries,
                    win_reds=None,
                    win_blue=None,
                    fetch_error=fetch_error,
                )
            except ImportError:
                fetch_error = "服务器未安装 requests 库，无法自动获取开奖号码"
                return _build_result(
                    period=period,
                    entries=entries,
                    win_reds=None,
                    win_blue=None,
                    fetch_error=fetch_error,
                )
        else:
            fetch_error = "未能识别出开奖期号"
            return _build_result(
                period="",
                entries=entries,
                win_reds=None,
                win_blue=None,
                fetch_error=fetch_error,
            )

        # ── 5. 逐注比对 ───────────────────────────────────
        return _build_result(
            period=period_display,
            entries=entries,
            win_reds=win_reds,
            win_blue=win_blue,
        )

    finally:
        # 清理临时文件
        try:
            os.unlink(tmp_path)
        except OSError:
            pass


# ============================================================
#  响应构建辅助函数
# ============================================================

def _build_error(
    error: str,
    stage: str = "unknown",
    raw_output: Optional[str] = None,
) -> Tuple:
    """构建错误响应。"""
    body: Dict[str, Any] = {
        "success": False,
        "error": error,
        "stage": stage,
    }
    if raw_output:
        body["raw_output"] = raw_output
    return jsonify(body)


def _build_result(
    period: str,
    entries: List[Tuple[List[int], int, str]],
    win_reds: Optional[List[int]],
    win_blue: Optional[int],
    fetch_error: Optional[str] = None,
) -> Tuple:
    """构建成功 / 部分成功响应。"""
    # 序列化 entries
    entries_json = [
        {
            "label": label,
            "reds": reds,
            "blue": blue,
            "reds_display": [f"{r:02d}" for r in reds],
            "blue_display": f"{blue:02d}",
        }
        for reds, blue, label in entries
    ]

    body: Dict[str, Any] = {
        "success": True,
        "period": period,
        "entries": entries_json,
        "total": len(entries),
        "cost": len(entries) * 2,
    }

    if fetch_error:
        body["fetch_error"] = fetch_error
        body["has_winning_numbers"] = False
        return jsonify(body)

    if win_reds is None or win_blue is None:
        body["has_winning_numbers"] = False
        return jsonify(body)

    # 有完整中奖号码 → 逐注比对
    body["has_winning_numbers"] = True
    body["winning"] = {
        "reds": win_reds,
        "blue": win_blue,
        "reds_display": [f"{r:02d}" for r in win_reds],
        "blue_display": f"{win_blue:02d}",
    }

    results = []
    stats: Dict[int, int] = {1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 0: 0}

    for reds, blue, label in entries:
        level, desc = check_prize(reds, blue, win_reds, win_blue)
        stats[level] += 1
        red_hit_count = len(set(reds) & set(win_reds))
        results.append({
            "label": label,
            "reds": reds,
            "blue": blue,
            "reds_display": [f"{r:02d}" for r in reds],
            "blue_display": f"{blue:02d}",
            "level": level,
            "desc": desc,
            "red_hit": red_hit_count,
            "blue_hit": (blue == win_blue),
        })

    body["results"] = results
    body["stats"] = stats

    return jsonify(body)


# ============================================================
#  SSL 自签名证书（移动端摄像头需要 HTTPS）
# ============================================================

def _ensure_ssl_cert(cert_path: str, key_path: str) -> Tuple[str, str]:
    """确保存在自签名证书，不存在则自动生成。返回 (cert_path, key_path)。"""
    if os.path.isfile(cert_path) and os.path.isfile(key_path):
        return cert_path, key_path

    try:
        from cryptography import x509
        from cryptography.x509.oid import NameOID
        from cryptography.hazmat.primitives import hashes, serialization
        from cryptography.hazmat.primitives.asymmetric import rsa
        from cryptography.hazmat.backends import default_backend
    except ImportError:
        print("  [!] 需要安装 cryptography 来生成 SSL 证书：pip install cryptography")
        print("  将使用 HTTP 模式（移动端摄像头不可用）")
        return None, None

    print("  正在生成自签名 SSL 证书...")

    key = rsa.generate_private_key(public_exponent=65537, key_size=2048, backend=default_backend())

    subject = issuer = x509.Name([
        x509.NameAttribute(NameOID.COMMON_NAME, "localhost"),
        x509.NameAttribute(NameOID.ORGANIZATION_NAME, "SSQ Checker"),
    ])

    cert = (
        x509.CertificateBuilder()
        .subject_name(subject)
        .issuer_name(issuer)
        .public_key(key.public_key())
        .serial_number(x509.random_serial_number())
        .not_valid_before(datetime.datetime.utcnow())
        .not_valid_after(datetime.datetime.utcnow() + datetime.timedelta(days=365))
        .add_extension(
            x509.SubjectAlternativeName([
                x509.DNSName("localhost"),
                x509.DNSName("127.0.0.1"),
            ]),
            critical=False,
        )
        .sign(key, hashes.SHA256(), default_backend())
    )

    with open(key_path, "wb") as f:
        f.write(key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.TraditionalOpenSSL,
            encryption_algorithm=serialization.NoEncryption(),
        ))

    with open(cert_path, "wb") as f:
        f.write(cert.public_bytes(serialization.Encoding.PEM))

    print(f"  证书已生成: {cert_path}")
    return cert_path, key_path


# ============================================================
#  启动
# ============================================================

if __name__ == "__main__":
    print("=" * 56)
    print("  双色球中奖识别 Web 服务")
    print("=" * 56)
    cfg = load_config()
    if cfg.get("api_key"):
        print(f"  API 已配置  |  模型: {cfg.get('model', 'N/A')}")
    else:
        print("  [!] 请在 config.json 中设置 api_key")

    # SSL 证书（移动端摄像头需要 HTTPS）
    cert_file, key_file = _ensure_ssl_cert(
        os.path.join(_BASE_DIR, "cert.pem"),
        os.path.join(_BASE_DIR, "key.pem"),
    )

    if cert_file:
        print(f"  访问地址: https://localhost:5000")
        print(f"  [!] 自签名证书，浏览器会提示不安全，点击「继续访问」即可")
    else:
        print(f"  访问地址: http://127.0.0.1:5000")
    print(f"  API 文档: POST /api/check  |  GET /api/health")
    print("=" * 56)

    ssl_context = (cert_file, key_file) if cert_file else None
    app.run(host="0.0.0.0", port=5000, debug=True, ssl_context=ssl_context)