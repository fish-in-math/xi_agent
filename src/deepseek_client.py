from __future__ import annotations

import os
from typing import Any, Dict, Optional

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
