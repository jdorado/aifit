"""End-state workout domain: typed records, releases, generation and history.

The module deliberately knows nothing about FastAPI or Ez. Browser and agent routes
call the same service so neither transport can create a second workout contract.
"""

from __future__ import annotations

from collections import Counter, defaultdict
from contextvars import ContextVar
from copy import deepcopy
from datetime import UTC, datetime, timedelta
from functools import wraps
from hashlib import sha256
from re import escape as regex_escape
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pymongo import ASCENDING, DESCENDING, ReturnDocument
from pymongo.errors import DuplicateKeyError, OperationFailure

from .progression import analyze_exercise, progression_context, summarize_muscles


SCHEMA_VERSION = 1
SEGMENT_KINDS = {"warmup", "straight_sets", "superset", "circuit", "interval", "mobility", "cooldown"}
LOAD_BASES = {"total", "per_side", "per_hand", "machine_stack", "bodyweight", "assisted", "band_level"}
LineageSource = Literal["default", "jev", "agent_override", "copy_last_week", "legacy_import"]


class WorkoutDomainError(ValueError):
    """A validated domain error that maps cleanly to a client response."""

    def __init__(self, code: str, message: str, status_code: int = 409):
        super().__init__(message)
        self.code = code
        self.message = message
        self.status_code = status_code


def utc_now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def new_id(prefix: str) -> str:
    return f"{prefix}_{uuid4().hex}"


def new_revision() -> str:
    return new_id("rev")


def _fingerprint(value: Any) -> str:
    import json

    return sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


class StrictModel(BaseModel):
    model_config = ConfigDict(extra="forbid", str_strip_whitespace=True, strict=True)


class Quantity(StrictModel):
    value: float = Field(ge=0, le=100_000)
    unit: Literal["kg", "lb"]


class IntRange(StrictModel):
    min: int = Field(ge=0, le=10_000)
    max: int = Field(ge=0, le=10_000)

    @model_validator(mode="after")
    def ordered(self) -> "IntRange":
        if self.min > self.max:
            raise ValueError("range min must not exceed max")
        return self


class NumberRange(StrictModel):
    min: float = Field(ge=0, le=100_000)
    max: float = Field(ge=0, le=100_000)

    @model_validator(mode="after")
    def ordered(self) -> "NumberRange":
        if self.min > self.max:
            raise ValueError("range min must not exceed max")
        return self


class Target(StrictModel):
    reps: IntRange | None = None
    duration_seconds: IntRange | None = None
    load: Quantity | None = None
    rpe: NumberRange | None = None

    @model_validator(mode="after")
    def one_metric(self) -> "Target":
        if (self.reps is None) == (self.duration_seconds is None):
            raise ValueError("target needs exactly one of reps or duration_seconds")
        return self


class Tempo(StrictModel):
    eccentric_seconds: int = Field(ge=0, le=60)
    pause_seconds: int = Field(ge=0, le=60)
    concentric_seconds: int = Field(ge=0, le=60)


class ProgressionWhen(StrictModel):
    completed_reps_at_or_above: int = Field(ge=0, le=10_000)
    max_rpe: float = Field(ge=0, le=10)


class Progression(StrictModel):
    kind: Literal["none", "double_progression"] = "none"
    increase_when: ProgressionWhen | None = None
    increment: Quantity | None = None
    load_range: list[Quantity] | None = Field(default=None, min_length=2, max_length=2)
    required_sessions: int = Field(default=1, ge=1, le=5)
    goal: str | None = Field(default=None, min_length=1, max_length=500)
    phase: Literal["build", "maintain", "deload"] = "build"
    review_after_exposures: int | None = Field(default=None, ge=1, le=30)
    plateau_after_exposures: int | None = Field(default=None, ge=3, le=20)
    review_by: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")

    @model_validator(mode="after")
    def valid_policy(self) -> "Progression":
        if self.review_by is not None:
            datetime.strptime(self.review_by, "%Y-%m-%d")
        if self.kind == "none":
            if any(value is not None for value in (self.increase_when, self.increment, self.load_range)):
                raise ValueError("progression kind none cannot define load progression fields")
            return self
        if self.increase_when is None or self.increment is None or self.load_range is None:
            raise ValueError("double_progression requires increase_when, increment and load_range")
        lower, upper = self.load_range
        if lower.unit != upper.unit or lower.unit != self.increment.unit or lower.value > upper.value:
            raise ValueError("progression quantities must use one ordered unit")
        if self.increment.value <= 0:
            raise ValueError("progression increment must be positive")
        return self


class ExerciseDefinitionInput(StrictModel):
    exercise_id: str = Field(pattern=r"^ex_[a-z0-9_]{3,120}$")
    name: str = Field(min_length=1, max_length=180)
    movement_pattern: str = Field(min_length=1, max_length=80)
    primary_muscles: list[str] = Field(min_length=1, max_length=8)
    secondary_muscles: list[str] = Field(default_factory=list, max_length=12)
    equipment_kind: str = Field(min_length=1, max_length=80)
    laterality: Literal["bilateral", "unilateral", "alternating"]
    load_basis: Literal["total", "per_side", "per_hand", "machine_stack", "bodyweight", "assisted", "band_level"]
    metrics: list[Literal["reps", "duration_seconds"]] = Field(min_length=1, max_length=2)
    instructions_md: str = Field(min_length=1, max_length=12_000)


class CandidatePrescription(StrictModel):
    metric: Literal["reps", "duration_seconds"]
    target: Target
    round_targets: list[Target] | None = Field(default=None, max_length=10)
    rest_seconds: int = Field(default=0, ge=0, le=3_600)
    tempo: Tempo | None = None

    @model_validator(mode="after")
    def target_matches_metric(self) -> "CandidatePrescription":
        if self.metric == "reps" and self.target.reps is None:
            raise ValueError("reps prescriptions need a reps target")
        if self.metric == "duration_seconds" and self.target.duration_seconds is None:
            raise ValueError("duration prescriptions need a duration target")
        if self.round_targets:
            for target in self.round_targets:
                if self.metric == "reps" and target.reps is None:
                    raise ValueError("round target metric differs from prescription")
                if self.metric == "duration_seconds" and target.duration_seconds is None:
                    raise ValueError("round target metric differs from prescription")
        return self


class Candidate(StrictModel):
    candidate_id: str = Field(pattern=r"^cand_[a-z0-9_]{3,120}$")
    exercise_id: str = Field(pattern=r"^ex_[a-z0-9_]{3,120}$")
    exercise_revision: str = Field(pattern=r"^rev_[a-f0-9]{32}$")
    priority: int = Field(ge=1, le=999)
    rationale_md: str = Field(min_length=1, max_length=8_000)
    equipment_profile_id: str | None = Field(default=None, pattern=r"^eqp_[a-z0-9_]{3,120}$")
    prescription: CandidatePrescription
    progression: Progression = Field(default_factory=Progression)

    @model_validator(mode="after")
    def progression_matches_prescription(self) -> "Candidate":
        if self.progression.kind == "double_progression":
            targets = self.prescription.round_targets or [self.prescription.target]
            lower, upper = self.progression.load_range
            if self.prescription.metric != "reps":
                raise ValueError("double progression requires a reps prescription")
            for target in targets:
                if target.load is None or target.load.unit != lower.unit or not lower.value <= target.load.value <= upper.value:
                    raise ValueError("progression target must be within its load range and unit")
                if self.progression.increase_when.completed_reps_at_or_above < target.reps.max:
                    raise ValueError("progression threshold must cover the top of the rep range")
            if len({target.load.value for target in targets}) != 1:
                raise ValueError("double progression requires the same load for all work sets")
        return self


class Slot(StrictModel):
    slot_id: str = Field(pattern=r"^slot_[a-z0-9_]{3,120}$")
    order: int = Field(ge=1, le=100)
    role: str = Field(min_length=1, max_length=100)
    selection_count: int = Field(default=1, ge=1, le=4)
    candidates: list[Candidate] = Field(min_length=1, max_length=24)

    @model_validator(mode="after")
    def enough_distinct_candidates(self) -> "Slot":
        ids = [candidate.candidate_id for candidate in self.candidates]
        exercise_ids = [candidate.exercise_id for candidate in self.candidates]
        if len(ids) != len(set(ids)) or len(exercise_ids) != len(set(exercise_ids)):
            raise ValueError("slot candidates must have unique candidate and exercise IDs")
        if len(self.candidates) < self.selection_count:
            raise ValueError("slot has fewer candidates than selection_count")
        return self


class Segment(StrictModel):
    segment_id: str = Field(pattern=r"^seg_[a-z0-9_]{3,120}$")
    order: int = Field(ge=1, le=100)
    kind: Literal["warmup", "straight_sets", "superset", "circuit", "interval", "mobility", "cooldown"]
    title: str | None = Field(default=None, min_length=1, max_length=80)
    rounds: int = Field(ge=1, le=10)
    rest_after_round_seconds: int = Field(default=0, ge=0, le=3_600)
    slots: list[Slot] = Field(min_length=1, max_length=12)

    @model_validator(mode="after")
    def rounds_match_targets(self) -> "Segment":
        ids = [slot.slot_id for slot in self.slots]
        orders = [slot.order for slot in self.slots]
        if len(ids) != len(set(ids)) or len(orders) != len(set(orders)):
            raise ValueError("segment slots need unique IDs and order")
        for slot in self.slots:
            for candidate in slot.candidates:
                targets = candidate.prescription.round_targets
                if targets is not None and len(targets) != self.rounds:
                    raise ValueError("round_targets must contain exactly segment.rounds entries")
        return self


class BlueprintDay(StrictModel):
    day_id: str = Field(pattern=r"^day_[a-z0-9_]{3,120}$")
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    kind: Literal["training", "rest"]
    title: str = Field(min_length=1, max_length=180)
    intent_md: str = Field(min_length=1, max_length=8_000)
    segments: list[Segment] = Field(default_factory=list, max_length=20)

    @model_validator(mode="after")
    def day_has_expected_structure(self) -> "BlueprintDay":
        if self.kind == "training" and not self.segments:
            raise ValueError("training day needs segments")
        if self.kind == "rest" and self.segments:
            raise ValueError("rest day cannot contain workout segments")
        ids = [segment.segment_id for segment in self.segments]
        orders = [segment.order for segment in self.segments]
        if len(ids) != len(set(ids)) or len(orders) != len(set(orders)):
            raise ValueError("day segments need unique IDs and order")
        exercise_ids = [candidate.exercise_id for segment in self.segments for slot in segment.slots for candidate in slot.candidates]
        if len(exercise_ids) != len(set(exercise_ids)):
            raise ValueError("each day candidate exercise belongs to exactly one slot")
        if self.kind == "training" and any(not segment.title for segment in self.segments):
            raise ValueError("training day segments need titles")
        return self


class HardConstraints(StrictModel):
    forbidden_exercise_ids: list[str] = Field(default_factory=list, max_length=100)
    notes_md: str = Field(default="", max_length=8_000)


class BlueprintInput(StrictModel):
    schema_version: Literal[1] = SCHEMA_VERSION
    timezone: str = Field(min_length=1, max_length=80)
    start_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    end_date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    hard_constraints: HardConstraints = Field(default_factory=HardConstraints)
    days: list[BlueprintDay] = Field(min_length=1, max_length=31)

    @model_validator(mode="after")
    def valid_dates_and_constraints(self) -> "BlueprintInput":
        if self.start_date > self.end_date:
            raise ValueError("start_date must not be after end_date")
        day_ids = [day.day_id for day in self.days]
        dates = [day.date for day in self.days]
        if len(day_ids) != len(set(day_ids)) or len(dates) != len(set(dates)):
            raise ValueError("blueprint days need unique IDs and dates")
        if any(day.date < self.start_date or day.date > self.end_date for day in self.days):
            raise ValueError("blueprint day falls outside the declared period")
        forbidden = set(self.hard_constraints.forbidden_exercise_ids)
        candidates = {candidate.exercise_id for day in self.days for segment in day.segments for slot in segment.slots for candidate in slot.candidates}
        if forbidden & candidates:
            raise ValueError("a hard-forbidden exercise cannot be a blueprint candidate")
        for day in self.days:
            for segment in day.segments:
                for slot in segment.slots:
                    if len(slot.candidates) <= slot.selection_count:
                        raise ValueError(
                            f"blueprint slot {slot.slot_id} needs at least one alternative beyond selection_count"
                        )
        return self


class PlanInput(StrictModel):
    title: str = Field(min_length=1, max_length=180)
    content_md: str = Field(min_length=1, max_length=64_000)


class PublishInput(StrictModel):
    plan_id: str = Field(pattern=r"^plan_[a-f0-9]{32}$")
    plan_revision: str = Field(pattern=r"^rev_[a-f0-9]{32}$")
    blueprint_id: str = Field(pattern=r"^bp_[a-f0-9]{32}$")
    blueprint_revision: str = Field(pattern=r"^rev_[a-f0-9]{32}$")
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")


class GenerateInput(StrictModel):
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    source: Literal["default", "jev"] = "default"
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")


