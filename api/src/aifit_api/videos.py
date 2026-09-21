"""YouTube demo-video search: query building, ranking and a bounded in-process cache.

Pure transport helper for the browser surface: no model, prompt, persistence or
workspace access. The blocking provider call runs in a worker thread so the API
event loop never blocks on it.
"""

from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import time
from collections.abc import Iterable, Iterator, Sequence
from typing import Any

import httpx

from .workouts import StrictModel, WorkoutDomainError

logger = logging.getLogger("aifit.api.videos")

CACHE_TTL_SECONDS = 6 * 60 * 60
CACHE_MAX_ENTRIES = 200
MAX_QUERY_LENGTH = 200
MAX_LIMIT = 40
DEFAULT_LIMIT = 20

_VIDEO_CACHE: dict[str, dict[str, Any]] = {}

_STOP_TOKENS = frozenset({
    "a", "an", "the", "and", "or", "of", "for", "to", "with", "on", "in", "at",
    "vs", "via", "using", "how", "do", "does", "your", "my", "proper", "correct",
    "good", "best", "full", "complete", "left", "right", "each", "side", "sides",
    "per", "bilateral", "unilateral", "beginner", "advanced", "intermediate",
})

_QUERY_SCAFFOLD_TOKENS = frozenset({
    "exercise", "form", "technique", "tutorial", "demo", "demonstration",
    "howto", "guide", "workout", "video", "youtube",
})

_SESSION_ROLE_TOKENS = frozenset({
    "optional", "recommended", "extra", "addon", "bonus", "finisher", "warmup", "cooldown",
})

_NOISE_PHRASES = (
    "cool down",
    "cool-down",
    "warm up",
    "warm-up",
    "add on",
    "add-on",
    "per side",
    "each side",
    "left side",
    "right side",
)

_PHRASE_EXPANSIONS: tuple[tuple[tuple[str, ...], tuple[tuple[str, ...], ...]], ...] = (
    (("down", "dog"), (("downward", "dog"), ("downward", "facing", "dog"))),
    (("downward", "dog"), (("downward", "facing", "dog"), ("down", "dog"))),
    (("child", "s", "pose"), (("childs", "pose"), ("child", "pose"))),
    (("childs", "pose"), (("child", "s", "pose"), ("child", "pose"))),
    (("push", "up"), (("pushup",), ("push", "ups"))),
    (("pull", "up"), (("pullup",), ("pull", "ups"))),
    (("sit", "up"), (("situp",), ("sit", "ups"))),
    (("chin", "up"), (("chinup",), ("chin", "ups"))),
    (("hip", "hinge"), (("hinge", "pattern"),)),
    (("rdl",), (("romanian", "deadlift"),)),
    (("db",), (("dumbbell",),)),
    (("bb",), (("barbell",),)),
    (("kb",), (("kettlebell",),)),
)


class VideoSearchError(WorkoutDomainError):
    """A typed provider failure that maps to the public error contract."""

    def __init__(self, code: str, message: str, status_code: int = 502):
        super().__init__(code, message, status_code)


class VideoResult(StrictModel):
    video_id: str
    title: str
    duration_text: str
    duration_seconds: int | None
    thumbnail_url: str
    channel_title: str | None
    url: str


class VideoSearchResponse(StrictModel):
    query: str
    exact_match: bool
    videos: list[VideoResult]


def _cache_key(query: str, limit: int) -> str:
    return f"{limit}:{query.strip().lower()}"


def _prune_cache() -> None:
    if len(_VIDEO_CACHE) <= CACHE_MAX_ENTRIES:
        return
    ordered = sorted(_VIDEO_CACHE.items(), key=lambda item: item[1]["ts"], reverse=True)
    _VIDEO_CACHE.clear()
    for key, value in ordered[:CACHE_MAX_ENTRIES]:
        _VIDEO_CACHE[key] = value


