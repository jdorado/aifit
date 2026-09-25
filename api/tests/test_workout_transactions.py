from copy import deepcopy
import re

import pytest
from pymongo.errors import OperationFailure

from aifit_api.workouts import BlueprintInput, GenerateInput, WorkoutService

from test_workout_contract import blueprint


class ReplaceResult:
    def __init__(self, modified_count):
        self.modified_count = modified_count


class DeleteResult:
    def __init__(self, deleted_count):
        self.deleted_count = deleted_count


class FakeCursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, key, direction=1):
        self.rows.sort(key=lambda row: row.get(key), reverse=direction < 0)
        return self

    def limit(self, count):
        self.rows = self.rows[:count]
        return self

    async def to_list(self, length=None):
        return [deepcopy(row) for row in self.rows]


class FakeCollection:
    def __init__(self, database, name):
        self.database = database
        self.name = name

    @property
    def documents(self):
        return self.database.documents[self.name]

    async def find_one(self, query, **_kwargs):
        return next((deepcopy(row) for row in self.documents if matches(row, query)), None)

    def find(self, query, **_kwargs):
        return FakeCursor([row for row in self.documents if matches(row, query)])

    async def insert_one(self, document, **_kwargs):
        self.documents.append(deepcopy(document))

    async def replace_one(self, query, document, upsert=False, **_kwargs):
        for index, row in enumerate(self.documents):
            if matches(row, query):
                self.documents[index] = deepcopy(document)
                return ReplaceResult(1)
        if upsert:
            self.documents.append(deepcopy(document))
        return ReplaceResult(0)

    async def delete_one(self, query, **_kwargs):
        for index, row in enumerate(self.documents):
            if matches(row, query):
                del self.documents[index]
                return DeleteResult(1)
        return DeleteResult(0)

    async def find_one_and_update(self, query, update, upsert=False, **_kwargs):
        for index, row in enumerate(self.documents):
            if matches(row, query):
                updated = deepcopy(row)
                apply_update(updated, update)
                self.documents[index] = updated
                return deepcopy(updated)
        if not upsert:
            return None
        created = {key: value for key, value in query.items() if not key.startswith("$")}
        apply_update(created, update)
        self.documents.append(created)
        return deepcopy(created)


class FakeSession:
    def __init__(self, database):
        self.database = database

    async def __aenter__(self):
        return self

    async def __aexit__(self, *_args):
        return False

    async def with_transaction(self, callback):
        snapshot = deepcopy(self.database.documents)
        try:
            result = await callback(self)
        except Exception:
            self.database.documents = snapshot
            self.database.aborted += 1
            raise
        self.database.committed += 1
        return result


class FakeClient:
    def __init__(self, database):
        self.database = database

    def start_session(self):
        return FakeSession(self.database)


class FakeDatabase:
    def __init__(self):
        self.documents = {
            "profiles": [],
            "exercises": [],
            "exercise_heads": [],
            "plans": [],
            "blueprints": [],
            "releases": [],
            "program_state": [],
            "workouts": [],
            "performance_index": [],
            "mutation_receipts": [],
        }
        self.client = FakeClient(self)
        self.committed = 0
        self.aborted = 0

    def __getattr__(self, name):
        if name in self.documents:
            return FakeCollection(self, name)
        raise AttributeError(name)


class StandaloneClient(FakeClient):
    """Mimic a standalone mongod without transaction support."""

    def start_session(self):
        raise OperationFailure(
            "Transaction numbers are only allowed on a replica set member or mongos"
        )


class StandaloneDatabase(FakeDatabase):
    def __init__(self):
        super().__init__()
        self.client = StandaloneClient(self)


def matches(document, query):
    for key, value in query.items():
        if key == "$or":
            if not any(matches(document, clause) for clause in value):
                return False
            continue
        if isinstance(value, dict):
            if any(op in value for op in ("$gte", "$lte", "$lt", "$gt")):
                field = document.get(key)
                if field is None:
                    return False
                if "$gte" in value and field < value["$gte"] or "$lte" in value and field > value["$lte"]:
                    return False
                if "$lt" in value and field >= value["$lt"] or "$gt" in value and field <= value["$gt"]:
                    return False
                continue
            if "$exists" in value:
                if (key in document) != value["$exists"]:
                    return False
                continue
            if "$regex" in value:
                field = document.get(key)
                if not isinstance(field, str) or re.search(value["$regex"], field) is None:
                    return False
                continue
            if "$ne" in value:
                if document.get(key) == value["$ne"]:
                    return False
                continue
            if "$in" in value:
                field = document.get(key)
                candidates = value["$in"]
                if isinstance(field, list):
                    if not any(item in candidates for item in field):
                        return False
                elif field not in candidates:
                    return False
                continue
            if "$nin" in value:
                field = document.get(key)
                excluded = value["$nin"]
                if isinstance(field, list):
                    if any(item in excluded for item in field):
                        return False
                elif field in excluded:
                    return False
                continue
        field = document.get(key)
        if isinstance(field, list):
            if value not in field:
                return False
            continue
        if field != value:
            return False
    return True