class CopyLastWeekInput(StrictModel):
    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    expected_revision: str | None = Field(default=None, pattern=r"^rev_[a-f0-9]{32}$")
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")


class ClearWorkoutInput(StrictModel):
    expected_revision: str = Field(pattern=r"^rev_[a-f0-9]{32}$")
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")


class SwapInput(StrictModel):
    source: Literal["default", "jev"] = "default"
    reason: str = Field(min_length=1, max_length=500)
    target_candidate_id: str | None = Field(default=None, pattern=r"^cand_[a-z0-9_]{3,120}$")
    expected_revision: str = Field(pattern=r"^rev_[a-f0-9]{32}$")
    expected_blueprint_revision: str | None = Field(default=None, pattern=r"^rev_[a-f0-9]{32}$")
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")


class WorkoutOverrideInput(StrictModel):
    """A deliberately exceptional, fully resolved agent-authored day."""

    date: str = Field(pattern=r"^\d{4}-\d{2}-\d{2}$")
    title: str = Field(min_length=1, max_length=180)
    reason_md: str = Field(min_length=1, max_length=8_000)
    segments: list[Segment] = Field(min_length=1, max_length=20)
    expected_revision: str | None = Field(default=None, pattern=r"^rev_[a-f0-9]{32}$")
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")

    @model_validator(mode="after")
    def ordered_segments(self) -> "WorkoutOverrideInput":
        ids = [segment.segment_id for segment in self.segments]
        orders = [segment.order for segment in self.segments]
        if len(ids) != len(set(ids)) or len(orders) != len(set(orders)):
            raise ValueError("override segments need unique IDs and order")
        candidates = [
            candidate
            for segment in self.segments
            for slot in segment.slots
            for candidate in slot.candidates
        ]
        if any(slot.selection_count != 1 or len(slot.candidates) != 1 for segment in self.segments for slot in segment.slots):
            raise ValueError("override slots must contain exactly one resolved candidate")
        exercise_ids = [candidate.exercise_id for candidate in candidates]
        if len(exercise_ids) != len(set(exercise_ids)):
            raise ValueError("override candidate exercises must be unique")
        if any(not segment.title for segment in self.segments):
            raise ValueError("override segments need titles")
        return self


class SetActual(StrictModel):
    status: Literal["completed", "skipped"]
    reps: int | None = Field(default=None, ge=0, le=10_000)
    duration_seconds: int | None = Field(default=None, ge=0, le=86_400)
    load: Quantity | None = None
    rpe: float | None = Field(default=None, ge=0, le=10)
    completed_at: str | None = Field(default=None, max_length=80)


class SetLogInput(StrictModel):
    actual: SetActual
    expected_revision: str = Field(pattern=r"^rev_[a-f0-9]{32}$")
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")


class SetUnlogInput(StrictModel):
    expected_revision: str = Field(pattern=r"^rev_[a-f0-9]{32}$")
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")


class SetAddInput(StrictModel):
    expected_revision: str = Field(pattern=r"^rev_[a-f0-9]{32}$")
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")


class SetRemoveInput(StrictModel):
    expected_revision: str = Field(pattern=r"^rev_[a-f0-9]{32}$")
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")


class SetTargetInput(StrictModel):
    target: Target
    apply_to_remaining: bool = False
    expected_revision: str = Field(pattern=r"^rev_[a-f0-9]{32}$")
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")


class PlanEntryRemoveInput(StrictModel):
    expected_revision: str = Field(pattern=r"^rev_[a-f0-9]{32}$")
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")


class PlanReorderInput(StrictModel):
    """The day's segments in their new order: every segment exactly once."""

    segment_ids: list[str] = Field(min_length=1, max_length=100)
    expected_revision: str = Field(pattern=r"^rev_[a-f0-9]{32}$")
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")


class PlanItemMoveInput(StrictModel):
    """Move one item to a segment position; source removal applies first."""

    target_segment_id: str = Field(min_length=1, max_length=160)
    target_index: int = Field(ge=1, le=100)
    expected_revision: str = Field(pattern=r"^rev_[a-f0-9]{32}$")
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")


class PlanItemExtractInput(StrictModel):
    """Give an item its own segment before another segment, or at the end."""

    before_segment_id: str | None = Field(default=None, max_length=160)
    expected_revision: str = Field(pattern=r"^rev_[a-f0-9]{32}$")
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")


class ExerciseAddInput(PlanEntryRemoveInput):
    blueprint_id: str = Field(min_length=1, max_length=160)
    expected_blueprint_revision: str = Field(pattern=r"^rev_[a-f0-9]{32}$")
    day_id: str = Field(min_length=1, max_length=160)
    slot_id: str = Field(min_length=1, max_length=160)
    candidate_id: str = Field(min_length=1, max_length=160)


class WorkoutNotesInput(StrictModel):
    notes: str = Field(max_length=4_000)
    expected_revision: str = Field(pattern=r"^rev_[a-f0-9]{32}$")
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")


class ExerciseNoteInput(StrictModel):
    note: str = Field(max_length=2_000)
    preset: Literal["pain", "hard", "easy", "form"] | None = None
    expected_revision: str = Field(pattern=r"^rev_[a-f0-9]{32}$")
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")


def exercise_load_key(snapshot: dict[str, Any]) -> str:
    return "|".join([
        str(snapshot.get("exercise_id", "")),
        str(snapshot.get("equipment_profile_id", "")),
        str(snapshot.get("load_basis", "")),
        str(snapshot.get("laterality", "")),
    ])


def shift_date(date: str, days: int) -> str:
    return (datetime.strptime(date, "%Y-%m-%d").date() + timedelta(days=days)).isoformat()


def _decision_index(seed: str, candidates: list[dict[str, Any]], source: str) -> tuple[int, dict[str, float]]:
    ordered = sorted(candidates, key=lambda item: (item["priority"], item["candidate_id"]))
    if source == "default" or len(ordered) == 1:
        return 0, {item["candidate_id"]: (1.0 if index == 0 else 0.0) for index, item in enumerate(ordered)}
    digest = int(sha256(seed.encode()).hexdigest(), 16)
    # A deterministic seed makes retries repeatable while each candidate remains in
    # the closed blueprint universe. Priority remains a transparent weighting signal.
    weights = [1 / item["priority"] for item in ordered]
    total = sum(weights)
    point = (digest % 1_000_000) / 1_000_000 * total
    running = 0.0
    chosen = len(ordered) - 1
    for index, weight in enumerate(weights):
        running += weight
        if point <= running:
            chosen = index
            break
    return chosen, {item["candidate_id"]: weight / total for item, weight in zip(ordered, weights)}


def _quantity_dict(value: Quantity | dict[str, Any] | None) -> dict[str, Any] | None:
    if value is None:
        return None
    if isinstance(value, Quantity):
        return value.model_dump(mode="json")
    return {"value": value["value"], "unit": value["unit"]}


_SESSION_AWARE_COLLECTION_METHODS = {
    "aggregate",
    "bulk_write",
    "count_documents",
    "delete_many",
    "delete_one",
    "distinct",
    "find",
    "find_one",
    "find_one_and_delete",
    "find_one_and_replace",
    "find_one_and_update",
    "insert_many",
    "insert_one",
    "replace_one",
    "update_many",
    "update_one",
}


class _SessionCollection:
    """Inject the active transaction session into collection operations."""

    def __init__(self, collection: Any, session_var: ContextVar[Any]):
        self._collection = collection
        self._session_var = session_var

    def __getattr__(self, name: str) -> Any:
        operation = getattr(self._collection, name)
        if name not in _SESSION_AWARE_COLLECTION_METHODS or not callable(operation):
            return operation

        @wraps(operation)
        def with_session(*args: Any, **kwargs: Any) -> Any:
            session = self._session_var.get()
            if session is not None:
                kwargs.setdefault("session", session)
            return operation(*args, **kwargs)

        return with_session

    def __getitem__(self, name: str) -> "_SessionCollection":
        return _SessionCollection(self._collection[name], self._session_var)


class _SessionDatabase:
    """Keep collection access transaction-aware without changing domain calls."""

    def __init__(self, database: Any, session_var: ContextVar[Any]):
        self._database = database
        self._session_var = session_var

    def __getattr__(self, name: str) -> Any:
        value = getattr(self._database, name)
        if name in {"client", "name", "read_concern", "read_preference", "write_concern"}:
            return value
        return _SessionCollection(value, self._session_var)

    def __getitem__(self, name: str) -> _SessionCollection:
        return _SessionCollection(self._database[name], self._session_var)


def transactional_mutation(method: Any) -> Any:
    """Run a mutation and its authoritative receipt in one Mongo transaction."""

    @wraps(method)
    async def wrapped(self: "WorkoutService", *args: Any, **kwargs: Any) -> Any:
        if self._session_var.get() is not None:
            return await method(self, *args, **kwargs)
        try:
            return await self._run_transaction(lambda: method(self, *args, **kwargs))
        except DuplicateKeyError:
            # A concurrent request may win a unique-key race after this
            # transaction's snapshot. Retry the complete operation so its
            # request receipt becomes the idempotent source of truth.
            return await self._run_transaction(lambda: method(self, *args, **kwargs))
        except OperationFailure as error:
            if not _transactions_unsupported(error):
                raise
            # Standalone MongoDB (the local development default) cannot run
            # multi-document transactions. Fall back to direct execution;
            # request receipts still provide idempotency.
            return await method(self, *args, **kwargs)

    return wrapped


def _transactions_unsupported(error: OperationFailure) -> bool:
    """Detect a deployment without multi-document transaction support."""
    return getattr(error, "code", None) == 20 or "Transaction numbers are only allowed" in str(error)


