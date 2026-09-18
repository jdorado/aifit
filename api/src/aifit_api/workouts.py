"""End-state workout domain: typed records, releases, generation and history.

The module deliberately knows nothing about FastAPI or Ez. Browser and agent routes
call the same service so neither transport can create a second workout contract.
"""

from __future__ import annotations

from collections import defaultdict
from datetime import UTC, datetime
from hashlib import sha256
from typing import Any, Literal
from uuid import uuid4

from pydantic import BaseModel, ConfigDict, Field, model_validator
from pymongo import ASCENDING, DESCENDING, ReturnDocument
from pymongo.errors import DuplicateKeyError


SCHEMA_VERSION = 1
SEGMENT_KINDS = {"warmup", "straight_sets", "superset", "circuit", "interval", "mobility", "cooldown"}
LOAD_BASES = {"total", "per_side", "per_hand", "machine_stack", "bodyweight", "assisted", "band_level"}


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

    @model_validator(mode="after")
    def valid_policy(self) -> "Progression":
        if self.kind == "none":
            if any(value is not None for value in (self.increase_when, self.increment, self.load_range)):
                raise ValueError("progression kind none cannot define load progression fields")
            return self
        if self.increase_when is None or self.increment is None or self.load_range is None:
            raise ValueError("double_progression requires increase_when, increment and load_range")
        lower, upper = self.load_range
        if lower.unit != upper.unit or lower.unit != self.increment.unit or lower.value > upper.value:
            raise ValueError("progression quantities must use one ordered unit")
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
    mode: Literal["default", "varied"] = "default"
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")


class SwapInput(StrictModel):
    mode: Literal["default", "varied"] = "default"
    reason: str = Field(min_length=1, max_length=500)
    expected_revision: str = Field(pattern=r"^rev_[a-f0-9]{32}$")
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")


class WorkoutOverrideInput(StrictModel):
    """A deliberately exceptional, agent-authored day outside a blueprint slot."""

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


def exercise_load_key(snapshot: dict[str, Any]) -> str:
    return "|".join([
        str(snapshot.get("exercise_id", "")),
        str(snapshot.get("equipment_profile_id", "")),
        str(snapshot.get("load_basis", "")),
        str(snapshot.get("laterality", "")),
    ])


def _decision_index(seed: str, candidates: list[dict[str, Any]], mode: str) -> tuple[int, dict[str, float]]:
    ordered = sorted(candidates, key=lambda item: (item["priority"], item["candidate_id"]))
    if mode == "default" or len(ordered) == 1:
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


