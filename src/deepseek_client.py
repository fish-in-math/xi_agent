from __future__ import annotations

import os
import re
import time
from typing import Any, Dict, Optional

import json

import requests
from requests.adapters import HTTPAdapter
from dotenv import load_dotenv


class DeepSeekError(Exception):
    pass


READ_TIMEOUT_SECONDS = 300
READ_TIMEOUT_RETRY_COUNT = 1
READ_TIMEOUT_RETRY_DELAY_SECONDS = 1.5
HTTP_POOL_CONNECTIONS = 32
HTTP_POOL_MAXSIZE = 64
CUSTOM_SUMMARY_MAX_COLUMNS = 24
CUSTOM_SUMMARY_MAX_NUMERIC_COLUMNS = 14
CUSTOM_SUMMARY_MAX_CATEGORY_ITEMS = 12
CUSTOM_PREVIOUS_CODE_MAX_LINES = 220
CUSTOM_PREVIOUS_CODE_MAX_CHARS = 9000
CHART_SUGGESTION_BANNED_TERMS = [
    "多轴",
    "双轴",
    "双y轴",
    "双坐标轴",
    "次坐标轴",
    "secondary_y",
    "secondary y",
    "组合图",
]
CHART_SUGGESTION_SAFE_FALLBACK = (
    "建议优先采用折线图、分组柱状图、散点图和热力图进行对比与趋势分析。"
)


def _read_bool_env(name: str, default: bool) -> bool:
    raw = os.getenv(name)
    if raw is None:
        return default
    text = str(raw).strip().lower()
    if text in {"1", "true", "yes", "on"}:
        return True
    if text in {"0", "false", "no", "off"}:
        return False
    return default


def _supports_enable_thinking(model: str | None) -> bool:
    normalized = str(model or "").strip().lower()
    if not normalized:
        return False
    # Current visualization path uses Qwen family, which supports enable_thinking.
    return normalized.startswith("qwen/")


def _build_http_session() -> requests.Session:
    session = requests.Session()
    adapter = HTTPAdapter(
        pool_connections=HTTP_POOL_CONNECTIONS, pool_maxsize=HTTP_POOL_MAXSIZE
    )
    session.mount("https://", adapter)
    session.mount("http://", adapter)
    return session


_HTTP_SESSION = _build_http_session()


def _truncate_list(items: list[Any], max_items: int) -> tuple[list[Any], int]:
    safe_items = list(items or [])
    if len(safe_items) <= max_items:
        return safe_items, 0
    return safe_items[:max_items], len(safe_items) - max_items


def _to_float_or_none(value: Any) -> float | None:
    try:
        num = float(value)
    except Exception:
        return None
    if num != num:
        return None
    if num in (float("inf"), float("-inf")):
        return None
    return num


def _round_if_number(value: Any, ndigits: int = 6) -> Any:
    num = _to_float_or_none(value)
    if num is None:
        return value
    return round(num, ndigits)


def _compact_custom_chart_summary(summary: Dict[str, Any]) -> Dict[str, Any]:
    """Keep only the highest-signal fields for chart generation prompts."""
    safe = summary if isinstance(summary, dict) else {}

    rows = int(safe.get("rows", 0) or 0)
    cols = int(safe.get("cols", 0) or 0)
    columns = [str(c) for c in (safe.get("columns") or [])]
    numeric_columns = [str(c) for c in (safe.get("numeric_columns") or [])]
    categorical_columns = [str(c) for c in (safe.get("categorical_columns") or [])]

    columns_preview, columns_omitted = _truncate_list(
        columns, CUSTOM_SUMMARY_MAX_COLUMNS
    )
    numeric_preview, numeric_omitted = _truncate_list(
        numeric_columns, CUSTOM_SUMMARY_MAX_NUMERIC_COLUMNS
    )
    category_preview, category_omitted = _truncate_list(
        categorical_columns, CUSTOM_SUMMARY_MAX_NUMERIC_COLUMNS
    )

    compact: Dict[str, Any] = {
        "shape": {"rows": rows, "cols": cols},
        "columns_preview": columns_preview,
        "numeric_columns_preview": numeric_preview,
        "categorical_columns_preview": category_preview,
    }

    if columns_omitted > 0:
        compact["columns_omitted"] = columns_omitted
    if numeric_omitted > 0:
        compact["numeric_columns_omitted"] = numeric_omitted
    if category_omitted > 0:
        compact["categorical_columns_omitted"] = category_omitted

    describe = safe.get("describe") or {}
    if isinstance(describe, dict) and describe:
        numeric_stats: Dict[str, Any] = {}
        candidate_cols = numeric_preview or list(describe.keys())
        for col in candidate_cols[:CUSTOM_SUMMARY_MAX_NUMERIC_COLUMNS]:
            stats = describe.get(col)
            if not isinstance(stats, dict):
                continue
            numeric_stats[col] = {
                "count": _round_if_number(stats.get("count")),
                "mean": _round_if_number(stats.get("mean")),
                "std": _round_if_number(stats.get("std")),
                "min": _round_if_number(stats.get("min")),
                "p50": _round_if_number(stats.get("50%")),
                "max": _round_if_number(stats.get("max")),
            }
        if numeric_stats:
            compact["numeric_stats"] = numeric_stats

    top_categories = safe.get("top_categories") or {}
    if isinstance(top_categories, dict) and top_categories:
        compact_categories: Dict[str, Any] = {}
        for col_name, values in list(top_categories.items())[:2]:
            if not isinstance(values, dict):
                continue
            compact_values = dict(
                list(values.items())[:CUSTOM_SUMMARY_MAX_CATEGORY_ITEMS]
            )
            compact_categories[str(col_name)] = compact_values
        if compact_categories:
            compact["top_categories"] = compact_categories

    return compact