class WorkoutService:
    """Canonical persistence service for end-state workout records.

    Mutation methods require a MongoDB deployment that supports multi-document
    transactions, such as a replica set or mongos.
    """

    def __init__(self, database: Any):
        self._session_var: ContextVar[Any] = ContextVar("aifit_workout_transaction_session", default=None)
        self.db = _SessionDatabase(database, self._session_var)

    async def _run_transaction(self, operation: Any) -> Any:
        async with self.db.client.start_session() as session:
            async def callback(transaction_session: Any) -> Any:
                token = self._session_var.set(transaction_session)
                try:
                    return await operation()
                finally:
                    self._session_var.reset(token)

            return await session.with_transaction(callback)

    async def ensure_indexes(self) -> None:
        await self.db.exercises.create_index([("account_id", ASCENDING), ("exercise_id", ASCENDING), ("revision", ASCENDING)], unique=True)
        await self.db.exercise_heads.create_index([("account_id", ASCENDING), ("exercise_id", ASCENDING)], unique=True)
        await self.db.plans.create_index([("account_id", ASCENDING), ("plan_id", ASCENDING), ("revision", ASCENDING)], unique=True)
        await self.db.blueprints.create_index([("account_id", ASCENDING), ("blueprint_id", ASCENDING), ("revision", ASCENDING)], unique=True)
        await self.db.releases.create_index([("account_id", ASCENDING), ("release_id", ASCENDING)], unique=True)
        await self.db.program_state.create_index([("account_id", ASCENDING)], unique=True)
        await self.db.workouts.create_index([("account_id", ASCENDING), ("date", ASCENDING)], unique=True)
        await self.db.performance_index.create_index([("account_id", ASCENDING), ("load_key", ASCENDING), ("completed_at", DESCENDING)])
        await self.db.performance_index.create_index([("account_id", ASCENDING), ("exercise_id", ASCENDING), ("completed_at", DESCENDING)])
        await self.db.performance_index.create_index([("account_id", ASCENDING), ("movement_pattern", ASCENDING), ("completed_at", DESCENDING)])
        await self.db.mutation_receipts.create_index([("account_id", ASCENDING), ("request_id", ASCENDING)], unique=True)

    async def _receipt(self, account_id: str, request_id: str, fingerprint: str) -> dict[str, Any] | None:
        current = await self.db.mutation_receipts.find_one({"account_id": account_id, "request_id": request_id})
        if not current:
            return None
        if current["fingerprint"] != fingerprint:
            raise WorkoutDomainError("idempotency_conflict", "This request ID was already used for different content.")
        return current["response"]

    async def _save_receipt(self, account_id: str, request_id: str, fingerprint: str, response: dict[str, Any]) -> dict[str, Any]:
        document = {"account_id": account_id, "request_id": request_id, "fingerprint": fingerprint, "response": response, "created_at": utc_now()}
        try:
            await self.db.mutation_receipts.insert_one(document)
            return response
        except DuplicateKeyError:
            # A duplicate inside a transaction aborts that transaction. Let the
            # transaction wrapper roll it back; the non-transactional fallback
            # preserves the existing idempotency behavior for direct callers.
            if self._session_var.get() is not None:
                raise
            existing = await self._receipt(account_id, request_id, fingerprint)
            if existing is None:
                raise
            return existing

    @staticmethod
    def receipt(resource: str, resource_id: str, revision: str, request_id: str, effect: str = "saved") -> dict[str, Any]:
        return {"status": "saved", "resource": resource, "resource_id": resource_id, "revision": revision,
                "request_id": request_id, "effect": effect, "updated_at": utc_now()}

    @transactional_mutation
    async def create_exercise(self, account_id: str, definition: ExerciseDefinitionInput, request_id: str, actor: dict[str, Any], expected_revision: str | None = None) -> dict[str, Any]:
        fingerprint = _fingerprint({"definition": definition.model_dump(mode="json"), "expected_revision": expected_revision, "actor": actor})
        prior = await self._receipt(account_id, request_id, fingerprint)
        if prior:
            return prior
        head = await self.db.exercise_heads.find_one({"account_id": account_id, "exercise_id": definition.exercise_id})
        if head and expected_revision is None:
            raise WorkoutDomainError("exercise_exists", "Exercise already exists; revise it with its current revision.")
        if head and head["revision"] != expected_revision:
            raise WorkoutDomainError("stale_revision", "Exercise changed. Pull its current revision before editing.")
        revision, timestamp = new_revision(), utc_now()
        document = {"account_id": account_id, "revision": revision, "schema_version": SCHEMA_VERSION,
                    "created_at": timestamp, "updated_at": timestamp, "updated_by": actor, **definition.model_dump(mode="json")}
        await self.db.exercises.insert_one(document)
        await self.db.exercise_heads.replace_one({"account_id": account_id, "exercise_id": definition.exercise_id},
                                                 {"account_id": account_id, "exercise_id": definition.exercise_id, "revision": revision}, upsert=True)
        return await self._save_receipt(account_id, request_id, fingerprint, self.receipt("exercise", definition.exercise_id, revision, request_id))

    async def exercise(self, account_id: str, exercise_id: str, revision: str | None = None) -> dict[str, Any]:
        query: dict[str, Any] = {"account_id": account_id, "exercise_id": exercise_id}
        if revision is not None:
            query["revision"] = revision
        else:
            head = await self.db.exercise_heads.find_one({"account_id": account_id, "exercise_id": exercise_id})
            if not head:
                raise WorkoutDomainError("exercise_not_found", "Exercise was not found.", 404)
            query["revision"] = head["revision"]
        document = await self.db.exercises.find_one(query)
        if not document:
            raise WorkoutDomainError("exercise_not_found", "Exercise revision was not found.", 404)
        return self._public(document, ("account_id", "_id"))

    @transactional_mutation
    async def draft_plan(self, account_id: str, input: PlanInput, expected_revision: str | None, request_id: str, actor: dict[str, Any], plan_id: str | None = None) -> dict[str, Any]:
        fingerprint = _fingerprint({"plan": input.model_dump(mode="json"), "expected_revision": expected_revision, "plan_id": plan_id, "actor": actor})
        prior = await self._receipt(account_id, request_id, fingerprint)
        if prior:
            return prior
        if plan_id:
            current = await self.db.plans.find_one({"account_id": account_id, "plan_id": plan_id, "revision": expected_revision})
            if not current:
                raise WorkoutDomainError("stale_revision", "Fitness Plan changed. Pull it before editing.")
        elif expected_revision is not None:
            raise WorkoutDomainError("invalid_plan_revision", "A new Fitness Plan cannot declare an expected revision.", 422)
        identifier, revision, timestamp = plan_id or new_id("plan"), new_revision(), utc_now()
        document = {"account_id": account_id, "plan_id": identifier, "revision": revision, "schema_version": SCHEMA_VERSION,
                    "status": "draft", "created_at": timestamp, "updated_at": timestamp, "updated_by": actor, **input.model_dump(mode="json")}
        await self.db.plans.insert_one(document)
        return await self._save_receipt(account_id, request_id, fingerprint, self.receipt("plan", identifier, revision, request_id))

    @transactional_mutation
    async def draft_blueprint(self, account_id: str, input: BlueprintInput, expected_revision: str | None, request_id: str, actor: dict[str, Any], blueprint_id: str | None = None) -> dict[str, Any]:
        fingerprint = _fingerprint({"blueprint": input.model_dump(mode="json"), "expected_revision": expected_revision, "blueprint_id": blueprint_id, "actor": actor})
        prior = await self._receipt(account_id, request_id, fingerprint)
        if prior:
            return prior
        if blueprint_id:
            current = await self.db.blueprints.find_one({"account_id": account_id, "blueprint_id": blueprint_id, "revision": expected_revision})
            if not current:
                raise WorkoutDomainError("stale_revision", "Blueprint changed. Pull it before editing.")
        elif expected_revision is not None:
            raise WorkoutDomainError("invalid_blueprint_revision", "A new blueprint cannot declare an expected revision.", 422)
        identifier, revision, timestamp = blueprint_id or new_id("bp"), new_revision(), utc_now()
        document = {"account_id": account_id, "blueprint_id": identifier, "revision": revision, "schema_version": SCHEMA_VERSION,
                    "status": "draft", "created_at": timestamp, "updated_at": timestamp, "updated_by": actor, **input.model_dump(mode="json")}
        await self.db.blueprints.insert_one(document)
        return await self._save_receipt(account_id, request_id, fingerprint, self.receipt("blueprint", identifier, revision, request_id))

    @transactional_mutation
    async def solidify_blueprint(self, account_id: str, input: BlueprintInput, expected_revision: str | None,
                                 request_id: str, actor: dict[str, Any], blueprint_id: str | None = None) -> dict[str, Any]:
        """Validate, persist, and activate one complete blueprint revision."""
        fingerprint = _fingerprint({
            "blueprint": input.model_dump(mode="json"),
            "expected_revision": expected_revision,
            "blueprint_id": blueprint_id,
        })
        prior = await self._receipt(account_id, request_id, fingerprint)
        if prior:
            return prior
        if blueprint_id:
            current = await self.db.blueprints.find_one({
                "account_id": account_id, "blueprint_id": blueprint_id, "revision": expected_revision,
            })
            if not current:
                raise WorkoutDomainError("stale_revision", "Blueprint changed. Pull it before editing.")
        elif expected_revision is not None:
            raise WorkoutDomainError("invalid_blueprint_revision", "A new blueprint cannot declare an expected revision.", 422)

        identifier, revision, timestamp = blueprint_id or new_id("bp"), new_revision(), utc_now()
        document = {
            "account_id": account_id,
            "blueprint_id": identifier,
            "revision": revision,
            "schema_version": SCHEMA_VERSION,
            "status": "published",
            "created_at": timestamp,
            "updated_at": timestamp,
            "updated_by": actor,
            **input.model_dump(mode="json"),
        }
        await self.db.blueprints.insert_one(document)
        await self.db.program_state.find_one_and_update(
            {"account_id": account_id},
            {"$set": {
                "account_id": account_id,
                "active_blueprint_id": identifier,
                "active_blueprint_revision": revision,
                "updated_at": timestamp,
            }, "$unset": {"active_release_id": ""}},
            upsert=True,
        )
        response = self.receipt("blueprint", identifier, revision, request_id, "published")
        response["blueprint"] = self._public(document, ("account_id", "_id"))
        return await self._save_receipt(account_id, request_id, fingerprint, response)

    @transactional_mutation
    async def publish(self, account_id: str, input: PublishInput, actor: dict[str, Any]) -> dict[str, Any]:
        fingerprint = _fingerprint(input.model_dump(mode="json"))
        prior = await self._receipt(account_id, input.request_id, fingerprint)
        if prior:
            return prior
        plan = await self.db.plans.find_one({"account_id": account_id, "plan_id": input.plan_id, "revision": input.plan_revision})
        blueprint = await self.db.blueprints.find_one({"account_id": account_id, "blueprint_id": input.blueprint_id, "revision": input.blueprint_revision})
        if not plan or not blueprint:
            raise WorkoutDomainError("publication_input_not_found", "Plan or blueprint revision was not found.", 404)
        release_id, timestamp = new_id("rel"), utc_now()
        release = {"account_id": account_id, "release_id": release_id, "schema_version": SCHEMA_VERSION,
                   "plan_id": input.plan_id, "plan_revision": input.plan_revision, "blueprint_id": input.blueprint_id,
                   "blueprint_revision": input.blueprint_revision, "effective_from": blueprint["start_date"], "effective_through": blueprint["end_date"],
                   "published_at": timestamp, "published_by": actor}
        await self.db.releases.insert_one(release)
        await self.db.program_state.find_one_and_update(
            {"account_id": account_id},
            {"$set": {
                "account_id": account_id,
                "active_release_id": release_id,
                "active_blueprint_id": input.blueprint_id,
                "active_blueprint_revision": input.blueprint_revision,
                "updated_at": timestamp,
            }},
            upsert=True,
        )
        await self.db.plans.update_one({"account_id": account_id, "plan_id": input.plan_id, "revision": input.plan_revision}, {"$set": {"status": "published"}})
        await self.db.blueprints.update_one({"account_id": account_id, "blueprint_id": input.blueprint_id, "revision": input.blueprint_revision}, {"$set": {"status": "published"}})
        return await self._save_receipt(account_id, input.request_id, fingerprint, self.receipt("program_release", release_id, input.blueprint_revision, input.request_id, "published"))

    async def active_release(self, account_id: str, date: str | None = None) -> dict[str, Any]:
        state = await self.db.program_state.find_one({"account_id": account_id})
        release_id = state.get("active_release_id") if state else None
        if not release_id:
            raise WorkoutDomainError("active_program_missing", "No published program release is active.", 404)
        release = await self.db.releases.find_one({"account_id": account_id, "release_id": release_id})
        if not release:
            raise WorkoutDomainError("active_program_missing", "Active program release is unavailable.", 404)
        if (
            state.get("active_blueprint_id") != release["blueprint_id"]
            or state.get("active_blueprint_revision") != release["blueprint_revision"]
        ):
            raise WorkoutDomainError("active_program_missing", "The active program release is stale.", 404)
        if date and not (release["effective_from"] <= date <= release["effective_through"]):
            raise WorkoutDomainError("program_date_uncovered", "The active program does not cover this date.")
        blueprint = await self.db.blueprints.find_one({"account_id": account_id, "blueprint_id": release["blueprint_id"], "revision": release["blueprint_revision"]})
        plan = await self.db.plans.find_one({"account_id": account_id, "plan_id": release["plan_id"], "revision": release["plan_revision"]})
        return {"release": self._public(release, ("account_id", "_id")), "plan": self._public(plan, ("account_id", "_id")), "blueprint": self._public(blueprint, ("account_id", "_id"))}

    async def active_blueprint(self, account_id: str, date: str | None = None) -> dict[str, Any]:
        state = await self.db.program_state.find_one({"account_id": account_id})
        if not state or not state.get("active_blueprint_id") or not state.get("active_blueprint_revision"):
            raise WorkoutDomainError("active_blueprint_missing", "No published workout blueprint is active.", 404)
        blueprint = await self.db.blueprints.find_one({
            "account_id": account_id,
            "blueprint_id": state["active_blueprint_id"],
            "revision": state["active_blueprint_revision"],
        })
        if not blueprint:
            raise WorkoutDomainError("active_blueprint_missing", "The active workout blueprint is unavailable.", 404)
        if date and not (blueprint["start_date"] <= date <= blueprint["end_date"]):
            raise WorkoutDomainError("blueprint_date_uncovered", "The active blueprint does not cover this date.")
        return {"blueprint": self._public(blueprint, ("account_id", "_id"))}

    @transactional_mutation
    async def generate(self, account_id: str, input: GenerateInput) -> dict[str, Any]:
        fingerprint = _fingerprint(input.model_dump(mode="json"))
        prior = await self._receipt(account_id, input.request_id, fingerprint)
        if prior:
            return prior
        existing = await self.db.workouts.find_one({"account_id": account_id, "date": input.date})
        if existing:
            response = self.receipt("workout", existing["workout_id"], existing["revision"], input.request_id, "existing")
            response["workout"] = self._public(existing, ("account_id", "_id"))
            return await self._save_receipt(account_id, input.request_id, fingerprint, response)
        active = await self.active_blueprint(account_id, input.date)
        blueprint = active["blueprint"]
        day = next((item for item in blueprint["days"] if item["date"] == input.date), None)
        if not day:
            raise WorkoutDomainError("blueprint_day_missing", "The active blueprint has no day for this date.")
        workout = await self._materialize(account_id, blueprint, day, input)
        await self.db.workouts.insert_one(workout)
        response = self.receipt("workout", workout["workout_id"], workout["revision"], input.request_id, "generated")
        response["workout"] = self._public(workout, ("account_id", "_id"))
        return await self._save_receipt(account_id, input.request_id, fingerprint, response)

    async def _materialize(self, account_id: str, blueprint: dict[str, Any], day: dict[str, Any], input: GenerateInput) -> dict[str, Any]:
        segments: list[dict[str, Any]] = []
        selected_exercises: set[str] = set()
        decisions: list[dict[str, Any]] = []
        progression_history: list[dict] | None = None
        for segment in sorted(day.get("segments", []), key=lambda item: item["order"]):
            items: list[dict[str, Any]] = []
            for slot in sorted(segment["slots"], key=lambda item: item["order"]):
                available = [candidate for candidate in slot["candidates"] if candidate["exercise_id"] not in selected_exercises]
                if len(available) < slot["selection_count"]:
                    raise WorkoutDomainError("slot_unfillable", f"Slot {slot['slot_id']} has no unique eligible selection.")
                for pick in range(slot["selection_count"]):
                    index, probabilities = _decision_index(
                        f"{blueprint['blueprint_id']}:{blueprint['revision']}:{input.date}:{slot['slot_id']}:{pick}:{input.request_id}",
                        available,
                        input.source,
                    )
                    candidate = sorted(available, key=lambda item: (item["priority"], item["candidate_id"]))[index]
                    available = [item for item in available if item["candidate_id"] != candidate["candidate_id"]]
                    selected_exercises.add(candidate["exercise_id"])
                    exercise = await self._candidate_exercise(account_id, candidate)
                    snapshot = {key: exercise[key] for key in ("exercise_id", "revision", "name", "movement_pattern", "primary_muscles", "secondary_muscles", "equipment_kind", "laterality", "load_basis")}
                    snapshot["exercise_revision"] = snapshot.pop("revision")
                    snapshot["equipment_profile_id"] = candidate.get("equipment_profile_id")
                    targets = candidate["prescription"].get("round_targets") or [candidate["prescription"]["target"]] * segment["rounds"]
                    policy = candidate.get("progression", {"kind": "none"})
                    if progression_history is None and policy["kind"] == "double_progression" and policy.get("phase", "build") == "build":
                        progression_history = await self._progression_history(account_id, day["date"])
                    load, load_decision = await self._progression_target(account_id, snapshot, candidate, targets, day["date"], blueprint["start_date"], history=progression_history)
                    sets = []
                    for round_index, target in enumerate(targets):
                        target = dict(target)
                        if load is not None:
                            target["load"] = load
                        sets.append({"set_id": new_id("set"), "kind": "work", "target": target, "actual": None, "round": round_index + 1})
                    instance_id = new_id("wex")
                    items.append({"exercise_instance_id": instance_id, "slot_id": slot["slot_id"], "candidate_id": candidate["candidate_id"], "order": len(items) + 1,
                                  "exercise_snapshot": snapshot, "sets": sets, "cues_md": self._cues(candidate, exercise),
                                  "progression_context": progression_context(candidate, len(targets), blueprint["start_date"], load)})
                    decisions.append({"slot_id": slot["slot_id"], "candidate_id": candidate["candidate_id"], "source": input.source,
                                      "probabilities": probabilities, "load": load_decision})
            segments.append({"segment_id": segment["segment_id"], "order": segment["order"], "kind": segment["kind"], "rounds": segment["rounds"],
                             "rest_after_round_seconds": segment["rest_after_round_seconds"], "items": items,
                             "title": segment.get("title")})
        timestamp = utc_now()
        return {"account_id": account_id, "workout_id": new_id("wrk"), "schema_version": SCHEMA_VERSION, "revision": new_revision(),
                "date": day["date"], "timezone": blueprint["timezone"], "status": "planned", "title": day["title"], "notes": "", "segments": segments,
                "lineage": {"source": input.source, "blueprint_id": blueprint["blueprint_id"],
                            "blueprint_revision": blueprint["revision"], "day_id": day["day_id"], "decision_receipt": {"engine": "bounded_ranker_v1", "selections": decisions}},
                "created_at": timestamp, "updated_at": timestamp}

    async def _candidate_exercise(self, account_id: str, candidate: dict[str, Any],
                                  definitions: dict[tuple[str, str], dict[str, Any]] | None = None) -> dict[str, Any]:
        document = definitions.get((candidate["exercise_id"], candidate["exercise_revision"])) if definitions is not None else await self.db.exercises.find_one({
            "account_id": account_id,
            "exercise_id": candidate["exercise_id"],
            "revision": candidate["exercise_revision"],
        })
        if document:
            return document
        # Agent-authored IDs need no prior catalog row. Synthesize display
        # metadata from the ID only; never present the author's rationale as
        # user-facing instructions.
        exercise_id = candidate["exercise_id"]
        name = exercise_id.removeprefix("ex_").replace("_", " ").strip().title() or exercise_id
        return {
            "exercise_id": exercise_id,
            "revision": candidate["exercise_revision"],
            "name": name,
            "movement_pattern": "",
            "primary_muscles": [],
            "secondary_muscles": [],
            "equipment_kind": "",
            "laterality": "bilateral",
            "load_basis": "total",
            "instructions_md": "",
        }

    @staticmethod
    def _cues(candidate: dict[str, Any], exercise: dict[str, Any]) -> str:
        tempo = candidate["prescription"].get("tempo")
        tempo_text = ""
        if tempo:
            tempo_text = f" Tempo: {tempo['eccentric_seconds']} sec eccentric, {tempo['pause_seconds']} sec pause, {tempo['concentric_seconds']} sec concentric."
        return f"{exercise['instructions_md']}{tempo_text}"

    async def _progression_history(self, account_id: str, as_of: str) -> list[dict]:
        anchor = datetime.strptime(as_of, "%Y-%m-%d").date()
        start = (anchor - timedelta(days=83)).isoformat()
        end = (anchor + timedelta(days=6-anchor.weekday())).isoformat()
        return await self.db.workouts.find({
            "account_id": account_id, "deleted_at": {"$exists": False},
            "date": {"$gte": start, "$lte": end},
        }).sort("date", ASCENDING).limit(90).to_list()

    async def _progression_target(self, account_id: str, snapshot: dict[str, Any], candidate: dict[str, Any],
                                  targets: list[dict], as_of: str, start_date: str, *, history: list[dict] | None = None) -> tuple[dict | None, dict]:
        target_load = targets[-1].get("load")
        policy = candidate.get("progression", {"kind": "none"})
        if policy["kind"] == "none" or policy.get("phase", "build") != "build":
            return target_load, {"decision": "blueprint_target", "reason": "planned_phase" if policy.get("phase", "build") != "build" else "no_automatic_rule"}
        context = progression_context(candidate, len(targets), start_date, target_load)
        # Generation and swaps cannot learn from their own partially logged day
        # or from a future workout. The same analyzer serves browser and plugin.
        if history is None:
            history = await self._progression_history(account_id, as_of)
        history = [row for row in history if row["date"] < as_of]
        summary = analyze_exercise(snapshot, context, history, as_of)
        load = summary["next_load"]
        return load, {"decision": "increase" if summary["status"] == "ready" else "hold",
                      "reason": summary["reason"], "status": summary["status"],
                      "qualifying_sessions": summary["qualifying_sessions"],
                      "source_workout_id": (summary["latest"] or {}).get("workout_id")}

    async def progression(self, account_id: str, workout_id: str) -> dict:
        workout = await self.workout(account_id, workout_id)
        history = await self._progression_history(account_id, workout["date"])
        workout = next((row for row in history if row["workout_id"] == workout_id), workout)
        exercises = []
        for segment in workout["segments"]:
            if segment["kind"] in ("warmup", "cooldown", "mobility"):
                continue
            for item in segment["items"]:
                summary = analyze_exercise(item["exercise_snapshot"], item.get("progression_context"), history, workout["date"])
                summary["exercise_instance_id"] = item["exercise_instance_id"]
                exercises.append(summary)
        return {"workout_id": workout_id, "revision": workout["revision"], "as_of": workout["date"],
                "history_days": 84, "trend_days": 28, "exercises": exercises,
                "muscles": summarize_muscles(history, workout["date"])}

    async def workout(self, account_id: str, workout_id: str) -> dict[str, Any]:
        document = await self.db.workouts.find_one({"account_id": account_id, "workout_id": workout_id, "deleted_at": {"$exists": False}})
        if not document:
            raise WorkoutDomainError("workout_not_found", "Workout was not found.", 404)
        return self._public(document, ("account_id", "_id"))

    async def workouts(self, account_id: str, start: str, end: str) -> list[dict[str, Any]]:
        rows = await self.db.workouts.find({"account_id": account_id, "date": {"$gte": start, "$lte": end}, "deleted_at": {"$exists": False}}).sort("date", ASCENDING).to_list()
        return [self._public(row, ("account_id", "_id")) for row in rows]

    @transactional_mutation
    async def log_set(self, account_id: str, workout_id: str, set_id: str, input: SetLogInput) -> dict[str, Any]:
        fingerprint = _fingerprint({"workout_id": workout_id, "set_id": set_id, **input.model_dump(mode="json")})
        prior = await self._receipt(account_id, input.request_id, fingerprint)
        if prior:
            return prior
        workout = await self.db.workouts.find_one({"account_id": account_id, "workout_id": workout_id, "deleted_at": {"$exists": False}})
        if not workout:
            raise WorkoutDomainError("workout_not_found", "Workout was not found.", 404)
        if workout["revision"] != input.expected_revision:
            raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before logging.")
        matched: tuple[dict[str, Any], dict[str, Any]] | None = None
        for segment in workout["segments"]:
            for item in segment["items"]:
                for set_row in item["sets"]:
                    if set_row["set_id"] == set_id:
                        matched = item, set_row
                        break
        if not matched:
            raise WorkoutDomainError("set_not_found", "Workout set was not found.", 404)
        item, set_row = matched
        actual = input.actual.model_dump(mode="json", exclude_none=True)
        actual.setdefault("completed_at", utc_now())
        target = set_row["target"]
        if target.get("reps") is not None and "reps" not in actual and actual["status"] == "completed":
            raise WorkoutDomainError("actual_metric_missing", "Completed repetition set needs actual reps.", 422)
        if target.get("duration_seconds") is not None and "duration_seconds" not in actual and actual["status"] == "completed":
            raise WorkoutDomainError("actual_metric_missing", "Completed duration set needs actual duration.", 422)
        set_row["actual"] = actual
        workout["status"] = self._workout_status(workout)
        workout["revision"], workout["updated_at"] = new_revision(), utc_now()
        replaced = await self.db.workouts.replace_one({"account_id": account_id, "workout_id": workout_id, "revision": input.expected_revision}, workout)
        if not replaced.modified_count:
            raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before logging.")
        # A set edit keeps history exact: a completed set refreshes its row, a
        # skipped or load-less edit removes the row it no longer owns.
        await self._index_performance(account_id, workout, item, set_row)
        response = self.receipt("workout", workout_id, workout["revision"], input.request_id, "set_logged")
        response["workout"] = self._public(workout, ("account_id", "_id"))
        return await self._save_receipt(account_id, input.request_id, fingerprint, response)

    @transactional_mutation
    async def unlog_set(self, account_id: str, workout_id: str, set_id: str, input: SetUnlogInput) -> dict[str, Any]:
        """Return one logged set to pending and remove its history effect."""
        fingerprint = _fingerprint({"workout_id": workout_id, "set_id": set_id, **input.model_dump(mode="json")})
        prior = await self._receipt(account_id, input.request_id, fingerprint)
        if prior:
            return prior
        workout = await self.db.workouts.find_one({"account_id": account_id, "workout_id": workout_id, "deleted_at": {"$exists": False}})
        if not workout:
            raise WorkoutDomainError("workout_not_found", "Workout was not found.", 404)
        if workout["revision"] != input.expected_revision:
            raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before unlogging.")
        matched: tuple[dict[str, Any], dict[str, Any]] | None = None
        for segment in workout["segments"]:
            for item in segment["items"]:
                for set_row in item["sets"]:
                    if set_row["set_id"] == set_id:
                        matched = item, set_row
                        break
        if not matched:
            raise WorkoutDomainError("set_not_found", "Workout set was not found.", 404)
        item, set_row = matched
        if set_row.get("actual") is None:
            raise WorkoutDomainError("set_not_logged", "Workout set is not logged.")
        set_row["actual"] = None
        workout["status"] = self._workout_status(workout)
        workout["revision"], workout["updated_at"] = new_revision(), utc_now()
        replaced = await self.db.workouts.replace_one({"account_id": account_id, "workout_id": workout_id, "revision": input.expected_revision}, workout)
        if not replaced.modified_count:
            raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before unlogging.")
        await self._index_performance(account_id, workout, item, set_row)
        response = self.receipt("workout", workout_id, workout["revision"], input.request_id, "set_unlogged")
        response["workout"] = self._public(workout, ("account_id", "_id"))
        return await self._save_receipt(account_id, input.request_id, fingerprint, response)

    @staticmethod
    def _workout_status(workout: dict[str, Any]) -> str:
        sets = [set_row for segment in workout["segments"] for item in segment["items"] for set_row in item["sets"]]
        if sets and all(set_row.get("actual") is not None for set_row in sets):
            return "completed"
        if any(set_row.get("actual") is not None for set_row in sets):
            return "in_progress"
        return "planned"

    async def _index_performance(self, account_id: str, workout: dict[str, Any], item: dict[str, Any], set_row: dict[str, Any]) -> None:
        """Keep the history row for one set exact, or remove the one it no longer owns."""
        actual = set_row.get("actual")
        load = actual.get("load") if actual else None
        if actual is None or actual.get("status") != "completed" or not load:
            await self.db.performance_index.delete_one({
                "account_id": account_id, "workout_id": workout["workout_id"], "set_id": set_row["set_id"],
            })
            return
        snapshot = item["exercise_snapshot"]
        document = {"account_id": account_id, "load_key": exercise_load_key(snapshot), "workout_id": workout["workout_id"],
                    "exercise_id": snapshot.get("exercise_id"), "exercise_name": snapshot.get("name"),
                    "movement_pattern": snapshot.get("movement_pattern") or "",
                    "primary_muscles": list(snapshot.get("primary_muscles") or []),
                    "exercise_instance_id": item["exercise_instance_id"], "set_id": set_row["set_id"], "date": workout["date"],
                    "completed_at": actual["completed_at"], "load": load, "reps": actual.get("reps"), "duration_seconds": actual.get("duration_seconds"),
                    "rpe": actual.get("rpe")}
        await self.db.performance_index.replace_one({"account_id": account_id, "workout_id": workout["workout_id"], "set_id": set_row["set_id"]}, document, upsert=True)

    async def _editable_workout(self, account_id: str, workout_id: str, expected_revision: str) -> dict[str, Any]:
        """Load the live workout and enforce the optimistic revision guard."""
        workout = await self.db.workouts.find_one({"account_id": account_id, "workout_id": workout_id, "deleted_at": {"$exists": False}})
        if not workout:
            raise WorkoutDomainError("workout_not_found", "Workout was not found.", 404)
        if workout["revision"] != expected_revision:
            raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before editing.")
        return workout

    @staticmethod
    def _find_set(workout: dict[str, Any], set_id: str) -> tuple[dict[str, Any], dict[str, Any]]:
        for segment in workout["segments"]:
            for item in segment["items"]:
                for set_row in item["sets"]:
                    if set_row["set_id"] == set_id:
                        return item, set_row
        raise WorkoutDomainError("set_not_found", "Workout set was not found.", 404)

    @staticmethod
    def _renumber_workout(workout: dict[str, Any]) -> None:
        """Keep segment and item order canonical (1-based, contiguous)."""
        for segment_index, segment in enumerate(workout["segments"], start=1):
            segment["order"] = segment_index
            for item_index, item in enumerate(segment["items"], start=1):
                item["order"] = item_index

    async def _replace_or_delete_workout(
        self,
        account_id: str,
        workout_id: str,
        expected_revision: str,
        request_id: str,
        fingerprint: str,
        effect: str,
        workout: dict[str, Any],
    ) -> dict[str, Any]:
        """Persist a plan edit; delete the record when no logged content remains."""
        if not workout["segments"]:
            deleted = await self.db.workouts.delete_one(
                {"account_id": account_id, "workout_id": workout_id, "revision": expected_revision},
            )
            if not deleted.deleted_count:
                raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before editing.")
            response = self.receipt("workout", workout_id, expected_revision, request_id, effect)
            response["workout"] = None
            return await self._save_receipt(account_id, request_id, fingerprint, response)
        self._renumber_workout(workout)
        workout["status"] = self._workout_status(workout)
        workout["revision"], workout["updated_at"] = new_revision(), utc_now()
        replaced = await self.db.workouts.replace_one(
            {"account_id": account_id, "workout_id": workout_id, "revision": expected_revision}, workout,
        )
        if not replaced.modified_count:
            raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before editing.")
        response = self.receipt("workout", workout_id, workout["revision"], request_id, effect)
        response["workout"] = self._public(workout, ("account_id", "_id"))
        return await self._save_receipt(account_id, request_id, fingerprint, response)

    @transactional_mutation
    async def add_set(self, account_id: str, workout_id: str, exercise_instance_id: str, input: SetAddInput) -> dict[str, Any]:
        """Append one unlogged set, copying the target of the last non-warmup set."""
        fingerprint = _fingerprint({"workout_id": workout_id, "exercise_instance_id": exercise_instance_id, **input.model_dump(mode="json")})
        prior = await self._receipt(account_id, input.request_id, fingerprint)
        if prior:
            return prior
        workout = await self._editable_workout(account_id, workout_id, input.expected_revision)
        item: dict[str, Any] | None = None
        for segment in workout["segments"]:
            for candidate in segment["items"]:
                if candidate["exercise_instance_id"] == exercise_instance_id:
                    item = candidate
                    break
        if item is None:
            raise WorkoutDomainError("exercise_instance_not_found", "Workout exercise was not found.", 404)
        source = next((set_row for set_row in reversed(item["sets"]) if set_row.get("kind") != "warmup"), None)
        if source is None and item["sets"]:
            source = item["sets"][-1]
        if source is None:
            raise WorkoutDomainError("set_source_missing", "This exercise has no set left to copy a target from.")
        new_set: dict[str, Any] = {"set_id": new_id("set"), "kind": source.get("kind", "work"),
                                  "target": deepcopy(source["target"]), "actual": None}
        if source.get("round") is not None:
            new_set["round"] = source["round"] + 1
        item["sets"].append(new_set)
        workout["status"] = self._workout_status(workout)
        workout["revision"], workout["updated_at"] = new_revision(), utc_now()
        replaced = await self.db.workouts.replace_one(
            {"account_id": account_id, "workout_id": workout_id, "revision": input.expected_revision}, workout,
        )
        if not replaced.modified_count:
            raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before editing.")
        response = self.receipt("workout", workout_id, workout["revision"], input.request_id, "set_added")
        response["workout"] = self._public(workout, ("account_id", "_id"))
        return await self._save_receipt(account_id, input.request_id, fingerprint, response)

    @transactional_mutation
    async def remove_set(self, account_id: str, workout_id: str, set_id: str, input: SetRemoveInput) -> dict[str, Any]:
        """Remove one unlogged set; a logged set is immutable history."""
        fingerprint = _fingerprint({"workout_id": workout_id, "set_id": set_id, **input.model_dump(mode="json")})
        prior = await self._receipt(account_id, input.request_id, fingerprint)
        if prior:
            return prior
        workout = await self._editable_workout(account_id, workout_id, input.expected_revision)
        item, set_row = self._find_set(workout, set_id)
        if set_row.get("actual") is not None:
            raise WorkoutDomainError("set_is_logged", "This set is logged and cannot be removed. Unlog it first.")
        item["sets"].remove(set_row)
        workout["status"] = self._workout_status(workout)
        workout["revision"], workout["updated_at"] = new_revision(), utc_now()
        replaced = await self.db.workouts.replace_one(
            {"account_id": account_id, "workout_id": workout_id, "revision": input.expected_revision}, workout,
        )
        if not replaced.modified_count:
            raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before editing.")
        response = self.receipt("workout", workout_id, workout["revision"], input.request_id, "set_removed")
        response["workout"] = self._public(workout, ("account_id", "_id"))
        return await self._save_receipt(account_id, input.request_id, fingerprint, response)

    @transactional_mutation
    async def update_set_target(self, account_id: str, workout_id: str, set_id: str, input: SetTargetInput) -> dict[str, Any]:
        """Replace one set target; optionally propagate it to later unlogged sets."""
        fingerprint = _fingerprint({"workout_id": workout_id, "set_id": set_id, **input.model_dump(mode="json")})
        prior = await self._receipt(account_id, input.request_id, fingerprint)
        if prior:
            return prior
        workout = await self._editable_workout(account_id, workout_id, input.expected_revision)
        item, set_row = self._find_set(workout, set_id)
        if set_row.get("actual") is not None:
            raise WorkoutDomainError("set_is_logged", "This set is logged and its target cannot change. Unlog it first.")
        target = input.target.model_dump(mode="json", exclude_none=True)
        set_row["target"] = target
        if input.apply_to_remaining:
            index = item["sets"].index(set_row)
            for later in item["sets"][index + 1:]:
                if later.get("actual") is None:
                    later["target"] = deepcopy(target)
        workout["status"] = self._workout_status(workout)
        workout["revision"], workout["updated_at"] = new_revision(), utc_now()
        replaced = await self.db.workouts.replace_one(
            {"account_id": account_id, "workout_id": workout_id, "revision": input.expected_revision}, workout,
        )
        if not replaced.modified_count:
            raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before editing.")
        response = self.receipt("workout", workout_id, workout["revision"], input.request_id, "set_target_updated")
        response["workout"] = self._public(workout, ("account_id", "_id"))
        return await self._save_receipt(account_id, input.request_id, fingerprint, response)

    @transactional_mutation
    async def remove_exercise(self, account_id: str, workout_id: str, exercise_instance_id: str, input: PlanEntryRemoveInput) -> dict[str, Any]:
        """Drop an instance's unlogged sets, keeping logged sets verbatim."""
        fingerprint = _fingerprint({"workout_id": workout_id, "exercise_instance_id": exercise_instance_id, **input.model_dump(mode="json")})
        prior = await self._receipt(account_id, input.request_id, fingerprint)
        if prior:
            return prior
        workout = await self._editable_workout(account_id, workout_id, input.expected_revision)
        target_segment: dict[str, Any] | None = None
        target_item: dict[str, Any] | None = None
        for segment in workout["segments"]:
            for item in segment["items"]:
                if item["exercise_instance_id"] == exercise_instance_id:
                    target_segment = segment
                    target_item = item
                    break
        if target_item is None or target_segment is None:
            raise WorkoutDomainError("exercise_instance_not_found", "Workout exercise was not found.", 404)
        target_item["sets"] = [set_row for set_row in target_item["sets"] if set_row.get("actual") is not None]
        if not target_item["sets"]:
            target_segment["items"].remove(target_item)
        if not target_segment["items"]:
            workout["segments"].remove(target_segment)
        return await self._replace_or_delete_workout(
            account_id, workout_id, input.expected_revision, input.request_id, fingerprint, "exercise_removed", workout,
        )

    @transactional_mutation
    async def remove_segment(self, account_id: str, workout_id: str, segment_id: str, input: PlanEntryRemoveInput) -> dict[str, Any]:
        """Apply the exercise rule to every item in a segment."""
        fingerprint = _fingerprint({"workout_id": workout_id, "segment_id": segment_id, **input.model_dump(mode="json")})
        prior = await self._receipt(account_id, input.request_id, fingerprint)
        if prior:
            return prior
        workout = await self._editable_workout(account_id, workout_id, input.expected_revision)
        target_segment: dict[str, Any] | None = None
        for segment in workout["segments"]:
            if segment["segment_id"] == segment_id:
                target_segment = segment
                break
        if target_segment is None:
            raise WorkoutDomainError("segment_not_found", "Workout segment was not found.", 404)
        for item in target_segment["items"]:
            item["sets"] = [set_row for set_row in item["sets"] if set_row.get("actual") is not None]
        target_segment["items"] = [item for item in target_segment["items"] if item["sets"]]
        if not target_segment["items"]:
            workout["segments"].remove(target_segment)
        return await self._replace_or_delete_workout(
            account_id, workout_id, input.expected_revision, input.request_id, fingerprint, "segment_removed", workout,
        )

    @transactional_mutation
    async def reorder_segments(self, account_id: str, workout_id: str, input: PlanReorderInput) -> dict[str, Any]:
        """Reorder the day's segments; items and every set stay verbatim."""
        fingerprint = _fingerprint({"workout_id": workout_id, **input.model_dump(mode="json")})
        prior = await self._receipt(account_id, input.request_id, fingerprint)
        if prior:
            return prior
        workout = await self._editable_workout(account_id, workout_id, input.expected_revision)
        by_id = {segment["segment_id"]: segment for segment in workout["segments"]}
        requested = input.segment_ids
        if len(requested) != len(by_id) or len(set(requested)) != len(requested) or set(requested) != set(by_id):
            raise WorkoutDomainError("reorder_mismatch", "Reorder must list every workout segment exactly once.", 422)
        workout["segments"] = [by_id[segment_id] for segment_id in requested]
        return await self._replace_or_delete_workout(
            account_id, workout_id, input.expected_revision, input.request_id, fingerprint, "segments_reordered", workout,
        )

    @transactional_mutation
    async def move_item(self, account_id: str, workout_id: str, exercise_instance_id: str, input: PlanItemMoveInput) -> dict[str, Any]:
        """Move one item to a new segment position; sets stay verbatim."""
        fingerprint = _fingerprint({"workout_id": workout_id, "exercise_instance_id": exercise_instance_id, **input.model_dump(mode="json")})
        prior = await self._receipt(account_id, input.request_id, fingerprint)
        if prior:
            return prior
        workout = await self._editable_workout(account_id, workout_id, input.expected_revision)
        source_segment: dict[str, Any] | None = None
        target_segment: dict[str, Any] | None = None
        item: dict[str, Any] | None = None
        for segment in workout["segments"]:
            if segment["segment_id"] == input.target_segment_id:
                target_segment = segment
            for candidate in segment["items"]:
                if candidate["exercise_instance_id"] == exercise_instance_id:
                    source_segment = segment
                    item = candidate
        if item is None or source_segment is None:
            raise WorkoutDomainError("exercise_instance_not_found", "Workout exercise was not found.", 404)
        if target_segment is None:
            raise WorkoutDomainError("segment_not_found", "Workout segment was not found.", 404)
        # The target index is the position in the target segment after the
        # source removal, so a same-segment move never counts the item twice.
        target_items = [candidate for candidate in target_segment["items"] if candidate is not item]
        if input.target_index > len(target_items) + 1:
            raise WorkoutDomainError("target_index_out_of_range", "The target position is outside the segment.", 422)
        source_segment["items"].remove(item)
        target_items.insert(input.target_index - 1, item)
        target_segment["items"] = target_items
        if not source_segment["items"]:
            workout["segments"].remove(source_segment)
        return await self._replace_or_delete_workout(
            account_id, workout_id, input.expected_revision, input.request_id, fingerprint, "item_moved", workout,
        )

    @transactional_mutation
    async def extract_item(self, account_id: str, workout_id: str, exercise_instance_id: str, input: PlanItemExtractInput) -> dict[str, Any]:
        """Move an item into its own non-circuit slot without changing its sets."""
        fingerprint = _fingerprint({"workout_id": workout_id, "exercise_instance_id": exercise_instance_id, **input.model_dump(mode="json")})
        prior = await self._receipt(account_id, input.request_id, fingerprint)
        if prior:
            return prior
        workout = await self._editable_workout(account_id, workout_id, input.expected_revision)
        source = next((segment for segment in workout["segments"] if any(
            item["exercise_instance_id"] == exercise_instance_id for item in segment["items"]
        )), None)
        if source is None:
            raise WorkoutDomainError("exercise_instance_not_found", "Workout exercise was not found.", 404)
        if input.before_segment_id is not None and not any(
            segment["segment_id"] == input.before_segment_id for segment in workout["segments"]
        ):
            raise WorkoutDomainError("segment_not_found", "Workout segment was not found.", 404)
        before_id = input.before_segment_id
        if before_id == source["segment_id"] and len(source["items"]) == 1:
            source_index = workout["segments"].index(source)
            before_id = (workout["segments"][source_index + 1]["segment_id"]
                         if source_index + 1 < len(workout["segments"]) else None)
        item = next(item for item in source["items"] if item["exercise_instance_id"] == exercise_instance_id)
        source["items"].remove(item)
        if not source["items"]:
            workout["segments"].remove(source)
        new_segment = {
            "segment_id": new_id("seg"), "order": 0, "kind": "straight_sets",
            "title": item["exercise_snapshot"]["name"], "rounds": 1,
            "rest_after_round_seconds": 0, "items": [item],
        }
        insert_at = next((index for index, segment in enumerate(workout["segments"])
                          if segment["segment_id"] == before_id), len(workout["segments"]))
        workout["segments"].insert(insert_at, new_segment)
        return await self._replace_or_delete_workout(
            account_id, workout_id, input.expected_revision, input.request_id, fingerprint, "item_extracted", workout,
        )

    @transactional_mutation
    async def update_notes(self, account_id: str, workout_id: str, input: WorkoutNotesInput) -> dict[str, Any]:
        """Store the typed day note on the workout record."""
        fingerprint = _fingerprint({"workout_id": workout_id, **input.model_dump(mode="json")})
        prior = await self._receipt(account_id, input.request_id, fingerprint)
        if prior:
            return prior
        workout = await self.db.workouts.find_one({"account_id": account_id, "workout_id": workout_id, "deleted_at": {"$exists": False}})
        if not workout:
            raise WorkoutDomainError("workout_not_found", "Workout was not found.", 404)
        if workout["revision"] != input.expected_revision:
            raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before editing notes.")
        workout["notes"] = input.notes
        workout["revision"], workout["updated_at"] = new_revision(), utc_now()
        replaced = await self.db.workouts.replace_one(
            {"account_id": account_id, "workout_id": workout_id, "revision": input.expected_revision}, workout,
        )
        if not replaced.modified_count:
            raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before editing notes.")
        response = self.receipt("workout", workout_id, workout["revision"], input.request_id, "notes_updated")
        response["workout"] = self._public(workout, ("account_id", "_id"))
        return await self._save_receipt(account_id, input.request_id, fingerprint, response)

    @transactional_mutation
    async def update_exercise_notes(self, account_id: str, workout_id: str, instance_id: str, input: ExerciseNoteInput) -> dict[str, Any]:
        """Store a typed feedback note on one workout exercise instance."""
        fingerprint = _fingerprint({"workout_id": workout_id, "exercise_instance_id": instance_id, **input.model_dump(mode="json")})
        prior = await self._receipt(account_id, input.request_id, fingerprint)
        if prior:
            return prior
        workout = await self.db.workouts.find_one({"account_id": account_id, "workout_id": workout_id, "deleted_at": {"$exists": False}})
        if not workout:
            raise WorkoutDomainError("workout_not_found", "Workout was not found.", 404)
        if workout["revision"] != input.expected_revision:
            raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before editing feedback.")
        target_item: dict[str, Any] | None = None
        for segment in workout["segments"]:
            for item in segment["items"]:
                if item["exercise_instance_id"] == instance_id:
                    target_item = item
                    break
        if not target_item:
            raise WorkoutDomainError("exercise_instance_not_found", "Workout exercise was not found.", 404)
        target_item["notes"] = {"note": input.note, "preset": input.preset, "updated_at": utc_now()}
        workout["revision"], workout["updated_at"] = new_revision(), utc_now()
        replaced = await self.db.workouts.replace_one(
            {"account_id": account_id, "workout_id": workout_id, "revision": input.expected_revision}, workout,
        )
        if not replaced.modified_count:
            raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before editing feedback.")
        response = self.receipt("workout", workout_id, workout["revision"], input.request_id, "feedback_updated")
        response["workout"] = self._public(workout, ("account_id", "_id"))
        return await self._save_receipt(account_id, input.request_id, fingerprint, response)

    @staticmethod
    def _candidate_target_summary(candidate: dict[str, Any]) -> str:
        """One-line target text for a slot candidate (instant swap picker)."""
        prescription = candidate.get("prescription", {})
        target = prescription.get("target", {})
        if prescription.get("metric") == "duration_seconds":
            window = target.get("duration_seconds") or {}
            unit, values = "s", (window.get("min"), window.get("max"))
        else:
            window = target.get("reps") or {}
            unit, values = " reps", (window.get("min"), window.get("max"))
        low, high = values
        if low is None or high is None:
            metric_text = "-"
        elif low == high:
            metric_text = f"{low}{unit}"
        else:
            metric_text = f"{low}-{high}{unit}"
        load = target.get("load")
        if isinstance(load, dict) and load.get("value") is not None and load.get("unit"):
            metric_text = f"{metric_text} · {load['value']:g}{load['unit']}"
        return metric_text

    async def exercise_repertoire(self, account_id: str, workout_id: str) -> dict[str, Any]:
        """Unique exercises from the active blueprint, preferring today's prescription."""
        workout = await self.workout(account_id, workout_id)
        blueprint = (await self.active_blueprint(account_id))["blueprint"]
        used = {item["exercise_snapshot"]["exercise_id"] for segment in workout["segments"] for item in segment["items"]}
        seen = set(blueprint.get("hard_constraints", {}).get("forbidden_exercise_ids", []))
        exercise_ids = {candidate["exercise_id"] for day in blueprint["days"] for segment in day["segments"]
                        for slot in segment["slots"] for candidate in slot["candidates"]}
        exercise_revisions = {candidate["exercise_revision"] for day in blueprint["days"] for segment in day["segments"]
                              for slot in segment["slots"] for candidate in slot["candidates"]}
        # One catalog read keeps opening the picker fast even for a full monthly plan.
        definitions = {(exercise["exercise_id"], exercise["revision"]): exercise for exercise in await self.db.exercises.find(
            {"account_id": account_id, "exercise_id": {"$in": list(exercise_ids)}, "revision": {"$in": list(exercise_revisions)}},
        ).to_list()}
        options = []
        for day in sorted(blueprint["days"], key=lambda day: (day["date"] != workout["date"], day["date"])):
            for segment in sorted(day["segments"], key=lambda segment: segment["order"]):
                for slot in sorted(segment["slots"], key=lambda slot: slot["order"]):
                    for candidate in sorted(slot["candidates"], key=lambda candidate: (candidate["priority"], candidate["candidate_id"])):
                        if candidate["exercise_id"] in seen:
                            continue
                        seen.add(candidate["exercise_id"])
                        exercise = await self._candidate_exercise(account_id, candidate, definitions)
                        targets = candidate["prescription"].get("round_targets") or [candidate["prescription"]["target"]]
                        summaries = [self._candidate_target_summary({"prescription": {**candidate["prescription"], "target": target}})
                                     for target in targets]
                        options.append({
                            "day_id": day["day_id"], "slot_id": slot["slot_id"], "candidate_id": candidate["candidate_id"],
                            "exercise_id": candidate["exercise_id"], "name": exercise["name"],
                            "equipment_kind": exercise.get("equipment_kind", ""),
                            "primary_muscles": exercise.get("primary_muscles", []),
                            "secondary_muscles": exercise.get("secondary_muscles", []),
                            "role": slot["role"], "day_title": day["title"], "section_title": segment.get("title") or "",
                            "sets": segment["rounds"], "target_summary": " / ".join(dict.fromkeys(summaries)),
                            "already_added": candidate["exercise_id"] in used,
                        })
        return {"workout_id": workout_id, "workout_revision": workout["revision"],
                "blueprint_id": blueprint["blueprint_id"], "blueprint_revision": blueprint["revision"],
                "candidates": sorted(options, key=lambda option: option["name"].casefold())}

    @transactional_mutation
    async def add_exercise(self, account_id: str, workout_id: str, input: ExerciseAddInput) -> dict[str, Any]:
        fingerprint = _fingerprint({"add_exercise": workout_id, **input.model_dump(mode="json")})
        prior = await self._receipt(account_id, input.request_id, fingerprint)
        if prior:
            return prior
        workout = await self._editable_workout(account_id, workout_id, input.expected_revision)
        blueprint = (await self.active_blueprint(account_id))["blueprint"]
        if blueprint["blueprint_id"] != input.blueprint_id or blueprint["revision"] != input.expected_blueprint_revision:
            raise WorkoutDomainError("stale_blueprint", "Your plan changed. Reopen Add exercise to use the current plan.")
        source = next(((day, segment, slot, candidate)
                       for day in blueprint["days"] if day["day_id"] == input.day_id
                       for segment in day["segments"]
                       for slot in segment["slots"] if slot["slot_id"] == input.slot_id
                       for candidate in slot["candidates"] if candidate["candidate_id"] == input.candidate_id), None)
        if source is None:
            raise WorkoutDomainError("add_candidate_not_found", "This exercise is no longer in your plan.", 422)
        day, segment, slot, candidate = source
        if candidate["exercise_id"] in blueprint.get("hard_constraints", {}).get("forbidden_exercise_ids", []):
            raise WorkoutDomainError("exercise_forbidden", "This exercise is excluded from your plan.", 422)
        if any(item["exercise_snapshot"]["exercise_id"] == candidate["exercise_id"]
               for existing in workout["segments"] for item in existing["items"]):
            raise WorkoutDomainError("exercise_already_added", "This exercise is already in this workout.")
        exercise = await self._candidate_exercise(account_id, candidate)
        snapshot = {key: exercise[key] for key in ("exercise_id", "name", "movement_pattern", "primary_muscles", "secondary_muscles", "equipment_kind", "laterality", "load_basis")}
        snapshot.update(exercise_revision=candidate["exercise_revision"], equipment_profile_id=candidate.get("equipment_profile_id"))
        # Copy the published prescription exactly, including distinct targets per round.
        targets = candidate["prescription"].get("round_targets") or [candidate["prescription"]["target"]] * segment["rounds"]
        load, _ = await self._progression_target(account_id, snapshot, candidate, targets, workout["date"], blueprint["start_date"])
        apply_progression_load = candidate["progression"]["kind"] == "double_progression" and candidate["progression"].get("phase", "build") == "build"
        sets = []
        for index, target in enumerate(targets, start=1):
            set_target = deepcopy(target)
            if apply_progression_load and load is not None:
                set_target["load"] = load
            sets.append({"set_id": new_id("set"), "kind": "work", "target": set_target, "actual": None, "round": index})
        item = {"exercise_instance_id": new_id("wex"), "slot_id": slot["slot_id"], "candidate_id": candidate["candidate_id"],
                "order": 1, "exercise_snapshot": snapshot, "cues_md": self._cues(candidate, exercise),
                "source_blueprint": {"blueprint_id": blueprint["blueprint_id"], "blueprint_revision": blueprint["revision"], "day_id": day["day_id"]},
                "progression_context": progression_context(candidate, len(targets), blueprint["start_date"], load),
                "sets": sets}
        workout["segments"].append({
            "segment_id": new_id("seg"), "order": len(workout["segments"]) + 1, "kind": "straight_sets",
            "title": exercise["name"], "rounds": len(targets),
            "rest_after_round_seconds": candidate["prescription"].get("rest_seconds", 0), "items": [item],
        })
        return await self._replace_or_delete_workout(
            account_id, workout_id, input.expected_revision, input.request_id, fingerprint, "exercise_added", workout,
        )

    async def _swap_context(
        self,
        account_id: str,
        workout_id: str,
        instance_id: str,
        expected_revision: str | None = None,
        expected_blueprint_revision: str | None = None,
    ) -> dict[str, Any]:
        """Resolve the workout item and its blueprint slot for a swap read or write."""
        workout = await self.db.workouts.find_one({"account_id": account_id, "workout_id": workout_id, "deleted_at": {"$exists": False}})
        if not workout:
            raise WorkoutDomainError("workout_not_found", "Workout was not found.", 404)
        if expected_revision is not None and workout["revision"] != expected_revision:
            raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before swapping.")
        target_item: dict[str, Any] | None = None
        target_segment: dict[str, Any] | None = None
        for segment in workout["segments"]:
            for item in segment["items"]:
                if item["exercise_instance_id"] == instance_id:
                    target_item = item
                    target_segment = segment
                    break
        if not target_item or target_segment is None:
            raise WorkoutDomainError("exercise_instance_not_found", "Workout exercise was not found.", 404)
        logged_sets = [set_row for set_row in target_item["sets"] if set_row.get("actual") is not None]
        open_sets = [set_row for set_row in target_item["sets"] if set_row.get("actual") is None]
        if not open_sets:
            raise WorkoutDomainError("completed_exercise_locked", "Every set of this exercise is logged; there is nothing left to swap.")
        active = await self.active_blueprint(account_id, None if target_item.get("source_blueprint") else workout["date"])
        blueprint = active["blueprint"]
        if expected_blueprint_revision and expected_blueprint_revision != blueprint["revision"]:
            raise WorkoutDomainError("stale_blueprint", "Blueprint changed. Pull the current blueprint before swapping.")
        lineage = target_item.get("source_blueprint") or workout.get("lineage", {})
        if (
            lineage.get("blueprint_id") != blueprint["blueprint_id"]
            or lineage.get("blueprint_revision") != blueprint["revision"]
        ):
            raise WorkoutDomainError("stale_blueprint", "Workout belongs to an older blueprint. Refresh it before swapping.")
        day = next((item for item in blueprint["days"] if item["day_id"] == lineage.get("day_id")), None)
        if not day:
            raise WorkoutDomainError("blueprint_day_missing", "The active blueprint no longer contains this workout day.")
        source_slot = next((slot for segment in day["segments"] for slot in segment["slots"] if slot["slot_id"] == target_item["slot_id"]), None)
        if not source_slot:
            raise WorkoutDomainError("blueprint_slot_missing", "The active blueprint no longer contains this workout slot.")
        used = {item["exercise_snapshot"]["exercise_id"] for segment in workout["segments"] for item in segment["items"]}
        candidates = [candidate for candidate in source_slot["candidates"] if candidate["exercise_id"] not in used or candidate["candidate_id"] == target_item["candidate_id"]]
        candidates = [candidate for candidate in candidates if candidate["candidate_id"] != target_item["candidate_id"]]
        if not candidates:
            raise WorkoutDomainError("no_eligible_swap", "No eligible candidate remains in this blueprint slot.")
        return {
            "workout": workout,
            "blueprint": blueprint,
            "source_slot": source_slot,
            "target_item": target_item,
            "target_segment": target_segment,
            "logged_sets": logged_sets,
            "open_sets": open_sets,
            "candidates": sorted(candidates, key=lambda item: (item["priority"], item["candidate_id"])),
        }

    async def swap_candidates(self, account_id: str, workout_id: str, instance_id: str) -> dict[str, Any]:
        """List the eligible in-slot alternatives for an instant swap picker.

        A deterministic read: same slot candidates the swap write accepts,
        ordered by blueprint priority. No selection is made here.
        """
        context = await self._swap_context(account_id, workout_id, instance_id)
        workout = context["workout"]
        blueprint = context["blueprint"]
        target_item = context["target_item"]
        options = []
        for candidate in context["candidates"]:
            exercise = await self._candidate_exercise(account_id, candidate)
            options.append({
                "candidate_id": candidate["candidate_id"],
                "exercise_id": candidate["exercise_id"],
                "name": exercise.get("name") or candidate["exercise_id"],
                "equipment_kind": exercise.get("equipment_kind") or "",
                "priority": candidate["priority"],
                "target_summary": self._candidate_target_summary(candidate),
                "rest_seconds": candidate.get("prescription", {}).get("rest_seconds", 0),
            })
        return {
            "workout_id": workout["workout_id"],
            "workout_revision": workout["revision"],
            "exercise_instance_id": instance_id,
            "slot_id": target_item["slot_id"],
            "current_candidate_id": target_item["candidate_id"],
            "current_exercise_name": target_item["exercise_snapshot"].get("name", ""),
            "blueprint_id": blueprint["blueprint_id"],
            "blueprint_revision": blueprint["revision"],
            "candidates": options,
        }

    @transactional_mutation
    async def swap(self, account_id: str, workout_id: str, instance_id: str, input: SwapInput) -> dict[str, Any]:
        fingerprint = _fingerprint({"workout_id": workout_id, "instance_id": instance_id, **input.model_dump(mode="json")})
        prior = await self._receipt(account_id, input.request_id, fingerprint)
        if prior:
            return prior
        context = await self._swap_context(
            account_id, workout_id, instance_id,
            expected_revision=input.expected_revision,
            expected_blueprint_revision=input.expected_blueprint_revision,
        )
        workout = context["workout"]
        active_blueprint = context["blueprint"]
        source_slot = context["source_slot"]
        target_item = context["target_item"]
        target_segment = context["target_segment"]
        logged_sets = context["logged_sets"]
        open_sets = context["open_sets"]
        candidates = context["candidates"]
        if input.target_candidate_id is not None:
            # The engine already chose from the slot (mini-chat top-3 pick).
            # The backend only validates the choice stays inside the same
            # blueprint slot and applies it deterministically.
            requested = next(
                (item for item in source_slot["candidates"] if item["candidate_id"] == input.target_candidate_id),
                None,
            )
            if requested is None:
                raise WorkoutDomainError("swap_target_not_in_slot", "The requested candidate is not in this blueprint slot.", 422)
            if requested["candidate_id"] == target_item["candidate_id"]:
                raise WorkoutDomainError("swap_target_unchanged", "The requested candidate is already the selected exercise.")
            if all(item["candidate_id"] != requested["candidate_id"] for item in candidates):
                raise WorkoutDomainError("swap_target_unavailable", "The requested candidate is already used elsewhere in this workout.")
            ordered = candidates
            candidate = requested
            probabilities = {item["candidate_id"]: (1.0 if item["candidate_id"] == candidate["candidate_id"] else 0.0) for item in ordered}
        else:
            index, probabilities = _decision_index(f"{workout_id}:{instance_id}:{input.request_id}", candidates, input.source)
            candidate = candidates[index]
        exercise = await self._candidate_exercise(account_id, candidate)
        snapshot = {key: exercise[key] for key in ("exercise_id", "revision", "name", "movement_pattern", "primary_muscles", "secondary_muscles", "equipment_kind", "laterality", "load_basis")}
        snapshot["exercise_revision"] = snapshot.pop("revision")
        snapshot["equipment_profile_id"] = candidate.get("equipment_profile_id")
        targets = candidate["prescription"].get("round_targets") or [candidate["prescription"]["target"]] * target_segment["rounds"]
        load, load_decision = await self._progression_target(account_id, snapshot, candidate, targets, workout["date"], active_blueprint["start_date"])
        new_sets = []
        for set_row in open_sets:
            round_number = set_row.get("round", 1)
            target = dict(targets[min(max(round_number, 1), len(targets)) - 1])
            new_sets.append({"set_id": new_id("set"), "kind": set_row.get("kind", "work"),
                             "target": {**target, **({"load": load} if load else {})}, "actual": None, "round": round_number})
        if logged_sets:
            # A logged set is immutable history: it keeps its original exercise
            # snapshot, target and actual, and the swap continues under a new
            # exercise instance for the sets that are still open.
            target_item["sets"] = logged_sets
            replacement = {"exercise_instance_id": new_id("wex"), "slot_id": target_item["slot_id"], "candidate_id": candidate["candidate_id"],
                           "order": target_item["order"] + 1, "exercise_snapshot": snapshot, "sets": new_sets, "cues_md": self._cues(candidate, exercise),
                           "progression_context": {**progression_context(candidate, len(targets), active_blueprint["start_date"], load), "partial": True}}
            if target_item.get("source_blueprint"):
                replacement["source_blueprint"] = deepcopy(target_item["source_blueprint"])
            position = target_segment["items"].index(target_item) + 1
            target_segment["items"].insert(position, replacement)
            for index, item in enumerate(target_segment["items"]):
                item["order"] = index + 1
        else:
            # Feedback describes the substituted exercise; a different
            # exercise must not inherit it.
            target_item.pop("notes", None)
            target_item.update({"candidate_id": candidate["candidate_id"], "exercise_snapshot": snapshot, "cues_md": self._cues(candidate, exercise),
                                "sets": new_sets, "progression_context": progression_context(candidate, len(targets), active_blueprint["start_date"], load)})
        workout["status"] = self._workout_status(workout)
        workout["revision"], workout["updated_at"] = new_revision(), utc_now()
        workout["lineage"].setdefault("swaps", []).append({
            "exercise_instance_id": instance_id,
            "reason": input.reason,
            "source": input.source,
            "candidate_id": candidate["candidate_id"],
            **({"target_candidate_id": input.target_candidate_id} if input.target_candidate_id is not None else {}),
            "blueprint_id": active_blueprint["blueprint_id"],
            "blueprint_revision": active_blueprint["revision"],
            "probabilities": probabilities,
            "load": load_decision,
        })
        replaced = await self.db.workouts.replace_one({"account_id": account_id, "workout_id": workout_id, "revision": input.expected_revision}, workout)
        if not replaced.modified_count:
            raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before swapping.")
        response = self.receipt("workout", workout_id, workout["revision"], input.request_id, "swapped")
        response["workout"] = self._public(workout, ("account_id", "_id"))
        return await self._save_receipt(account_id, input.request_id, fingerprint, response)

    @transactional_mutation
    async def override(self, account_id: str, input: WorkoutOverrideInput, actor: dict[str, Any]) -> dict[str, Any]:
        """Apply a typed agent exception day, preserving logged sets and lineage."""
        fingerprint = _fingerprint({"override": input.model_dump(mode="json")})
        prior = await self._receipt(account_id, input.request_id, fingerprint)
        if prior:
            return prior
        current = await self.db.workouts.find_one({"account_id": account_id, "date": input.date, "deleted_at": {"$exists": False}})
        if not current and input.expected_revision is not None:
            raise WorkoutDomainError("invalid_workout_revision", "A new override cannot declare an expected revision.", 422)
        if current and input.expected_revision is not None and current["revision"] != input.expected_revision:
            raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before overriding.")
        target_revision = current["revision"] if current else None
        # Logged sets are immutable history. A replacement day only owns the
        # unlogged remainder, so a partially logged workout keeps its logged
        # sets under their original exercise snapshots.
        preserved_segments: list[dict[str, Any]] = []
        if current:
            for segment in current["segments"]:
                preserved_items = [
                    {**item, "sets": [set_row for set_row in item["sets"] if set_row.get("actual") is not None]}
                    for item in segment["items"]
                ]
                preserved_items = [item for item in preserved_items if item["sets"]]
                if preserved_items:
                    preserved_segments.append({**segment, "items": preserved_items})
        # An exception can target a date that the current blueprint does not
        # cover. The active blueprint still supplies timezone and hard
        # constraints, while the exception owns the target day's structure.
        active = await self.active_blueprint(account_id)
        blueprint = active["blueprint"]
        forbidden = set(blueprint.get("hard_constraints", {}).get("forbidden_exercise_ids", []))
        requested = {candidate.exercise_id for segment in input.segments for slot in segment.slots for candidate in slot.candidates}
        if forbidden & requested:
            raise WorkoutDomainError("override_hard_constraint", "An agent override cannot use a hard-forbidden exercise.", 422)
        blueprint_day = next((item for item in blueprint["days"] if item["date"] == input.date), None)
        day = {
            # Keep the canonical day identity when an exception targets a date
            # covered by the active blueprint. This lets a later in-blueprint
            # swap remain constrained to that day/slot; out-of-period exception
            # days stay explicitly synthetic and cannot masquerade as a slot map.
            "day_id": blueprint_day["day_id"] if blueprint_day else f"day_agent_override_{input.date.replace('-', '_')}",
            "date": input.date,
            "title": input.title,
            "segments": [segment.model_dump(mode="json") for segment in input.segments],
        }
        materialized = await self._materialize(
            account_id, blueprint, day,
            GenerateInput(date=input.date, source="default", request_id=input.request_id),
        )
        if current:
            old_open_items = [item for segment in current["segments"] for item in segment["items"]
                              if any(set_row.get("actual") is None for set_row in item["sets"])]
            new_items = [item for segment in materialized["segments"] for item in segment["items"]]
            old_counts = Counter(item["exercise_snapshot"]["exercise_id"] for item in old_open_items)
            new_counts = Counter(item["exercise_snapshot"]["exercise_id"] for item in new_items)
            removed, added = old_counts - new_counts, new_counts - old_counts
            # A one-for-one agent replacement remains the same logical slot,
            # even when its complete override artifact used a fresh slot ID.
            # The native mini-chat can then continue with the new exercise.
            if sum(removed.values()) == sum(added.values()) == 1:
                removed_id, added_id = next(iter(removed)), next(iter(added))
                if old_counts[removed_id] == new_counts[added_id] == 1:
                    old_item = next(item for item in old_open_items
                                    if item["exercise_snapshot"]["exercise_id"] == removed_id)
                    new_item = next(item for item in new_items
                                    if item["exercise_snapshot"]["exercise_id"] == added_id)
                    old_slot_id = old_item.get("slot_id")
                    if (old_slot_id
                            and sum(item.get("slot_id") == old_slot_id for item in old_open_items) == 1
                            and not any(item is not new_item and item.get("slot_id") == old_slot_id for item in new_items)):
                        new_item["slot_id"] = old_slot_id
        if preserved_segments:
            for segment in materialized["segments"]:
                for item in segment["items"]:
                    item["progression_context"]["partial"] = True
            used_segment_ids = {segment["segment_id"] for segment in preserved_segments}
            for segment in materialized["segments"]:
                original_id = segment["segment_id"]
                suffix = 2
                while segment["segment_id"] in used_segment_ids:
                    segment["segment_id"] = f"{original_id}_{suffix}"
                    suffix += 1
                used_segment_ids.add(segment["segment_id"])
            materialized["segments"] = preserved_segments + materialized["segments"]
            materialized["status"] = "in_progress"
        timestamp = utc_now()
        materialized["lineage"] = {
            **materialized["lineage"],
            "source": "agent_override",
            "override": {
                "reason_md": input.reason_md,
                "agent_job_id": actor.get("job_id"),
                "replaced_revision": current.get("revision") if current else None,
            },
        }
        if current:
            materialized["workout_id"] = current["workout_id"]
            materialized["created_at"] = current["created_at"]
            # A day note belongs to the target date, not to the replaced
            # exercise selection; keep it while the override owns the day.
            materialized["notes"] = current.get("notes", "")
        materialized["revision"] = new_revision()
        materialized["updated_at"] = timestamp
        if current:
            result = await self.db.workouts.replace_one(
                {"account_id": account_id, "workout_id": current["workout_id"], "revision": target_revision}, materialized,
            )
            if not result.modified_count:
                raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before overriding.")
        else:
            try:
                await self.db.workouts.insert_one(materialized)
            except DuplicateKeyError:
                raise WorkoutDomainError("stale_revision", "A workout was created concurrently. Pull it before overriding.") from None
        response = self.receipt("workout", materialized["workout_id"], materialized["revision"], input.request_id, "agent_override")
        response["workout"] = self._public(materialized, ("account_id", "_id"))
        return await self._save_receipt(account_id, input.request_id, fingerprint, response)

    @staticmethod
    def _has_logged_sets(workout: dict[str, Any]) -> bool:
        return any(
            set_row.get("actual") is not None
            for segment in workout.get("segments", [])
            for item in segment["items"]
            for set_row in item["sets"]
        )

    @transactional_mutation
    async def copy_last_week(self, account_id: str, input: CopyLastWeekInput) -> dict[str, Any]:
        """Copy the same weekday seven days earlier as fresh planned structure.

        Only the segment/item shape, snapshots and targets travel; every set is
        unlogged and every id is new. A target day that owns logged history is
        never replaced.
        """
        try:
            source_date = shift_date(input.date, -7)
        except ValueError:
            raise WorkoutDomainError("invalid_date", "date must be a valid calendar date.", 422) from None
        fingerprint = _fingerprint({"date": input.date, "source_date": source_date, "expected_revision": input.expected_revision})
        prior = await self._receipt(account_id, input.request_id, fingerprint)
        if prior:
            return prior
        source = await self.db.workouts.find_one({"account_id": account_id, "date": source_date, "deleted_at": {"$exists": False}})
        if not source:
            raise WorkoutDomainError("copy_source_missing", f"No workout was saved for {source_date}.", 404)
        current = await self.db.workouts.find_one({"account_id": account_id, "date": input.date, "deleted_at": {"$exists": False}})
        if input.expected_revision is not None and (not current or current["revision"] != input.expected_revision):
            raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before copying.")
        if current and self._has_logged_sets(current):
            raise WorkoutDomainError("workout_has_logged_sets", "This day has logged sets and cannot be replaced.")
        timestamp = utc_now()
        segments: list[dict[str, Any]] = []
        for segment in source["segments"]:
            items: list[dict[str, Any]] = []
            for item in segment["items"]:
                sets = [
                    {"set_id": new_id("set"), "kind": set_row.get("kind", "work"), "target": deepcopy(set_row["target"]),
                     "actual": None, "round": set_row.get("round", 1)}
                    for set_row in item["sets"]
                ]
                items.append({
                    "exercise_instance_id": new_id("wex"),
                    "slot_id": item["slot_id"],
                    "candidate_id": item["candidate_id"],
                    "order": item["order"],
                    **({"progression_context": deepcopy(item["progression_context"])} if item.get("progression_context") else {}),
                    "exercise_snapshot": deepcopy(item["exercise_snapshot"]),
                    "sets": sets,
                    "cues_md": item.get("cues_md", ""),
                    **({"source_blueprint": deepcopy(item["source_blueprint"])} if item.get("source_blueprint") else {}),
                })
            segment_copy: dict[str, Any] = {
                "segment_id": new_id("seg"),
                "order": segment["order"],
                "kind": segment["kind"],
                "rounds": segment["rounds"],
                "rest_after_round_seconds": segment["rest_after_round_seconds"],
                "items": items,
            }
            # A segment label is part of the copied shape: imported legacy days
            # carry their circuit/section name, and dropping it would merge
            # distinct circuits under one generic label in the app.
            if segment.get("title"):
                segment_copy["title"] = segment["title"]
            segments.append(segment_copy)
        source_lineage = source.get("lineage", {})
        source_kind: LineageSource = "copy_last_week"
        lineage: dict[str, Any] = {
            "source": source_kind,
            "copied_from": {"workout_id": source["workout_id"], "date": source["date"], "revision": source["revision"]},
        }
        # Keep the canonical blueprint identity so an in-blueprint swap can
        # still resolve this day; exceptional-day metadata never travels.
        for key in ("blueprint_id", "blueprint_revision", "day_id"):
            if source_lineage.get(key):
                lineage[key] = source_lineage[key]
        document = {
            "account_id": account_id,
            "workout_id": current["workout_id"] if current else new_id("wrk"),
            "schema_version": SCHEMA_VERSION,
            "revision": new_revision(),
            "date": input.date,
            "timezone": source["timezone"],
            "status": "planned",
            "title": source["title"],
            "segments": segments,
            "lineage": lineage,
            "created_at": current["created_at"] if current else timestamp,
            "updated_at": timestamp,
        }
        if current:
            replaced = await self.db.workouts.replace_one(
                {"account_id": account_id, "workout_id": document["workout_id"], "revision": current["revision"]}, document,
            )
            if not replaced.modified_count:
                raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before copying.")
        else:
            try:
                await self.db.workouts.insert_one(document)
            except DuplicateKeyError:
                raise WorkoutDomainError("stale_revision", "A workout was created concurrently. Pull it before copying.") from None
        response = self.receipt("workout", document["workout_id"], document["revision"], input.request_id, "copied")
        response["workout"] = self._public(document, ("account_id", "_id"))
        return await self._save_receipt(account_id, input.request_id, fingerprint, response)

    @transactional_mutation
    async def clear_workout(self, account_id: str, workout_id: str, input: ClearWorkoutInput) -> dict[str, Any]:
        """Remove every unlogged set and exercise, never a logged one.

        Logged sets stay verbatim under their original exercise snapshots. When
        nothing logged remains, the workout record itself is removed and the
        receipt carries ``workout: null``.
        """
        fingerprint = _fingerprint({"workout_id": workout_id, **input.model_dump(mode="json")})
        prior = await self._receipt(account_id, input.request_id, fingerprint)
        if prior:
            return prior
        workout = await self.db.workouts.find_one({"account_id": account_id, "workout_id": workout_id, "deleted_at": {"$exists": False}})
        if not workout:
            raise WorkoutDomainError("workout_not_found", "Workout was not found.", 404)
        if workout["revision"] != input.expected_revision:
            raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before clearing.")
        preserved_segments: list[dict[str, Any]] = []
        for segment in workout["segments"]:
            preserved_items = [
                {**item, "sets": [set_row for set_row in item["sets"] if set_row.get("actual") is not None]}
                for item in segment["items"]
            ]
            preserved_items = [item for item in preserved_items if item["sets"]]
            if preserved_items:
                preserved_segments.append({**segment, "items": preserved_items})
        timestamp = utc_now()
        if not preserved_segments:
            deleted = await self.db.workouts.delete_one(
                {"account_id": account_id, "workout_id": workout_id, "revision": input.expected_revision},
            )
            if not deleted.deleted_count:
                raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before clearing.")
            response = self.receipt("workout", workout_id, input.expected_revision, input.request_id, "cleared")
            response["workout"] = None
            return await self._save_receipt(account_id, input.request_id, fingerprint, response)
        workout["segments"] = preserved_segments
        workout["status"] = self._workout_status(workout)
        workout["revision"], workout["updated_at"] = new_revision(), timestamp
        replaced = await self.db.workouts.replace_one(
            {"account_id": account_id, "workout_id": workout_id, "revision": input.expected_revision}, workout,
        )
        if not replaced.modified_count:
            raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before clearing.")
        response = self.receipt("workout", workout_id, workout["revision"], input.request_id, "cleared")
        response["workout"] = self._public(workout, ("account_id", "_id"))
        return await self._save_receipt(account_id, input.request_id, fingerprint, response)

    async def history(self, account_id: str, exercise_id: str, before: str | None = None, limit: int = 10) -> list[dict[str, Any]]:
        prefix = f"{regex_escape(exercise_id)}\\|"
        query: dict[str, Any] = {
            "account_id": account_id,
            "$or": [
                {"exercise_id": exercise_id},
                {"load_key": {"$regex": f"^{prefix}"}},
            ],
        }
        if before:
            query["date"] = {"$lte": before}
        rows = await self.db.performance_index.find(query).sort("completed_at", DESCENDING).limit(min(max(limit, 1), 50)).to_list()
        return [self._public(row, ("account_id", "_id", "load_key")) for row in rows]

    async def related_history(self, account_id: str, exercise_id: str, limit: int = 20) -> dict[str, Any]:
        """Exact history plus related moves from the same movement pattern and muscle."""
        bounded = min(max(limit, 1), 50)
        head = await self.db.exercise_heads.find_one({"account_id": account_id, "exercise_id": exercise_id})
        if not head:
            raise WorkoutDomainError("exercise_not_found", "Exercise was not found.", 404)
        document = await self.db.exercises.find_one({
            "account_id": account_id, "exercise_id": exercise_id, "revision": head["revision"],
        }) or {}
        pattern = str(document.get("movement_pattern") or "")
        muscles = [str(muscle) for muscle in (document.get("primary_muscles") or []) if muscle]
        exact = await self.history(account_id, exercise_id, None, bounded)
        family: list[dict[str, Any]] = []
        if pattern and pattern != "general":
            family = await self._history_rows(
                account_id, {"exercise_id": {"$ne": exercise_id}, "movement_pattern": pattern}, bounded,
            )
        muscle_rows: list[dict[str, Any]] = []
        if muscles:
            muscle_rows = await self._history_rows(
                account_id, {"exercise_id": {"$ne": exercise_id}, "primary_muscles": muscles[0]}, bounded,
            )
        family_sets = {row["set_id"] for row in family}
        muscle_rows = [row for row in muscle_rows if row["set_id"] not in family_sets]
        return {
            "exercise_id": exercise_id,
            "movement_pattern": pattern or None,
            "primary_muscle": muscles[0] if muscles else None,
            "exact": exact,
            "family": family,
            "muscle": muscle_rows,
        }

    async def _history_rows(self, account_id: str, extra: dict[str, Any], limit: int) -> list[dict[str, Any]]:
        query = {"account_id": account_id, **extra}
        rows = await self.db.performance_index.find(query).sort("completed_at", DESCENDING).limit(limit).to_list()
        return [self._public(row, ("account_id", "_id", "load_key")) for row in rows]

    @staticmethod
    def _public(document: dict[str, Any], hidden: tuple[str, ...]) -> dict[str, Any]:
        return {key: value for key, value in document.items() if key not in hidden}