class WorkoutService:
    """Canonical persistence service for end-state workout records."""

    def __init__(self, database: Any):
        self.db = database

    async def ensure_indexes(self) -> None:
        await self.db.profiles.create_index([("account_id", ASCENDING)], unique=True)
        await self.db.exercises.create_index([("account_id", ASCENDING), ("exercise_id", ASCENDING), ("revision", ASCENDING)], unique=True)
        await self.db.exercise_heads.create_index([("account_id", ASCENDING), ("exercise_id", ASCENDING)], unique=True)
        await self.db.plans.create_index([("account_id", ASCENDING), ("plan_id", ASCENDING), ("revision", ASCENDING)], unique=True)
        await self.db.blueprints.create_index([("account_id", ASCENDING), ("blueprint_id", ASCENDING), ("revision", ASCENDING)], unique=True)
        await self.db.releases.create_index([("account_id", ASCENDING), ("release_id", ASCENDING)], unique=True)
        await self.db.program_state.create_index([("account_id", ASCENDING)], unique=True)
        await self.db.workouts.create_index([("account_id", ASCENDING), ("date", ASCENDING)], unique=True)
        await self.db.performance_index.create_index([("account_id", ASCENDING), ("load_key", ASCENDING), ("completed_at", DESCENDING)])
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
            existing = await self._receipt(account_id, request_id, fingerprint)
            if existing is None:
                raise
            return existing

    @staticmethod
    def receipt(resource: str, resource_id: str, revision: str, request_id: str, effect: str = "saved") -> dict[str, Any]:
        return {"status": "saved", "resource": resource, "resource_id": resource_id, "revision": revision,
                "request_id": request_id, "effect": effect, "updated_at": utc_now()}

    async def profile(self, account_id: str) -> dict[str, Any]:
        existing = await self.db.profiles.find_one({"account_id": account_id})
        if existing:
            return self._public(existing, ("account_id",))
        return {"profile_id": new_id("prof"), "schema_version": SCHEMA_VERSION, "revision": None, "content_md": "", "updated_at": None}

    async def put_profile(self, account_id: str, content_md: str, expected_revision: str | None, request_id: str, actor: dict[str, Any]) -> dict[str, Any]:
        fingerprint = _fingerprint({"profile": content_md, "expected_revision": expected_revision, "actor": actor})
        prior = await self._receipt(account_id, request_id, fingerprint)
        if prior:
            return prior
        current = await self.db.profiles.find_one({"account_id": account_id})
        current_revision = current.get("revision") if current else None
        if current_revision != expected_revision:
            raise WorkoutDomainError("stale_revision", "The profile changed. Pull its current revision before editing.")
        timestamp, revision = utc_now(), new_revision()
        document = {"account_id": account_id, "profile_id": current.get("profile_id") if current else new_id("prof"),
                    "schema_version": SCHEMA_VERSION, "revision": revision, "content_md": content_md,
                    "updated_at": timestamp, "updated_by": actor, "created_at": current.get("created_at", timestamp) if current else timestamp}
        await self.db.profiles.replace_one({"account_id": account_id}, document, upsert=True)
        return await self._save_receipt(account_id, request_id, fingerprint, self.receipt("profile", document["profile_id"], revision, request_id))

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
        await self._validate_blueprint_exercises(account_id, input)
        identifier, revision, timestamp = blueprint_id or new_id("bp"), new_revision(), utc_now()
        document = {"account_id": account_id, "blueprint_id": identifier, "revision": revision, "schema_version": SCHEMA_VERSION,
                    "status": "draft", "created_at": timestamp, "updated_at": timestamp, "updated_by": actor, **input.model_dump(mode="json")}
        await self.db.blueprints.insert_one(document)
        return await self._save_receipt(account_id, request_id, fingerprint, self.receipt("blueprint", identifier, revision, request_id))

    async def _validate_blueprint_exercises(self, account_id: str, input: BlueprintInput) -> None:
        await self._validate_candidates(account_id, [
            candidate for day in input.days for segment in day.segments for slot in segment.slots for candidate in slot.candidates
        ])

    async def _validate_candidates(self, account_id: str, candidates: list[Candidate]) -> None:
        for candidate in candidates:
            document = await self.db.exercises.find_one({"account_id": account_id, "exercise_id": candidate.exercise_id, "revision": candidate.exercise_revision})
            if not document:
                raise WorkoutDomainError("exercise_revision_not_found", f"Blueprint references unavailable exercise {candidate.exercise_id}.", 422)
            if candidate.prescription.metric not in document["metrics"]:
                raise WorkoutDomainError("exercise_metric_mismatch", f"{candidate.exercise_id} does not support this prescription metric.", 422)

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
        await self.db.program_state.find_one_and_update({"account_id": account_id}, {"$set": {"account_id": account_id, "active_release_id": release_id, "updated_at": timestamp}}, upsert=True)
        await self.db.plans.update_one({"account_id": account_id, "plan_id": input.plan_id, "revision": input.plan_revision}, {"$set": {"status": "published"}})
        await self.db.blueprints.update_one({"account_id": account_id, "blueprint_id": input.blueprint_id, "revision": input.blueprint_revision}, {"$set": {"status": "published"}})
        return await self._save_receipt(account_id, input.request_id, fingerprint, self.receipt("program_release", release_id, input.blueprint_revision, input.request_id, "published"))

    async def active_release(self, account_id: str, date: str | None = None) -> dict[str, Any]:
        state = await self.db.program_state.find_one({"account_id": account_id})
        if not state:
            raise WorkoutDomainError("active_program_missing", "No published program release is active.", 404)
        release = await self.db.releases.find_one({"account_id": account_id, "release_id": state["active_release_id"]})
        if not release:
            raise WorkoutDomainError("active_program_missing", "Active program release is unavailable.", 404)
        if date and not (release["effective_from"] <= date <= release["effective_through"]):
            raise WorkoutDomainError("program_date_uncovered", "The active program does not cover this date.")
        blueprint = await self.db.blueprints.find_one({"account_id": account_id, "blueprint_id": release["blueprint_id"], "revision": release["blueprint_revision"]})
        plan = await self.db.plans.find_one({"account_id": account_id, "plan_id": release["plan_id"], "revision": release["plan_revision"]})
        return {"release": self._public(release, ("account_id", "_id")), "plan": self._public(plan, ("account_id", "_id")), "blueprint": self._public(blueprint, ("account_id", "_id"))}

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
        active = await self.active_release(account_id, input.date)
        release, blueprint = active["release"], active["blueprint"]
        day = next((item for item in blueprint["days"] if item["date"] == input.date), None)
        if not day:
            raise WorkoutDomainError("blueprint_day_missing", "The active blueprint has no day for this date.")
        workout = await self._materialize(account_id, release, blueprint, day, input)
        try:
            await self.db.workouts.insert_one(workout)
        except DuplicateKeyError:
            current = await self.db.workouts.find_one({"account_id": account_id, "date": input.date})
            if not current:
                raise
            workout = current
        response = self.receipt("workout", workout["workout_id"], workout["revision"], input.request_id, "generated")
        response["workout"] = self._public(workout, ("account_id", "_id"))
        return await self._save_receipt(account_id, input.request_id, fingerprint, response)

    async def _materialize(self, account_id: str, release: dict[str, Any], blueprint: dict[str, Any], day: dict[str, Any], input: GenerateInput) -> dict[str, Any]:
        segments: list[dict[str, Any]] = []
        selected_exercises: set[str] = set()
        decisions: list[dict[str, Any]] = []
        for segment in sorted(day.get("segments", []), key=lambda item: item["order"]):
            items: list[dict[str, Any]] = []
            for slot in sorted(segment["slots"], key=lambda item: item["order"]):
                available = [candidate for candidate in slot["candidates"] if candidate["exercise_id"] not in selected_exercises]
                if len(available) < slot["selection_count"]:
                    raise WorkoutDomainError("slot_unfillable", f"Slot {slot['slot_id']} has no unique eligible selection.")
                for pick in range(slot["selection_count"]):
                    index, probabilities = _decision_index(f"{release['release_id']}:{input.date}:{slot['slot_id']}:{pick}:{input.request_id}", available, input.mode)
                    candidate = sorted(available, key=lambda item: (item["priority"], item["candidate_id"]))[index]
                    available = [item for item in available if item["candidate_id"] != candidate["candidate_id"]]
                    selected_exercises.add(candidate["exercise_id"])
                    exercise = await self.exercise(account_id, candidate["exercise_id"], candidate["exercise_revision"])
                    snapshot = {key: exercise[key] for key in ("exercise_id", "revision", "name", "movement_pattern", "primary_muscles", "secondary_muscles", "equipment_kind", "laterality", "load_basis")}
                    snapshot["exercise_revision"] = snapshot.pop("revision")
                    snapshot["equipment_profile_id"] = candidate.get("equipment_profile_id")
                    targets = candidate["prescription"].get("round_targets") or [candidate["prescription"]["target"]] * segment["rounds"]
                    load, load_decision = await self._progression_target(account_id, snapshot, candidate, targets[-1])
                    sets = []
                    for round_index, target in enumerate(targets):
                        target = dict(target)
                        if load is not None:
                            target["load"] = load
                        sets.append({"set_id": new_id("set"), "kind": "work", "target": target, "actual": None, "round": round_index + 1})
                    instance_id = new_id("wex")
                    items.append({"exercise_instance_id": instance_id, "slot_id": slot["slot_id"], "candidate_id": candidate["candidate_id"], "order": len(items) + 1,
                                  "exercise_snapshot": snapshot, "sets": sets, "cues_md": self._cues(candidate, exercise)})
                    decisions.append({"slot_id": slot["slot_id"], "candidate_id": candidate["candidate_id"], "mode": input.mode,
                                      "probabilities": probabilities, "load": load_decision})
            segments.append({"segment_id": segment["segment_id"], "order": segment["order"], "kind": segment["kind"], "rounds": segment["rounds"],
                             "rest_after_round_seconds": segment["rest_after_round_seconds"], "items": items})
        timestamp = utc_now()
        return {"account_id": account_id, "workout_id": new_id("wrk"), "schema_version": SCHEMA_VERSION, "revision": new_revision(),
                "date": day["date"], "timezone": blueprint["timezone"], "status": "planned", "title": day["title"], "segments": segments,
                "lineage": {"source": input.mode, "release_id": release["release_id"], "blueprint_id": blueprint["blueprint_id"],
                            "blueprint_revision": blueprint["revision"], "day_id": day["day_id"], "decision_receipt": {"engine": "bounded_ranker_v1", "selections": decisions}},
                "created_at": timestamp, "updated_at": timestamp}

    @staticmethod
    def _cues(candidate: dict[str, Any], exercise: dict[str, Any]) -> str:
        tempo = candidate["prescription"].get("tempo")
        tempo_text = ""
        if tempo:
            tempo_text = f" Tempo: {tempo['eccentric_seconds']} sec eccentric, {tempo['pause_seconds']} sec pause, {tempo['concentric_seconds']} sec concentric."
        return f"{exercise['instructions_md']}{tempo_text}"

    async def _progression_target(self, account_id: str, snapshot: dict[str, Any], candidate: dict[str, Any], target: dict[str, Any]) -> tuple[dict[str, Any] | None, dict[str, Any]]:
        policy = candidate["progression"]
        target_load = target.get("load")
        if policy["kind"] == "none":
            return target_load, {"decision": "blueprint_target", "reason": "Candidate has no automatic progression."}
        load_key = exercise_load_key(snapshot)
        history = await self.db.performance_index.find({"account_id": account_id, "load_key": load_key}).sort("completed_at", DESCENDING).limit(20).to_list()
        lower, upper = policy["load_range"]
        if not history:
            initial = target_load or lower
            return initial, {"decision": "initialize", "reason": "No exact compatible completed history.", "load_key": load_key}
        latest_workout = history[0]["workout_id"]
        latest_sets = [row for row in history if row["workout_id"] == latest_workout]
        recent_load = latest_sets[0].get("load")
        if not recent_load or recent_load["unit"] != lower["unit"]:
            return target_load or lower, {"decision": "initialize", "reason": "Prior compatible history has no usable load.", "load_key": load_key}
        when = policy["increase_when"]
        complete = bool(latest_sets) and all(
            row.get("reps", -1) >= when["completed_reps_at_or_above"] and (row.get("rpe") is None or row["rpe"] <= when["max_rpe"])
            for row in latest_sets
        )
        if not complete:
            return recent_load, {"decision": "hold", "reason": "Latest exact exposure did not meet the progression rule.", "load_key": load_key,
                                 "source_workout_id": latest_workout}
        increased = min(upper["value"], recent_load["value"] + policy["increment"]["value"])
        decision = "increase" if increased > recent_load["value"] else "hold"
        return {"value": increased, "unit": lower["unit"]}, {"decision": decision, "reason": "Latest exact exposure met the progression rule.",
                                                                 "load_key": load_key, "source_workout_id": latest_workout}

    async def workout(self, account_id: str, workout_id: str) -> dict[str, Any]:
        document = await self.db.workouts.find_one({"account_id": account_id, "workout_id": workout_id, "deleted_at": {"$exists": False}})
        if not document:
            raise WorkoutDomainError("workout_not_found", "Workout was not found.", 404)
        return self._public(document, ("account_id", "_id"))

    async def workouts(self, account_id: str, start: str, end: str) -> list[dict[str, Any]]:
        rows = await self.db.workouts.find({"account_id": account_id, "date": {"$gte": start, "$lte": end}, "deleted_at": {"$exists": False}}).sort("date", ASCENDING).to_list()
        return [self._public(row, ("account_id", "_id")) for row in rows]

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
        workout["status"] = "completed" if all(set_data.get("actual") is not None for segment in workout["segments"] for item_row in segment["items"] for set_data in item_row["sets"]) else "in_progress"
        workout["revision"], workout["updated_at"] = new_revision(), utc_now()
        replaced = await self.db.workouts.replace_one({"account_id": account_id, "workout_id": workout_id, "revision": input.expected_revision}, workout)
        if not replaced.modified_count:
            raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before logging.")
        if actual["status"] == "completed":
            await self._index_performance(account_id, workout, item, set_row)
        response = self.receipt("workout", workout_id, workout["revision"], input.request_id, "set_logged")
        response["workout"] = self._public(workout, ("account_id", "_id"))
        return await self._save_receipt(account_id, input.request_id, fingerprint, response)

    async def _index_performance(self, account_id: str, workout: dict[str, Any], item: dict[str, Any], set_row: dict[str, Any]) -> None:
        actual = set_row["actual"]
        snapshot = item["exercise_snapshot"]
        load = actual.get("load")
        if not load:
            return
        document = {"account_id": account_id, "load_key": exercise_load_key(snapshot), "workout_id": workout["workout_id"],
                    "exercise_instance_id": item["exercise_instance_id"], "set_id": set_row["set_id"], "date": workout["date"],
                    "completed_at": actual["completed_at"], "load": load, "reps": actual.get("reps"), "duration_seconds": actual.get("duration_seconds"),
                    "rpe": actual.get("rpe")}
        await self.db.performance_index.replace_one({"account_id": account_id, "workout_id": workout["workout_id"], "set_id": set_row["set_id"]}, document, upsert=True)

    async def swap(self, account_id: str, workout_id: str, instance_id: str, input: SwapInput) -> dict[str, Any]:
        fingerprint = _fingerprint({"workout_id": workout_id, "instance_id": instance_id, **input.model_dump(mode="json")})
        prior = await self._receipt(account_id, input.request_id, fingerprint)
        if prior:
            return prior
        workout = await self.db.workouts.find_one({"account_id": account_id, "workout_id": workout_id, "deleted_at": {"$exists": False}})
        if not workout:
            raise WorkoutDomainError("workout_not_found", "Workout was not found.", 404)
        if workout["revision"] != input.expected_revision:
            raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before swapping.")
        target_item: dict[str, Any] | None = None
        for segment in workout["segments"]:
            for item in segment["items"]:
                if item["exercise_instance_id"] == instance_id:
                    target_item = item
                    target_segment = segment
                    break
        if not target_item:
            raise WorkoutDomainError("exercise_instance_not_found", "Workout exercise was not found.", 404)
        if any(set_row.get("actual") is not None for set_row in target_item["sets"]):
            raise WorkoutDomainError("completed_exercise_locked", "A completed exercise cannot be swapped.")
        active = await self.active_release(account_id, workout["date"])
        day = next(item for item in active["blueprint"]["days"] if item["day_id"] == workout["lineage"]["day_id"])
        source_slot = next(slot for segment in day["segments"] for slot in segment["slots"] if slot["slot_id"] == target_item["slot_id"])
        used = {item["exercise_snapshot"]["exercise_id"] for segment in workout["segments"] for item in segment["items"]}
        candidates = [candidate for candidate in source_slot["candidates"] if candidate["exercise_id"] not in used or candidate["candidate_id"] == target_item["candidate_id"]]
        candidates = [candidate for candidate in candidates if candidate["candidate_id"] != target_item["candidate_id"]]
        if not candidates:
            raise WorkoutDomainError("no_eligible_swap", "No eligible candidate remains in this blueprint slot.")
        index, probabilities = _decision_index(f"{workout_id}:{instance_id}:{input.request_id}", candidates, input.mode)
        candidate = sorted(candidates, key=lambda item: (item["priority"], item["candidate_id"]))[index]
        exercise = await self.exercise(account_id, candidate["exercise_id"], candidate["exercise_revision"])
        snapshot = {key: exercise[key] for key in ("exercise_id", "revision", "name", "movement_pattern", "primary_muscles", "secondary_muscles", "equipment_kind", "laterality", "load_basis")}
        snapshot["exercise_revision"] = snapshot.pop("revision")
        snapshot["equipment_profile_id"] = candidate.get("equipment_profile_id")
        targets = candidate["prescription"].get("round_targets") or [candidate["prescription"]["target"]] * target_segment["rounds"]
        load, load_decision = await self._progression_target(account_id, snapshot, candidate, targets[-1])
        target_item.update({"candidate_id": candidate["candidate_id"], "exercise_snapshot": snapshot, "cues_md": self._cues(candidate, exercise),
                            "sets": [{"set_id": new_id("set"), "kind": "work", "target": {**target, **({"load": load} if load else {})}, "actual": None, "round": index + 1} for index, target in enumerate(targets)]})
        workout["revision"], workout["updated_at"] = new_revision(), utc_now()
        workout["lineage"].setdefault("swaps", []).append({"exercise_instance_id": instance_id, "reason": input.reason, "mode": input.mode,
                                                               "candidate_id": candidate["candidate_id"], "probabilities": probabilities, "load": load_decision})
        replaced = await self.db.workouts.replace_one({"account_id": account_id, "workout_id": workout_id, "revision": input.expected_revision}, workout)
        if not replaced.modified_count:
            raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before swapping.")
        response = self.receipt("workout", workout_id, workout["revision"], input.request_id, "swapped")
        response["workout"] = self._public(workout, ("account_id", "_id"))
        return await self._save_receipt(account_id, input.request_id, fingerprint, response)

    async def override(self, account_id: str, input: WorkoutOverrideInput, actor: dict[str, Any]) -> dict[str, Any]:
        """Replace an unstarted day with a typed agent exception and preserve lineage."""
        fingerprint = _fingerprint({"override": input.model_dump(mode="json"), "actor": actor})
        prior = await self._receipt(account_id, input.request_id, fingerprint)
        if prior:
            return prior
        current = await self.db.workouts.find_one({"account_id": account_id, "date": input.date, "deleted_at": {"$exists": False}})
        if not current and input.expected_revision is not None:
            raise WorkoutDomainError("invalid_workout_revision", "A new override cannot declare an expected revision.", 422)
        if current and current["revision"] != input.expected_revision:
            raise WorkoutDomainError("stale_revision", "Workout changed. Pull the current revision before overriding.")
        if current and any(set_row.get("actual") is not None for segment in current["segments"] for item in segment["items"] for set_row in item["sets"]):
            raise WorkoutDomainError("completed_workout_locked", "A workout with completed sets cannot be replaced.")
        await self._validate_candidates(account_id, [
            candidate for segment in input.segments for slot in segment.slots for candidate in slot.candidates
        ])
        active = await self.active_release(account_id, input.date)
        release, blueprint = active["release"], active["blueprint"]
        forbidden = set(blueprint.get("hard_constraints", {}).get("forbidden_exercise_ids", []))
        requested = {candidate.exercise_id for segment in input.segments for slot in segment.slots for candidate in slot.candidates}
        if forbidden & requested:
            raise WorkoutDomainError("override_hard_constraint", "An agent override cannot use a hard-forbidden exercise.", 422)
        day = {
            "day_id": f"day_agent_override_{input.date.replace('-', '_')}",
            "date": input.date,
            "title": input.title,
            "segments": [segment.model_dump(mode="json") for segment in input.segments],
        }
        materialized = await self._materialize(
            account_id, release, blueprint, day,
            GenerateInput(date=input.date, mode="default", request_id=input.request_id),
        )
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
        materialized["revision"] = new_revision()
        materialized["updated_at"] = timestamp
        if current:
            result = await self.db.workouts.replace_one(
                {"account_id": account_id, "workout_id": current["workout_id"], "revision": input.expected_revision}, materialized,
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

    async def history(self, account_id: str, exercise_id: str, before: str | None = None, limit: int = 10) -> list[dict[str, Any]]:
        head = await self.exercise(account_id, exercise_id)
        prefix = f"{exercise_id}|"
        query: dict[str, Any] = {"account_id": account_id, "load_key": {"$regex": f"^{prefix}"}}
        if before:
            query["date"] = {"$lte": before}
        rows = await self.db.performance_index.find(query).sort("completed_at", DESCENDING).limit(min(max(limit, 1), 50)).to_list()
        return [self._public(row, ("account_id", "_id", "load_key")) for row in rows]

    @staticmethod
    def _public(document: dict[str, Any], hidden: tuple[str, ...]) -> dict[str, Any]:
        return {key: value for key, value in document.items() if key not in hidden}