def apply_update(document, update):
    for key, value in update.get("$set", {}).items():
        document[key] = deepcopy(value)
    for key in update.get("$unset", {}):
        document.pop(key, None)


async def fail_receipt(*_args, **_kwargs):
    raise RuntimeError("receipt unavailable")


@pytest.mark.asyncio
async def test_solidify_rolls_back_blueprint_when_receipt_write_fails():
    database = FakeDatabase()
    value = blueprint()

    service = WorkoutService(database)
    service._save_receipt = fail_receipt

    with pytest.raises(RuntimeError, match="receipt unavailable"):
        await service.solidify_blueprint(
            "acc_one",
            BlueprintInput(**value),
            None,
            "solidify-transaction-001",
            {"kind": "agent", "job_id": "job_one"},
        )

    assert database.documents["blueprints"] == []
    assert database.documents["program_state"] == []
    assert database.documents["mutation_receipts"] == []
    assert database.aborted == 1
    assert database.committed == 0


@pytest.mark.asyncio
async def test_generate_rolls_back_workout_when_receipt_write_fails():
    database = FakeDatabase()
    blueprint_id = "bp_0123456789abcdef0123456789abcdef"
    revision = "rev_0123456789abcdef0123456789abcdef"
    database.documents["blueprints"].append({
        "account_id": "acc_one",
        "blueprint_id": blueprint_id,
        "revision": revision,
        "start_date": "2026-09-21",
        "end_date": "2026-09-21",
        "timezone": "Asia/Dubai",
        "days": [{
            "day_id": "day_rest",
            "date": "2026-09-21",
            "kind": "rest",
            "title": "Rest",
            "segments": [],
        }],
    })
    database.documents["program_state"].append({
        "account_id": "acc_one",
        "active_blueprint_id": blueprint_id,
        "active_blueprint_revision": revision,
    })

    service = WorkoutService(database)
    service._save_receipt = fail_receipt

    with pytest.raises(RuntimeError, match="receipt unavailable"):
        await service.generate("acc_one", GenerateInput(date="2026-09-21", request_id="generate-transaction-001"))

    assert database.documents["workouts"] == []
    assert database.documents["mutation_receipts"] == []
    assert database.aborted == 1
    assert database.committed == 0


@pytest.mark.asyncio
async def test_solidify_and_generate_accept_agent_authored_exercise_ids():
    database = FakeDatabase()
    service = WorkoutService(database)
    published = await service.solidify_blueprint(
        "acc_one",
        BlueprintInput(**blueprint()),
        None,
        "solidify-authored-001",
        {"kind": "agent", "job_id": "job_one"},
    )
    generated = await service.generate(
        "acc_one",
        GenerateInput(date="2026-09-21", request_id="generate-authored-001"),
    )

    assert database.documents["exercises"] == []
    assert published["status"] == "saved"
    snapshot = generated["workout"]["segments"][0]["items"][0]["exercise_snapshot"]
    assert snapshot["exercise_id"] == "ex_chest_supported_row_machine"
    assert snapshot["name"] == "Chest Supported Row Machine"
    assert snapshot["exercise_revision"] == "rev_0123456789abcdef0123456789abcdef"


@pytest.mark.asyncio
async def test_solidify_falls_back_without_transaction_support():
    database = StandaloneDatabase()
    service = WorkoutService(database)
    published = await service.solidify_blueprint(
        "acc_one",
        BlueprintInput(**blueprint()),
        None,
        "solidify-standalone-001",
        {"kind": "agent", "job_id": "job_one"},
    )

    assert published["effect"] == "published"
    assert len(database.documents["blueprints"]) == 1
    assert database.documents["program_state"][0]["active_blueprint_id"] == published["resource_id"]
    assert len(database.documents["mutation_receipts"]) == 1