def _extract_import_block(code: str) -> str:
    import_lines: list[str] = []
    for line in code.splitlines():
        stripped = line.strip()
        if stripped.startswith("import ") or stripped.startswith("from "):
            import_lines.append(line)
    return "\n".join(import_lines[:30]).strip()


def _extract_make_custom_fig_block(code: str) -> str:
    lines = code.splitlines()
    start_idx = -1
    for idx, line in enumerate(lines):
        if re.match(r"^\s*def\s+make_custom_fig\s*\(", line):
            start_idx = idx
            break

    if start_idx < 0:
        return ""

    selected = lines[start_idx : start_idx + CUSTOM_PREVIOUS_CODE_MAX_LINES]
    return "\n".join(selected).strip()


def _compact_previous_code_for_prompt(previous_code: str | None) -> str:
    code = (previous_code or "").strip()
    if not code:
        return ""

    import_block = _extract_import_block(code)
    fig_block = _extract_make_custom_fig_block(code)

    if fig_block:
        parts = []
        if import_block:
            parts.append(import_block)
            parts.append("")
        parts.append(fig_block)
        compact = "\n".join(parts).strip()
    else:
        compact = "\n".join(code.splitlines()[-CUSTOM_PREVIOUS_CODE_MAX_LINES:]).strip()

    if len(compact) > CUSTOM_PREVIOUS_CODE_MAX_CHARS:
        compact = (
            compact[:CUSTOM_PREVIOUS_CODE_MAX_CHARS].rstrip()
            + "\n# ... truncated for prompt efficiency"
        )

    return compact


def _normalize_base_url(base: str) -> str:
    return str(base or "").rstrip("/")


def _clean_env_value(value: str | None) -> str | None:
    if value is None:
        return None
    text = str(value).strip().strip('"').strip("'")
    return text or None


def _has_non_ascii(text: str | None) -> bool:
    if not text:
        return False
    return any(ord(ch) > 127 for ch in text)


def _resolve_deepseek_config() -> tuple[str | None, str, str]:
    # override=True ensures .env edits can take effect for long-running server processes.
    load_dotenv(override=True)
    key = _clean_env_value(os.getenv("DEEPSEEK_API_KEY"))
    base = (
        os.getenv("DEEPSEEK_API_BASE")
        or os.getenv("DEEPSEEK_BASE_URL")
        or "https://api.deepseek.com/v1"
    )
    model = (
        _clean_env_value(os.getenv("DEEPSEEK_MODEL", "deepseek-chat"))
        or "deepseek-chat"
    )
    return key, _normalize_base_url(base), model


def _resolve_vl_viz_config() -> tuple[str | None, str, str]:
    # override=True ensures .env edits can take effect for long-running server processes.
    load_dotenv(override=True)
    key = _clean_env_value(os.getenv("VL_API_KEY"))
    base = os.getenv("VL_API_BASE") or "https://api.siliconflow.cn/v1"
    model = (
        _clean_env_value(os.getenv("VL_MODEL") or "Qwen/Qwen3.5-35B-A3B")
        or "Qwen/Qwen3.5-35B-A3B"
    )
    if "/" not in model and re.match(r"(?i)^qwen[\w.-]+$", model):
        model = f"Qwen/{model}"
    return key, _normalize_base_url(base), model