def _get_cached_videos(query: str, limit: int) -> list[VideoResult] | None:
    entry = _VIDEO_CACHE.get(_cache_key(query, limit))
    if not entry:
        return None
    if time.time() - entry["ts"] > CACHE_TTL_SECONDS:
        _VIDEO_CACHE.pop(_cache_key(query, limit), None)
        return None
    return entry["videos"]


def _set_cached_videos(query: str, limit: int, videos: list[VideoResult]) -> None:
    _VIDEO_CACHE[_cache_key(query, limit)] = {"ts": time.time(), "videos": videos}
    _prune_cache()


def _normalize_video_text(value: str) -> str:
    cleaned = "".join(character.lower() if character.isalnum() else " " for character in value)
    return " ".join(cleaned.split())


def _tokenize(text: str) -> list[str]:
    return _normalize_video_text(text).split()


def _strip_noise_phrases(text: str) -> str:
    normalized = f" {_normalize_video_text(text)} "
    for phrase in _NOISE_PHRASES:
        normalized = normalized.replace(f" {phrase} ", " ")
    return " ".join(normalized.split())


def _is_noise_token(token: str) -> bool:
    if token in _STOP_TOKENS or token in _QUERY_SCAFFOLD_TOKENS or token in _SESSION_ROLE_TOKENS:
        return True
    if token.isdigit():
        return True
    return bool(re.fullmatch(r"\d+(s|sec|secs|min|mins|m|x)", token))


def _movement_tokens(name: str) -> list[str]:
    stripped = _strip_noise_phrases(name)
    return [token for token in _tokenize(stripped) if not _is_noise_token(token)]


def _dedupe_preserve(items: Iterable[str]) -> list[str]:
    seen: set[str] = set()
    output: list[str] = []
    for item in items:
        key = item.strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        output.append(item.strip())
    return output


def _join_tokens(tokens: Sequence[str]) -> str:
    return " ".join(tokens).strip()


def _expand_phrases(tokens: Sequence[str]) -> list[list[str]]:
    variants: list[list[str]] = [list(tokens)]
    token_tuple = tuple(tokens)
    for source, expansions in _PHRASE_EXPANSIONS:
        source_length = len(source)
        for index in range(0, max(0, len(token_tuple) - source_length + 1)):
            if token_tuple[index:index + source_length] != source:
                continue
            for expansion in expansions:
                variants.append(list(token_tuple[:index]) + list(expansion) + list(token_tuple[index + source_length:]))
    return variants


def build_video_search_queries(query: str, exercise_name: str | None = None, max_queries: int = 4) -> list[str]:
    """Build progressive YouTube queries from an exercise label.

    Prefers technique-preserving rewrites over generic fallbacks such as a bare
    "exercise" query.
    """
    seed = (exercise_name or query or "").strip()
    if not seed:
        return []

    seed_tokens = [
        token
        for token in _tokenize(_strip_noise_phrases(seed))
        if token not in _QUERY_SCAFFOLD_TOKENS
    ]
    movement = _movement_tokens(_join_tokens(seed_tokens) or seed)
    if not movement:
        movement = [token for token in seed_tokens if token not in _STOP_TOKENS] or seed_tokens

    phrase_variants: list[list[str]] = []
    seen_phrases: set[str] = set()
    for variant in _expand_phrases(movement):
        key = _join_tokens(variant)
        if not key or key in seen_phrases:
            continue
        seen_phrases.add(key)
        phrase_variants.append(list(variant))

    queries: list[str] = []

    def add(text: str) -> None:
        cleaned = " ".join(text.split())
        if cleaned:
            queries.append(cleaned)

    for tokens in phrase_variants[:2]:
        core = _join_tokens(tokens)
        if not core:
            continue
        add(f"{core} form")
        add(f"{core} technique")
        if len(tokens) >= 2:
            add(f"{core} tutorial")

    for tokens in phrase_variants[:2]:
        if len(tokens) < 3:
            continue
        add(f"{_join_tokens(tokens[:-1])} form")

    for tokens in phrase_variants[1:3]:
        core = _join_tokens(tokens)
        if core:
            add(f"{core} form")

    if movement:
        add(_join_tokens(movement))

    return _dedupe_preserve(queries)[:max_queries]


