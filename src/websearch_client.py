from __future__ import annotations

import json
import os
import re
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit

import requests
from dotenv import load_dotenv


class WebSearchError(Exception):
    pass


def _merge_json_payload(old: Any, new: Any) -> Any:
    if old is None:
        return new
    if new is None:
        return old

    if isinstance(old, dict) and isinstance(new, dict):
        merged: dict[str, Any] = dict(old)
        for key, value in new.items():
            if key in merged:
                merged[key] = _merge_json_payload(merged[key], value)
            else:
                merged[key] = value
        return merged

    if isinstance(old, list) and isinstance(new, list):
        if not new:
            return old
        if not old:
            return new
        if len(old) == len(new) and all(isinstance(x, dict) for x in old) and all(isinstance(x, dict) for x in new):
            return [_merge_json_payload(o, n) for o, n in zip(old, new)]
        return new if len(new) >= len(old) else old

    if isinstance(new, str) and new.strip() == "":
        return old
    return new


def _parse_websearch_response_payload(text: str) -> dict[str, Any]:
    raw = (text or "").strip()
    if not raw:
        raise WebSearchError("联网搜索返回为空")

    # 1) Standard JSON payload
    try:
        data = json.loads(raw)
        if isinstance(data, dict):
            return data
    except Exception:
        pass

    # 2) SSE-like payload lines: data:{...}
    candidates: list[str] = []
    for line in raw.splitlines():
        row = line.strip()
        if not row:
            continue
        if not row.startswith("data:"):
            continue
        payload = row[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        candidates.append(payload)

    # Fallback: if whole body starts with data:, parse after prefix
    if not candidates and raw.startswith("data:"):
        payload = raw[5:].strip()
        if payload and payload != "[DONE]":
            candidates.append(payload)

    parsed_events: list[dict[str, Any]] = []
    for payload in candidates:
        try:
            data = json.loads(payload)
            if isinstance(data, dict):
                parsed_events.append(data)
        except Exception:
            continue

    if parsed_events:
        merged: dict[str, Any] = {}
        for event in parsed_events:
            merged = _merge_json_payload(merged, event)
        return merged

    preview = raw[:300]
    raise WebSearchError(f"返回结果不是合法 JSON/SSE: {preview}")


def _get_env(name: str, default: str | None = None) -> str | None:
    value = os.getenv(name)
    if value is None or value == "":
        return default
    return value


def _get_config() -> dict[str, Any]:
    load_dotenv(override=False)

    api_key = _get_env("VOLC_WEBSEARCH_API_KEY", "")
    if not api_key:
        raise WebSearchError("VOLC_WEBSEARCH_API_KEY 未配置")

    timeout_raw = _get_env("VOLC_WEBSEARCH_TIMEOUT", "25") or "25"
    try:
        timeout = max(5, min(int(timeout_raw), 120))
    except Exception:
        timeout = 25

    return {
        "api_key": api_key,
        "url": _get_env("VOLC_WEBSEARCH_API_URL", "https://open.feedcoopapi.com/search_api/web_search")
        or "https://open.feedcoopapi.com/search_api/web_search",
        "search_type": _get_env("VOLC_WEBSEARCH_SEARCH_TYPE", "web_summary") or "web_summary",
        "timeout": timeout,
    }


def web_search(
    query_text: str,
    count: int = 3,
    search_type: str | None = None,
    timeout: int | None = None,
    need_content: bool | None = None,
) -> dict[str, Any]:
    text = (query_text or "").strip()
    if not text:
        raise WebSearchError("query 不能为空")

    cfg = _get_config()
    safe_count = max(1, min(int(count), 10))

    body: dict[str, Any] = {
        "Query": text,
        "SearchType": (search_type or cfg["search_type"]),
        "Count": safe_count,
        "Filter": {
            "NeedContent": bool(need_content) if need_content is not None else False,
            "NeedUrl": True,
        },
        "NeedSummary": True,
    }
    headers = {
        "Content-Type": "application/json",
        "Authorization": f"Bearer {cfg['api_key']}",
    }

    safe_timeout = cfg["timeout"]
    if timeout is not None:
        try:
            safe_timeout = max(5, min(int(timeout), 120))
        except Exception:
            safe_timeout = cfg["timeout"]

    resp = requests.post(
        cfg["url"],
        headers=headers,
        json=body,
        timeout=safe_timeout,
    )
    if resp.status_code != 200:
        raise WebSearchError(f"HTTP {resp.status_code}: {resp.text}")

    # The endpoint may not include charset; force UTF-8 to avoid garbled Chinese text.
    resp.encoding = "utf-8"
    return _parse_websearch_response_payload(resp.text)


def _collect_candidate_items(result: dict[str, Any]) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []

    def walk(node: Any):
        if isinstance(node, dict):
            has_candidate_fields = any(
                key in node
                for key in [
                    "Title", "title", "Url", "url", "URL", "Link", "link", "SourceUrl", "source_url",
                    "Summary", "summary", "Snippet", "snippet", "Content", "content",
                ]
            )
            if has_candidate_fields:
                items.append(node)
            for value in node.values():
                walk(value)
            return
        if isinstance(node, list):
            for value in node:
                walk(value)

    walk(result)
    return items


def _tokenize_relevance(text: str) -> set[str]:
    raw = re.sub(r"\s+", " ", str(text or "").strip().lower())
    if not raw:
        return set()

    tokens: set[str] = set(re.findall(r"[a-z0-9]{2,}", raw))
    for block in re.findall(r"[\u4e00-\u9fff]{2,}", raw):
        if len(block) <= 8:
            tokens.add(block)
        # Chinese bigrams improve matching when user question and result wording differ slightly.
        for idx in range(0, max(0, min(len(block) - 1, 14))):
            tokens.add(block[idx: idx + 2])

    return tokens


def _normalize_url(url: str) -> str:
    cleaned = str(url or "").strip()
    if not cleaned:
        return ""

    # Ensure URLs without scheme can still be parsed into host/path.
    raw_for_parse = cleaned if "://" in cleaned else f"https://{cleaned.lstrip('/')}"
    try:
        parsed = urlsplit(raw_for_parse)
    except Exception:
        return cleaned.rstrip("/").lower()

    host = (parsed.netloc or "").strip().lower()
    if host.startswith("www."):
        host = host[4:]

    path = re.sub(r"/{2,}", "/", parsed.path or "/")
    if path != "/" and path.endswith("/"):
        path = path.rstrip("/")

    tracking_prefixes = ("utm_", "spm", "from", "source", "ref", "fbclid", "gclid")
    tracking_exact = {
        "si",
        "sessionid",
        "session_id",
        "timestamp",
        "ts",
        "_t",
    }
    query_pairs = []
    for key, value in parse_qsl(parsed.query, keep_blank_values=False):
        key_lower = key.strip().lower()
        if not key_lower:
            continue
        if key_lower in tracking_exact:
            continue
        if any(key_lower.startswith(prefix) for prefix in tracking_prefixes):
            continue
        query_pairs.append((key_lower, value.strip()))

    query_pairs.sort()
    query = urlencode(query_pairs, doseq=True)

    canonical = f"{host}{path}" if host else path
    return f"{canonical}?{query}" if query else canonical


def _item_relevance_score(item: dict[str, Any], query_tokens: set[str]) -> float:
    if not query_tokens:
        return 0.0

    title = str(item.get("Title") or item.get("title") or "")
    summary = str(
        item.get("Summary")
        or item.get("summary")
        or item.get("Snippet")
        or item.get("snippet")
        or item.get("Content")
        or item.get("content")
        or ""
    )

    title_tokens = _tokenize_relevance(title)
    summary_tokens = _tokenize_relevance(summary)
    title_hits = len(query_tokens & title_tokens)
    summary_hits = len(query_tokens & summary_tokens)

    score = (title_hits * 3.0) + (summary_hits * 1.2)
    if title:
        score += 0.2
    if summary:
        score += 0.2
    return score


def _sort_candidates_by_relevance(candidates: list[dict[str, Any]], query_text: str | None) -> list[dict[str, Any]]:
    query_tokens = _tokenize_relevance(query_text or "")
    if not query_tokens:
        return candidates

    indexed = list(enumerate(candidates))
    indexed.sort(
        key=lambda pair: (_item_relevance_score(pair[1], query_tokens), -pair[0]),
        reverse=True,
    )
    return [item for _, item in indexed]


def format_web_search_context(result: dict[str, Any], max_items: int = 5, query_text: str | None = None) -> str:
    items = _sort_candidates_by_relevance(_collect_candidate_items(result), query_text)

    lines: list[str] = []
    seen: set[str] = set()
    seen_urls: set[str] = set()
    for item in items:
        title = str(item.get("Title") or item.get("title") or "").strip()
        url = str(
            item.get("Url")
            or item.get("url")
            or item.get("URL")
            or item.get("Link")
            or item.get("link")
            or item.get("SourceUrl")
            or item.get("source_url")
            or ""
        ).strip()
        summary = str(
            item.get("Summary")
            or item.get("summary")
            or item.get("Snippet")
            or item.get("snippet")
            or item.get("Content")
            or item.get("content")
            or ""
        ).strip()
        if len(summary) > 220:
            summary = summary[:220].rstrip() + "..."
        normalized_url = _normalize_url(url)
        if normalized_url and normalized_url in seen_urls:
            continue

        fingerprint = f"{title}|{normalized_url}|{summary[:120]}"
        if not (title or url or summary):
            continue
        if fingerprint in seen:
            continue
        seen.add(fingerprint)
        if normalized_url:
            seen_urls.add(normalized_url)

        block = []
        if title:
            block.append(f"标题: {title}")
        if summary:
            block.append(f"摘要: {summary}")
        if url:
            block.append(f"链接: {url}")
        lines.append("；".join(block))
        if len(lines) >= max_items:
            break

    if lines:
        return "\n".join(f"{idx + 1}. {line}" for idx, line in enumerate(lines))

    fallback = json.dumps(result, ensure_ascii=False)
    if len(fallback) > 2000:
        fallback = fallback[:2000] + "..."
    return fallback


def extract_web_search_sources(result: dict[str, Any], max_items: int = 5, query_text: str | None = None) -> list[dict[str, str]]:
    candidates = _sort_candidates_by_relevance(_collect_candidate_items(result), query_text)

    sources: list[dict[str, str]] = []
    seen: set[str] = set()
    for item in candidates:
        title = str(item.get("Title") or item.get("title") or "").strip()
        url = str(
            item.get("Url")
            or item.get("url")
            or item.get("URL")
            or item.get("Link")
            or item.get("link")
            or item.get("SourceUrl")
            or item.get("source_url")
            or ""
        ).strip()
        if not url:
            continue

        normalized_url = _normalize_url(url)
        dedupe_key = normalized_url or f"{title}|{url}"
        if dedupe_key in seen:
            continue
        seen.add(dedupe_key)

        sources.append(
            {
                "title": title or url,
                "url": url,
            }
        )
        if len(sources) >= max_items:
            break

    return sources


def build_web_search_citations_markdown(sources: list[dict[str, str]]) -> str:
    if not sources:
        return ""

    lines = ["参考来源："]
    for idx, source in enumerate(sources, start=1):
        title = source.get("title", "").strip().replace("[", "\\[").replace("]", "\\]")
        url = source.get("url", "").strip()
        if not url:
            continue
        lines.append(f"{idx}. [{title}]({url})")

    if len(lines) == 1:
        return ""
    return "\n".join(lines)