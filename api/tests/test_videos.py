from typing import Any

import pytest

from aifit_api import main, videos
from aifit_api.auth import Identity
from aifit_api.videos import (
    VideoSearchError,
    _duration_seconds,
    _format_video,
    _movement_tokens,
    _video_renderer_item,
    build_video_search_queries,
    rank_and_filter_videos,
    score_video_title,
)

SEARCH_ITEMS: list[dict[str, Any]] = [
    {
        "id": "video_row_machine",
        "title": "Chest Supported Machine Row | Form tutorial",
        "duration": "6:12",
        "thumbnails": [{"url": "https://i.ytimg.com/vi/video_row_machine/hqdefault.jpg"}],
        "channel": {"name": "Technique Lab"},
        "link": "https://www.youtube.com/watch?v=video_row_machine",
    },
    {
        "id": "video_row_standing",
        "title": "How to do a Cable Row with perfect technique",
        "duration": "1:02:03",
        "thumbnails": [{"url": "https://i.ytimg.com/vi/video_row_standing/hqdefault.jpg"}],
        "channel": {"name": "Coach Row"},
        "link": "https://www.youtube.com/watch?v=video_row_standing",
    },
    {
        "id": "video_unrelated",
        "title": "Treadmill walking workout for beginners",
        "duration": "20:00",
        "thumbnails": [{"url": "https://i.ytimg.com/vi/video_unrelated/hqdefault.jpg"}],
        "channel": {"name": "Cardio"},
        "link": "https://www.youtube.com/watch?v=video_unrelated",
    },
]


class FakeProvider:
    queries: list[str] = []
    last_limit: int | None = None
    fail: bool = False

    def __call__(self, query: str, limit: int) -> list[videos.VideoResult]:
        type(self).queries.append(query)
        type(self).last_limit = limit
        if type(self).fail:
            raise RuntimeError("provider offline")
        formatted = [_format_video(dict(item)) for item in SEARCH_ITEMS]
        return [video for video in formatted if video is not None]


@pytest.fixture(autouse=True)
def clear_video_cache():
    videos._VIDEO_CACHE.clear()
    FakeProvider.queries = []
    FakeProvider.fail = False
    yield
    videos._VIDEO_CACHE.clear()
    FakeProvider.queries = []
    FakeProvider.fail = False


def test_video_renderer_item_maps_provider_payload():
    renderer = {
        "videoId": "abc123",
        "title": {"runs": [{"text": "How to Bench Press"}, {"text": " | Technique"}]},
        "lengthText": {"simpleText": "8:05"},
        "thumbnail": {"thumbnails": [
            {"url": "https://i.ytimg.com/vi/abc123/default.jpg"},
            {"url": "https://i.ytimg.com/vi/abc123/hqdefault.jpg"},
        ]},
        "ownerText": {"runs": [{"text": "Technique Lab"}]},
    }
    item = _video_renderer_item(renderer)
    assert item is not None
    assert item["id"] == "abc123"
    assert item["title"] == "How to Bench Press | Technique"
    assert item["duration"] == "8:05"
    assert item["thumbnails"][0]["url"] == "https://i.ytimg.com/vi/abc123/hqdefault.jpg"
    assert item["channel"]["name"] == "Technique Lab"
    assert item["link"] == "https://www.youtube.com/watch?v=abc123"
    assert _video_renderer_item({"title": {"simpleText": "No id"}}) is None
    assert _video_renderer_item({"videoId": "no-title"}) is None


def test_movement_tokens_strip_plan_fluff_and_scaffolding():
    assert _movement_tokens("optional down dog yin cooldown") == ["down", "dog", "yin"]
    assert _movement_tokens("machine row exercise form") == ["machine", "row"]


def test_build_queries_prefer_technique_queries_not_generic_fallbacks():
    queries = build_video_search_queries("optional down dog yin cooldown")
    joined = " | ".join(queries).lower()
    assert "down dog yin form" in joined
    assert any("technique" in query or "tutorial" in query or "form" in query for query in queries)
    assert not any(query.strip().lower() in {"exercise", "form", "yoga"} for query in queries)
    assert not any("optional" in query.lower() or "cooldown" in query.lower() for query in queries)