def _post_chat_raw(
    *,
    api_key: str,
    base_url: str,
    model: str,
    messages: list[dict],
    temperature: float,
    enable_thinking: bool | None = None,
) -> str:
    url = f"{base_url}/chat/completions"
    headers = {
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    }
    body = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
    }
    if enable_thinking is not None:
        body["enable_thinking"] = bool(enable_thinking)
    resp: requests.Response | None = None
    last_timeout_error: Exception | None = None
    for attempt in range(READ_TIMEOUT_RETRY_COUNT + 1):
        try:
            resp = _HTTP_SESSION.post(
                url, json=body, headers=headers, timeout=READ_TIMEOUT_SECONDS
            )
            break
        except requests.exceptions.ReadTimeout as exc:
            last_timeout_error = exc
            if attempt < READ_TIMEOUT_RETRY_COUNT:
                time.sleep(READ_TIMEOUT_RETRY_DELAY_SECONDS)
                continue
            raise DeepSeekError(
                f"Read timeout after retry ({READ_TIMEOUT_SECONDS}s x {READ_TIMEOUT_RETRY_COUNT + 1} attempts): {exc}"
            ) from exc

    if resp is None:
        raise DeepSeekError(f"Request failed unexpectedly: {last_timeout_error}")
    if resp.status_code != 200:
        raise DeepSeekError(f"HTTP {resp.status_code}: {resp.text}")
    data = resp.json()
    try:
        return data["choices"][0]["message"]["content"]
    except Exception as e:
        raise DeepSeekError(f"Unexpected response: {data}") from e


def _post_chat(messages: list[dict], temperature: float = 0.2) -> str:
    # Load .env (non-invasive) and fetch runtime env vars so changes take effect without server restart
    key, base, model = _resolve_deepseek_config()

    if not key:
        raise DeepSeekError("DEEPSEEK_API_KEY not set in environment")
    if _has_non_ascii(key):
        raise DeepSeekError(
            "DEEPSEEK_API_KEY appears invalid (contains non-ASCII chars). Please replace placeholder text with a real key."
        )
    return _post_chat_raw(
        api_key=key,
        base_url=base,
        model=model,
        messages=messages,
        temperature=temperature,
    )


def _post_chat_stream(messages: list[dict], temperature: float = 0.2):
    key, base, model = _resolve_deepseek_config()

    if not key:
        yield "[Error] DEEPSEEK_API_KEY not set in environment"
        return
    if _has_non_ascii(key):
        yield "[Error] DEEPSEEK_API_KEY appears invalid (contains non-ASCII chars)."
        return
    url = f"{base}/chat/completions"
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    body = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "stream": True,
    }

    for attempt in range(READ_TIMEOUT_RETRY_COUNT + 1):
        try:
            with _HTTP_SESSION.post(
                url,
                json=body,
                headers=headers,
                timeout=READ_TIMEOUT_SECONDS,
                stream=True,
            ) as resp:
                if resp.status_code != 200:
                    yield f"[Error] HTTP {resp.status_code}: {resp.text}"
                    return
                for line in resp.iter_lines():
                    if line:
                        decoded_line = line.decode("utf-8")
                        if decoded_line.startswith("data: "):
                            data_str = decoded_line[6:]
                            if data_str == "[DONE]":
                                break
                            try:
                                data_json = json.loads(data_str)
                                if (
                                    "choices" in data_json
                                    and len(data_json["choices"]) > 0
                                ):
                                    delta = data_json["choices"][0].get("delta", {})
                                    if "content" in delta:
                                        yield delta["content"]
                            except Exception:
                                pass
                return
        except requests.exceptions.ReadTimeout as e:
            if attempt < READ_TIMEOUT_RETRY_COUNT:
                time.sleep(READ_TIMEOUT_RETRY_DELAY_SECONDS)
                continue
            yield f"[Error] Read timeout after retry ({READ_TIMEOUT_SECONDS}s x {READ_TIMEOUT_RETRY_COUNT + 1} attempts): {e}"
            return
        except Exception as e:
            yield f"[Error] {e}"
            return


