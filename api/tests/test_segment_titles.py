from copy import deepcopy

import pytest
from pydantic import ValidationError

from aifit_api.workouts import BlueprintInput, GenerateInput, Segment, WorkoutOverrideInput, WorkoutService

from test_workout_contract import blueprint
from test_workout_partial_progress import override_segments
from test_workout_transactions import FakeDatabase


def test_legacy_title_less_segment_still_validates():
    value = deepcopy(blueprint()["days"][0]["segments"][0])
    value.pop("title")
    segment = Segment(**value)
    assert segment.title is None


def test_blueprint_training_day_rejects_untitled_segments():
    value = deepcopy(blueprint())
    del value["days"][0]["segments"][0]["title"]
    with pytest.raises(ValidationError, match="segments need titles"):
        BlueprintInput(**value)


def test_blueprint_rest_day_ignores_segment_titles():
    value = deepcopy(blueprint())
    value["days"][0]["kind"] = "rest"
    value["days"][0]["segments"] = []
    assert BlueprintInput(**value).days[0].segments == []


def test_override_rejects_untitled_segments():
    value = {
        "date": "2026-09-21",
        "title": "Upper A (busy gym)",
        "reason_md": "Machine occupied.",
        "segments": override_segments(),
        "request_id": "override-titles-001",
    }
    assert WorkoutOverrideInput(**value).segments[0].title == "Press Main"
    untitled = deepcopy(value)
    del untitled["segments"][0]["title"]
    with pytest.raises(ValidationError, match="segments need titles"):
        WorkoutOverrideInput(**untitled)


@pytest.mark.asyncio
async def test_generate_copies_blueprint_segment_titles():
    database = FakeDatabase()
    service = WorkoutService(database)
    published = await service.solidify_blueprint(
        "acc_one",
        BlueprintInput(**blueprint()),
        None,
        "solidify-titles-001",
        {"kind": "agent", "job_id": "job_one"},
    )
    assert published["status"] == "saved"
    generated = await service.generate(
        "acc_one",
        GenerateInput(date="2026-09-21", request_id="generate-titles-001"),
    )
    assert generated["workout"]["segments"][0]["title"] == "Pull Main"