def test_score_prefers_matching_titles_and_penalizes_negations():
    keys = ["down", "dog", "yin"]
    good = score_video_title("How to do Downward Dog | Yoga form tutorial", keys)
    bad = score_video_title("10 min HANDS FREE Morning Yoga (no downward dog or plank)", keys)
    assert good > bad
    assert bad == 0.0


def test_rank_filters_irrelevant_videos_and_keeps_movement_hits():
    videos_input = [
        _format_video({"id": "1", "title": "10 min HANDS FREE Morning Yoga (no downward dog or plank)"}),
        _format_video({"id": "2", "title": "How to Perfect Your Downward Dog Form"}),
        _format_video({"id": "3", "title": "20 minute Yoga for Runners COOL DOWN"}),
        _format_video({"id": "4", "title": "Yin Yoga Downward Dog variation technique"}),
    ]
    ranked = rank_and_filter_videos([video for video in videos_input if video], ["down", "dog", "yin"], limit=3)
    ids = [video.video_id for video in ranked]
    assert "2" in ids
    assert "4" in ids
    assert "1" not in ids
    assert "3" not in ids


def test_format_video_maps_only_real_provider_fields():
    formatted = _format_video(SEARCH_ITEMS[0])
    assert formatted is not None
    assert formatted.video_id == "video_row_machine"
    assert formatted.duration_text == "6:12"
    assert formatted.duration_seconds == 372
    assert formatted.channel_title == "Technique Lab"
    assert formatted.url == "https://www.youtube.com/watch?v=video_row_machine"
    minimal = _format_video({"id": "bare", "title": "Bare video"})
    assert minimal is not None
    assert minimal.thumbnail_url == ""
    assert minimal.channel_title is None
    assert minimal.duration_text == ""
    assert minimal.duration_seconds is None
    assert minimal.url == "https://www.youtube.com/watch?v=bare"
    assert _format_video({"title": "No id"}) is None
    assert _format_video({"id": "no-title"}) is None


def test_duration_seconds_parses_clock_text():
    assert _duration_seconds("12:34") == 754
    assert _duration_seconds("1:02:03") == 3723
    assert _duration_seconds("LIVE") is None
    assert _duration_seconds("") is None


@pytest.mark.asyncio
async def test_search_videos_ranks_provider_results_and_caches_hits(monkeypatch):
    monkeypatch.setattr(videos, "_provider_search", FakeProvider())

    first = await videos.search_videos("machine row", limit=5)
    assert first["query"] == "machine row"
    assert first["exact_match"] is True
    video_ids = [video["video_id"] for video in first["videos"]]
    assert video_ids[0] == "video_row_machine"
    assert "video_unrelated" not in video_ids
    assert first["videos"][0]["duration_seconds"] == 372
    assert FakeProvider.last_limit == 20

    calls_after_first = list(FakeProvider.queries)
    second = await videos.search_videos("machine row", limit=5)
    assert second == first
    assert FakeProvider.queries == calls_after_first


@pytest.mark.asyncio
async def test_search_videos_surfaces_a_typed_provider_failure(monkeypatch):
    monkeypatch.setattr(videos, "_provider_search", FakeProvider())
    FakeProvider.fail = True

    with pytest.raises(VideoSearchError) as error:
        await videos.search_videos("machine row", limit=5)

    assert error.value.code == "video_search_failed"
    assert error.value.status_code == 502


@pytest.mark.asyncio
async def test_search_videos_requires_a_query():
    with pytest.raises(VideoSearchError) as error:
        await videos.search_videos("   ", limit=5)
    assert error.value.code == "video_search_invalid"
    assert error.value.status_code == 422


@pytest.mark.asyncio
async def test_v1_video_route_uses_browser_identity_and_returns_the_typed_payload(monkeypatch):
    monkeypatch.setattr(videos, "_provider_search", FakeProvider())
    monkeypatch.setattr(main, "browser_account", lambda _identity: async_value({"account_id": "acc_one"}))

    payload = await main.search_videos_v1("machine row", 5, Identity(subject="did:privy:test", email="test@example.com"))

    assert payload["query"] == "machine row"
    assert payload["exact_match"] is True
    assert set(payload["videos"][0]) == {
        "video_id", "title", "duration_text", "duration_seconds", "thumbnail_url", "channel_title", "url",
    }
    assert "video_unrelated" not in [video["video_id"] for video in payload["videos"]]


async def async_value(value: Any) -> Any:
    return value