def generate_chart_suggestions(
    summary: Dict[str, Any], user_prompt: Optional[str] = None
) -> str:
    prompt = (
        "你是数据可视化专家。基于以下数据摘要，给出30-40字的可视化建议，"
        "推荐适合当前数据结构和维度的图表类型及相应的分析方向（有多适合的就推荐几个，不要强制拼凑）。"
        "禁止推荐多轴组合图（包括双轴、双Y轴、次坐标轴方案）。\n\n"
        + (f"用户要求/期望：{user_prompt}\n\n" if user_prompt else "")
        + f"摘要: {summary}"
    )
    messages = [
        {
            "role": "system",
            "content": "你是资深数据分析与可视化顾问。语言简练，只输出30-40字核心建议，不要排版修饰。严禁推荐多轴组合图（双轴/双Y轴/次坐标轴）。",
        },
        {"role": "user", "content": prompt},
    ]
    suggestion = _post_chat(messages, temperature=0.3)
    return _sanitize_chart_suggestion(suggestion)


def _sanitize_chart_suggestion(text: str) -> str:
    raw = str(text or "").strip()
    if not raw:
        return CHART_SUGGESTION_SAFE_FALLBACK

    normalized = raw.lower().replace(" ", "")
    if any(
        term.lower().replace(" ", "") in normalized
        for term in CHART_SUGGESTION_BANNED_TERMS
    ):
        return CHART_SUGGESTION_SAFE_FALLBACK
    return raw


def generate_custom_figure_code(
    summary: Dict[str, Any],
    user_prompt: str,
    previous_code: Optional[str] = None,
    chart_image_data_url: Optional[str] = None,
) -> str:
    vl_key, vl_base, vl_model = _resolve_vl_viz_config()
    enable_thinking: bool | None = None
    if _supports_enable_thinking(vl_model):
        # Default to instant mode for visualization generation speed.
        enable_thinking = _read_bool_env("VL_ENABLE_THINKING", default=False)

    if not vl_key:
        raise DeepSeekError("Visualization model API key not set (VL_API_KEY)")
    if _has_non_ascii(vl_key):
        raise DeepSeekError(
            "Visualization model API key appears invalid (contains non-ASCII chars). Please replace placeholder text with a real key."
        )

    compact_summary = _compact_custom_chart_summary(summary)
    compact_summary_text = json.dumps(
        compact_summary, ensure_ascii=False, separators=(",", ":")
    )
    compact_previous_code = _compact_previous_code_for_prompt(previous_code)

    prompt = (
        "You are a Python Plotly data visualization expert.\n"
        "The data summary below is intentionally compact for latency, but preserves the key schema and distribution signals.\n"
        "If any detail is missing, derive it from `df` inside code (e.g., df.dtypes, describe, value_counts) instead of guessing.\n"
        f"Data Summary (compact JSON): {compact_summary_text}\n"
        f"User request: {user_prompt}\n\n"
    )
    if compact_previous_code:
        prompt += (
            "Here is the PREVIOUS Python code we used to generate the chart. "
            "Please MODIFY this code to satisfy the user's new request, keeping all other good parts intact:\n"
            "```python\n"
            f"{compact_previous_code}\n"
            "```\n\n"
        )

    prompt += (
        "Write a complete Python code snippet containing a function named `make_custom_fig(df)`. "
        "The function should take a pandas DataFrame `df` as input, generate a very beautiful Plotly figure (either using plotly.express or plotly.graph_objects) EXACTLY matching the user's request (like 3D pie charts etc), and return the `fig` object.\n"
        "When an image snapshot of the current chart is provided, you MUST use it as the first-priority visual reference and modify the chart accordingly while preserving user's requested changes.\n"
        "IMPORTANT: User instruction has the highest priority. If the user asks to remove subplot/axis titles, DO NOT force titles. If generating multi-chart layouts/subplots, use enough `vertical_spacing` (>=0.15) and `horizontal_spacing` (>=0.1) to prevent overlap, and adjust `fig.update_layout(height=800)` or larger when needed.\n"
        "Do not include any explanation or markdown formatting like ```python, ONLY output valid raw Python code. Feel free to use 3D features, custom layouts, or anything Plotly supports. Make sure to import missing modules."
    )

    messages: list[dict[str, Any]] = [
        {
            "role": "system",
            "content": "You are a strict Python Plotly coding assistant. Always output only executable Python code.",
        }
    ]

    user_content: list[dict[str, Any]] = [{"type": "text", "text": prompt}]
    if chart_image_data_url:
        user_content.append(
            {"type": "image_url", "image_url": {"url": chart_image_data_url}}
        )

    messages.append({"role": "user", "content": user_content})

    code = _post_chat_raw(
        api_key=vl_key,
        base_url=vl_base,
        model=vl_model,
        messages=messages,
        temperature=0.1,
        enable_thinking=enable_thinking,
    )

    code = code.strip()
    if code.startswith("```python"):
        code = code[9:]
    elif code.startswith("```"):
        code = code[3:]
    if code.endswith("```"):
        code = code[:-3]
    return code.strip()