def _token_hit(token: str, title_tokens: set[str]) -> bool:
    if token in title_tokens:
        return True
    if token.endswith("s") and len(token) > 3 and token[:-1] in title_tokens:
        return True
    return f"{token}s" in title_tokens


def _title_negates_movement(title_norm: str, key_tokens: Sequence[str]) -> bool:
    """True when the title is about avoiding the movement (for example 'no downward dog')."""
    if " no " not in f" {title_norm} ":
        return False
    phrases = [" ".join(key_tokens)]
    if len(key_tokens) >= 2:
        phrases.append(" ".join(key_tokens[:2]))
    for source, expansions in _PHRASE_EXPANSIONS:
        if tuple(key_tokens[:len(source)]) == source:
            phrases.extend(" ".join(expansion) for expansion in expansions)
        for expansion in expansions:
            if len(key_tokens) >= len(expansion) and tuple(key_tokens[:len(expansion)]) == expansion:
                phrases.append(" ".join(source))
                phrases.extend(" ".join(item) for item in expansions)
    for phrase in _dedupe_preserve(phrases):
        if len(phrase) < 3:
            continue
        if re.search(rf"\bno\b.{{0,24}}\b{re.escape(phrase)}\b", title_norm):
            return True
    return False


def _score_tokens_against_title(title_norm: str, title_tokens: set[str], key_tokens: Sequence[str]) -> float:
    if not key_tokens:
        return 0.0
    hits = sum(1 for token in key_tokens if _token_hit(token, title_tokens))
    ratio = hits / max(len(key_tokens), 1)

    if len(key_tokens) >= 2:
        phrase = " ".join(key_tokens)
        if phrase in title_norm:
            ratio += 0.25
        else:
            bigram_hits = 0
            bigram_total = 0
            for index in range(len(key_tokens) - 1):
                bigram_total += 1
                if f"{key_tokens[index]} {key_tokens[index + 1]}" in title_norm:
                    bigram_hits += 1
            if bigram_total:
                ratio += 0.12 * (bigram_hits / bigram_total)

    if any(word in title_tokens for word in ("form", "technique", "tutorial", "how", "proper", "cues")):
        ratio += 0.08
    return ratio


def score_video_title(title: str, key_tokens: Sequence[str]) -> float:
    """Score how well a video title matches movement tokens."""
    if not key_tokens:
        return 0.0
    title_norm = _normalize_video_text(title)
    title_tokens = set(_tokenize(title_norm))
    if _title_negates_movement(title_norm, key_tokens):
        return 0.0
    candidates = [list(key_tokens)]
    candidates.extend(_expand_phrases(key_tokens))
    return max(
        _score_tokens_against_title(title_norm, title_tokens, variant)
        for variant in candidates
        if variant
    )


def _min_accept_score(key_tokens: Sequence[str]) -> float:
    count = len(key_tokens)
    if count <= 1:
        return 0.99
    if count == 2:
        return 0.5
    return max(0.4, math.ceil(count * 0.5) / count)


def _best_hit_count(title: str, key_tokens: Sequence[str]) -> int:
    title_norm = _normalize_video_text(title)
    title_tokens = set(_tokenize(title_norm))
    if _title_negates_movement(title_norm, key_tokens):
        return 0
    best = 0
    for variant in [list(key_tokens), *_expand_phrases(key_tokens)]:
        if not variant:
            continue
        hits = sum(1 for token in variant if _token_hit(token, title_tokens))
        if hits > best:
            best = hits
    return best


