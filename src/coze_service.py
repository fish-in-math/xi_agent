from __future__ import annotations

import sys
from typing import Any, Dict

from dotenv import load_dotenv
from cozepy import Coze, TokenAuth, Message, COZE_CN_BASE_URL, ChatEventType


def _get_env(name: str, default: str | None = None) -> str | None:
    import os

    val = os.getenv(name)
    return val if val else default


def _init_coze() -> Coze:
    load_dotenv(override=False)
    token = _get_env("COZE_API_TOKEN")
    if not token:
        raise RuntimeError("COZE_API_TOKEN not set")
    base = _get_env("COZE_API_BASE", COZE_CN_BASE_URL)
    return Coze(auth=TokenAuth(token), base_url=base)


def generate_industry_report(summary: Dict[str, Any], extra_instruction: str | None = None) -> str:
    coze = _init_coze()
    bot_id = _get_env("COZE_BOT_ID")
    if not bot_id:
        raise RuntimeError("COZE_BOT_ID not set")
    user_id = _get_env("COZE_USER_ID") or _get_env("COZE_DEFAULT_USER_ID", "local_user")

    system_prompt = (
        "你是硒产业研究智能体。请基于输入的数据摘要撰写结构化行业报告，"
        "包含: 背景与方法、核心发现(趋势/结构/相关性)、区域与人群差异、供需与价格、风险与建议、下一步数据需求。"
    )
    content = f"{system_prompt}\n\n" + (f"用户要求/期望：{extra_instruction}\n\n" if extra_instruction else "") + f"数据摘要: {summary}"
    messages = [
        Message.build_user_question_text(content),
    ]

    # Use streaming API to reliably capture assistant output across SDK versions
    full_text: list[str] = []
    for event in coze.chat.stream(
        bot_id=bot_id,
        user_id=user_id,
        additional_messages=messages,
    ):
        if event.event == ChatEventType.CONVERSATION_MESSAGE_DELTA:
            if event.message and event.message.content:
                full_text.append(event.message.content)
        elif event.event == ChatEventType.CONVERSATION_CHAT_COMPLETED:
            break
    return "".join(full_text) or "(No content)"
