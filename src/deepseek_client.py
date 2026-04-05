from __future__ import annotations

import os
from typing import Any, Dict, Optional

import json

import requests
from dotenv import load_dotenv


class DeepSeekError(Exception):
    pass


def _post_chat(messages: list[dict], temperature: float = 0.2) -> str:
    # Load .env (non-invasive) and fetch runtime env vars so changes take effect without server restart
    load_dotenv(override=False)
    key = os.getenv("DEEPSEEK_API_KEY")
    base = os.getenv("DEEPSEEK_API_BASE", "https://api.deepseek.com/v1")
    model = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")

    if not key:
        raise DeepSeekError("DEEPSEEK_API_KEY not set in environment")
    url = f"{base}/chat/completions"
    headers = {
        "Authorization": f"Bearer {key}",
        "Content-Type": "application/json",
    }
    body = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
    }
    resp = requests.post(url, json=body, headers=headers, timeout=60)
    if resp.status_code != 200:
        raise DeepSeekError(f"HTTP {resp.status_code}: {resp.text}")
    data = resp.json()
    try:
        return data["choices"][0]["message"]["content"]
    except Exception as e:
        raise DeepSeekError(f"Unexpected response: {data}") from e


def _post_chat_stream(messages: list[dict], temperature: float = 0.2):
    load_dotenv(override=False)
    key = os.getenv("DEEPSEEK_API_KEY")
    base = os.getenv("DEEPSEEK_API_BASE", "https://api.deepseek.com/v1")
    model = os.getenv("DEEPSEEK_MODEL", "deepseek-chat")

    if not key:
        yield "[Error] DEEPSEEK_API_KEY not set in environment"
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
        "stream": True
    }
    
    try:
        with requests.post(url, json=body, headers=headers, timeout=60, stream=True) as resp:
            if resp.status_code != 200:
                yield f"[Error] HTTP {resp.status_code}: {resp.text}"
                return
            for line in resp.iter_lines():
                if line:
                    decoded_line = line.decode('utf-8')
                    if decoded_line.startswith('data: '):
                        data_str = decoded_line[6:]
                        if data_str == '[DONE]':
                            break
                        try:
                            data_json = json.loads(data_str)
                            if 'choices' in data_json and len(data_json['choices']) > 0:
                                delta = data_json['choices'][0].get('delta', {})
                                if 'content' in delta:
                                    yield delta['content']
                        except Exception:
                            pass
    except Exception as e:
        yield f"[Error] {e}"


def generate_chart_suggestions(summary: Dict[str, Any], user_prompt: Optional[str] = None) -> str:
    prompt = (
        "你是数据可视化专家。基于以下数据摘要（列名、数值列描述、类别分布），"
        "请用要点列出3-5个最有洞察力的可视化图表建议，每条包含图表类型、使用的列、分析目的。\n\n"
        + (f"用户要求/期望：{user_prompt}\n\n" if user_prompt else "")
        + f"摘要: {summary}"
    )
    messages = [
        {"role": "system", "content": "你是资深数据分析与可视化顾问。"},
        {"role": "user", "content": prompt},
    ]
    return _post_chat(messages)


def generate_custom_figure_code(summary: Dict[str, Any], user_prompt: str) -> str:
    prompt = (
        f"You are a Python Plotly data visualization expert.\n"
        f"Data Summary: {summary}\n"
        f"User request: {user_prompt}\n\n"
        "Write a complete Python code snippet containing a function named `make_custom_fig(df)`. "
        "The function should take a pandas DataFrame `df` as input, generate a very beautiful Plotly figure (either using plotly.express or plotly.graph_objects) EXACTLY matching the user's request (like 3D pie charts etc), and return the `fig` object.\n"
        "IMPORTANT: If generating multi-chart layouts/subplots, explicitly use larger `vertical_spacing` (>=0.15) and `horizontal_spacing` (>=0.1) in `make_subplots` to prevent titles from overlapping, and adjust `fig.update_layout(height=800)` or larger. You MUST ensure EVERY subplot has a clear visible title (use the `subplot_titles` argument in `make_subplots()`, or add annotations for pie charts). Subplots without individual titles are not allowed.\n"      
        "Do not include any explanation or markdown formatting like ```python, ONLY output valid raw Python code. Feel free to use 3D features, custom layouts, or anything Plotly supports. Make sure to import missing modules."
    )
    messages = [{"role": "system", "content": prompt}]
    code = _post_chat(messages, temperature=0.1)
    
    code = code.strip()
    if code.startswith("```python"):
        code = code[9:]
    elif code.startswith("```"):
        code = code[3:]
    if code.endswith("```"):
        code = code[:-3]
    return code.strip()


def generate_text_analysis(summary: Dict[str, Any], domain_hint: Optional[str] = None, user_prompt: Optional[str] = None) -> str:
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
        messages.append({"role": "system", "content": f"回答风格约束：{style_directive}"})
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
        messages.append({"role": "system", "content": f"请严格遵循当前模式输出：{style_directive}"})

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
        messages.append({"role": "system", "content": f"回答风格约束：{style_directive}"})
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
        messages.append({"role": "system", "content": f"请严格遵循当前模式输出：{style_directive}"})

    messages.append({"role": "user", "content": message})
    for chunk in _post_chat_stream(messages, temperature=temperature):
        yield chunk