def rank_and_filter_videos(videos: Sequence[VideoResult], key_tokens: Sequence[str], limit: int) -> list[VideoResult]:
    if not videos:
        return []

    min_score = _min_accept_score(key_tokens)
    ranked: list[tuple[float, VideoResult]] = []
    for video in videos:
        score = score_video_title(video.title, key_tokens)
        if score < min_score:
            hits = _best_hit_count(video.title, key_tokens)
            if len(key_tokens) < 3 or hits < 2:
                continue
        ranked.append((score, video))

    ranked.sort(key=lambda item: item[0], reverse=True)
    deduped: list[VideoResult] = []
    seen_ids: set[str] = set()
    for _score, video in ranked:
        if video.video_id in seen_ids:
            continue
        seen_ids.add(video.video_id)
        deduped.append(video)
        if len(deduped) >= limit:
            break
    return deduped


def _duration_seconds(duration_text: str) -> int | None:
    parts = duration_text.strip().split(":")
    if not 1 < len(parts) <= 3 or any(not part.isdigit() for part in parts):
        return None
    seconds = 0
    for part in parts:
        seconds = seconds * 60 + int(part)
    return seconds


def _format_video(item: dict[str, Any]) -> VideoResult | None:
    video_id = item.get("id")
    title = item.get("title")
    if not isinstance(video_id, str) or not video_id or not isinstance(title, str) or not title:
        return None
    thumbnails = item.get("thumbnails")
    thumbnail_url = ""
    if isinstance(thumbnails, list) and thumbnails and isinstance(thumbnails[0], dict):
        candidate_url = thumbnails[0].get("url")
        if isinstance(candidate_url, str):
            thumbnail_url = candidate_url
    duration_text = item.get("duration") if isinstance(item.get("duration"), str) else ""
    channel = item.get("channel")
    channel_title = None
    if isinstance(channel, dict) and isinstance(channel.get("name"), str) and channel["name"]:
        channel_title = channel["name"]
    link = item.get("link")
    url = link if isinstance(link, str) and link else f"https://www.youtube.com/watch?v={video_id}"
    return VideoResult(
        video_id=video_id, title=title, duration_text=duration_text,
        duration_seconds=_duration_seconds(duration_text), thumbnail_url=thumbnail_url,
        channel_title=channel_title, url=url,
    )


_PROVIDER_TIMEOUT_SECONDS = 15.0
_PROVIDER_USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
_INITIAL_DATA_PATTERN = re.compile(r"ytInitialData\s*=\s*(\{.*?\})\s*;\s*</script>", re.S)


def _initial_data(html: str) -> dict[str, Any] | None:
    match = _INITIAL_DATA_PATTERN.search(html)
    if match is None:
        return None
    try:
        data = json.loads(match.group(1))
    except json.JSONDecodeError:
        return None
    return data if isinstance(data, dict) else None


def _iter_video_renderers(value: Any) -> Iterator[dict[str, Any]]:
    stack = [value]
    while stack:
        node = stack.pop()
        if isinstance(node, dict):
            renderer = node.get("videoRenderer")
            if isinstance(renderer, dict):
                yield renderer
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
        if len(stack) > 10_000:
            return


def _renderer_text(value: Any) -> str:
    if not isinstance(value, dict):
        return ""
    simple = value.get("simpleText")
    if isinstance(simple, str):
        return simple
    runs = value.get("runs")
    if isinstance(runs, list):
        return "".join(run.get("text", "") for run in runs if isinstance(run, dict) and isinstance(run.get("text"), str))
    return ""