def generate_text_analysis(
    summary: Dict[str, Any],
    domain_hint: Optional[str] = None,
    user_prompt: Optional[str] = None,
) -> str:
    hint = domain_hint or "硒产业数据分析"
    prompt = (
        f"请基于以下数据摘要撰写一段300-500字的洞察分析，领域背景：{hint}。"
        "从趋势、结构、相关性、风险与机会四个角度给出要点，并指出还需补充的数据。\n\n"
        + (f"用户要求/期望：{user_prompt}\n\n" if user_prompt else "")
        + f"摘要: {summary}"
    )
    messages = [
        {"role": "system", "content": "你是资深硒产业行业分析师，擅长数据驱动洞察。"},
        {"role": "user", "content": prompt},
    ]
    return _post_chat(messages)


def generate_free_chat_reply(
    message: str,
    history: Optional[list[dict[str, str]]] = None,
    context_hint: Optional[str] = None,
    style_directive: Optional[str] = None,
    temperature: float = 0.4,
) -> str:
    """Generate a free-form chat reply with optional recent history."""
    messages: list[dict[str, str]] = [
        {
            "role": "system",
            "content": "你是硒产业智能助手。必须先直接回答用户问题，再展开说明；不得偏题。回答专业、条理清晰，优先基于用户给出的上下文。若证据不足，必须明确说明不确定点与原因，不得编造事实。不要自行输出“参考来源”小节，引用由系统统一附加。",
        }
    ]
    if style_directive:
        messages.append(
            {"role": "system", "content": f"回答风格约束：{style_directive}"}
        )
    if context_hint:
        messages.append({"role": "system", "content": f"上下文信息：{context_hint}"})

    safe_history = history or []
    for item in safe_history[-20:]:
        role = item.get("role", "user")
        content = item.get("content", "")
        if role not in {"user", "assistant"}:
            continue
        if not content:
            continue
        messages.append({"role": role, "content": content})

    # Re-assert style after history so previous turns don't flatten style consistency.
    if style_directive:
        messages.append(
            {"role": "system", "content": f"请严格遵循当前模式输出：{style_directive}"}
        )

    messages.append({"role": "user", "content": message})
    return _post_chat(messages, temperature=temperature)


def generate_free_chat_reply_stream(
    message: str,
    history: Optional[list[dict[str, str]]] = None,
    context_hint: Optional[str] = None,
    style_directive: Optional[str] = None,
    temperature: float = 0.4,
):
    messages = [
        {
            "role": "system",
            "content": "你是硒产业智能助手。必须先直接回答用户问题，再展开说明；不得偏题。回答专业、条理清晰，优先基于用户给出的上下文。若证据不足，必须明确说明不确定点与原因，不得编造事实。不要自行输出“参考来源”小节，引用由系统统一附加。",
        }
    ]
    if style_directive:
        messages.append(
            {"role": "system", "content": f"回答风格约束：{style_directive}"}
        )
    if context_hint:
        messages.append({"role": "system", "content": f"上下文信息：{context_hint}"})

    safe_history = history or []
    for item in safe_history[-20:]:
        role = item.get("role", "user")
        content = item.get("content", "")
        if role not in {"user", "assistant"}:
            continue
        if not content:
            continue
        messages.append({"role": role, "content": content})

    # Re-assert style after history so previous turns don't flatten style consistency.
    if style_directive:
        messages.append(
            {"role": "system", "content": f"请严格遵循当前模式输出：{style_directive}"}
        )

    messages.append({"role": "user", "content": message})
    for chunk in _post_chat_stream(messages, temperature=temperature):
        yield chunk