def _video_renderer_item(renderer: dict[str, Any]) -> dict[str, Any] | None:
    video_id = renderer.get("videoId")
    title = _renderer_text(renderer.get("title"))
    if not isinstance(video_id, str) or not video_id or not title:
        return None
    thumbnail = renderer.get("thumbnail")
    thumbnails = thumbnail.get("thumbnails") if isinstance(thumbnail, dict) else None
    thumbnail_url = ""
    if isinstance(thumbnails, list):
        for candidate in reversed(thumbnails):
            if isinstance(candidate, dict) and isinstance(candidate.get("url"), str) and candidate["url"]:
                thumbnail_url = candidate["url"]
                break
    channel_title = _renderer_text(renderer.get("ownerText"))
    return {
        "id": video_id,
        "title": title,
        "duration": _renderer_text(renderer.get("lengthText")),
        "thumbnails": [{"url": thumbnail_url}] if thumbnail_url else [],
        "channel": {"name": channel_title} if channel_title else None,
        "link": f"https://www.youtube.com/watch?v={video_id}",
    }


def _provider_search(query: str, limit: int) -> list[VideoResult]:
    response = httpx.get(
        "https://www.youtube.com/results",
        params={"search_query": query, "hl": "en"},
        headers={
            "User-Agent": _PROVIDER_USER_AGENT,
            "Accept-Language": "en-US,en;q=0.9",
        },
        timeout=_PROVIDER_TIMEOUT_SECONDS,
        follow_redirects=True,
    )
    response.raise_for_status()
    data = _initial_data(response.text)
    if data is None:
        raise VideoSearchError("video_search_failed", "The video provider returned an unexpected page.")
    formatted: list[VideoResult] = []
    for renderer in _iter_video_renderers(data):
        item = _video_renderer_item(renderer)
        if item is None:
            continue
        video = _format_video(item)
        if video is not None:
            formatted.append(video)
        if len(formatted) >= limit:
            break
    return formatted


async def _raw_search(query: str, limit: int) -> list[VideoResult]:
    try:
        return await asyncio.to_thread(_provider_search, query, limit)
    except Exception as error:
        logger.warning("Video search failed for query %r: %s", query, error)
        raise VideoSearchError("video_search_failed", "The video provider did not answer the search.") from error


async def search_videos(query: str, limit: int = DEFAULT_LIMIT) -> dict[str, Any]:
    """Search YouTube through progressive technique queries with a bounded cache."""
    seed = query.strip()
    if not seed:
        raise VideoSearchError("video_search_invalid", "A search query is required.", 422)
    if len(seed) > MAX_QUERY_LENGTH:
        raise VideoSearchError("video_search_invalid", "The search query is too long.", 422)
    safe_limit = min(max(limit, 1), MAX_LIMIT)

    cached = _get_cached_videos(seed, safe_limit)
    if cached is not None:
        return VideoSearchResponse(query=seed, exact_match=bool(cached), videos=cached).model_dump(mode="json")

    key_tokens = _movement_tokens(seed)
    if not key_tokens:
        key_tokens = [token for token in _tokenize(seed) if token not in _QUERY_SCAFFOLD_TOKENS]

    variants = build_video_search_queries(seed)
    if not variants:
        variants = [seed]

    collected: list[VideoResult] = []
    seen_ids: set[str] = set()
    per_query_limit = max(safe_limit * 4, 12)

    for variant in variants:
        try:
            batch = await _raw_search(variant, per_query_limit)
        except VideoSearchError:
            if not collected:
                raise
            logger.warning("Video search stopped early after provider failure for query %r", variant)
            break
        for video in batch:
            if video.video_id in seen_ids:
                continue
            seen_ids.add(video.video_id)
            collected.append(video)
        ranked = rank_and_filter_videos(collected, key_tokens, limit=safe_limit)
        if len(ranked) >= safe_limit:
            _set_cached_videos(seed, safe_limit, ranked)
            return VideoSearchResponse(query=seed, exact_match=bool(ranked), videos=ranked).model_dump(mode="json")

    ranked = rank_and_filter_videos(collected, key_tokens, limit=safe_limit)
    if ranked:
        _set_cached_videos(seed, safe_limit, ranked)
    return VideoSearchResponse(query=seed, exact_match=bool(ranked), videos=ranked).model_dump(mode="json")
