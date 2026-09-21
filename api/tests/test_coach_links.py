from copy import deepcopy

import pytest

from aifit_api import main
from aifit_api.auth import Identity
from aifit_api.coach_links import (
    CoachLinkAcceptInput,
    CoachLinkInviteInput,
    CoachLinkService,
    CoachLinkUpdateInput,
    CoachPermissions,
)
from aifit_api.workouts import WorkoutDomainError


class FakeCursor:
    def __init__(self, rows):
        self.rows = rows

    def sort(self, key, direction):
        return FakeCursor(sorted(self.rows, key=lambda row: row.get(key, ""), reverse=direction < 0))

    async def to_list(self, length=None):
        return deepcopy(self.rows if length is None else self.rows[:length])


class FakeCollection:
    def __init__(self, documents):
        self.documents = documents

    async def find_one(self, query, **_kwargs):
        return next((deepcopy(row) for row in self.documents if matches(row, query)), None)

    async def insert_one(self, document, **_kwargs):
        self.documents.append(deepcopy(document))

    async def find_one_and_update(self, query, update, return_document=None, **_kwargs):
        for index, row in enumerate(self.documents):
            if not matches(row, query):
                continue
            updated = deepcopy(row)
            apply_update(updated, update)
            self.documents[index] = updated
            return deepcopy(updated)
        return None

    def find(self, query):
        return FakeCursor([row for row in self.documents if matches(row, query)])


class FakeDatabase:
    def __init__(self):
        self.coach_links = FakeCollection([])
        self.coach_link_receipts = FakeCollection([])


def matches(document, query):
    for key, value in query.items():
        if key == "$or":
            if not any(matches(document, clause) for clause in value):
                return False
            continue
        if document.get(key) != value:
            return False
    return True


def apply_update(document, update):
    for key, value in update.get("$set", {}).items():
        document[key] = deepcopy(value)


TRAINEE = {"account_id": "acc_trainee", "email": "trainee@example.com"}
COACH = {"account_id": "acc_coach", "email": "coach@example.com"}
OTHER = {"account_id": "acc_other", "email": "other@example.com"}


async def invite(service, permissions=None, request_id="coach-invite-1"):
    return await service.create_invite(
        TRAINEE,
        CoachLinkInviteInput(
            coach_email="Coach@Example.com",
            permissions=permissions or CoachPermissions(view_progress=True, edit_programs=True),
            request_id=request_id,
        ),
    )


async def active_link(service, permissions=None):
    link = await invite(service, permissions)
    accepted = await service.accept(
        COACH,
        CoachLinkAcceptInput(invite_token=link["invite_token"], request_id="coach-accept-1"),
    )
    return accepted


@pytest.mark.asyncio
async def test_invite_accept_list_revoke_lifecycle():
    service = CoachLinkService(FakeDatabase())
    pending = await invite(service)

    assert pending["status"] == "pending"
    assert pending["trainee_account_id"] == TRAINEE["account_id"]
    assert pending["trainee_email"] == TRAINEE["email"]
    assert pending["coach_account_id"] is None
    assert pending["coach_email"] == "coach@example.com"
    assert pending["invite_token"]
    assert pending["invite_expires_at"] > pending["created_at"]

    accepted = await service.accept(
        COACH,
        CoachLinkAcceptInput(invite_token=pending["invite_token"], request_id="coach-accept-1"),
    )
    assert accepted["status"] == "active"
    assert accepted["coach_account_id"] == COACH["account_id"]

    trainee_links = await service.list_for(TRAINEE, "trainee")
    coach_links = await service.list_for(COACH, "coach")
    assert [row["link_id"] for row in trainee_links] == [pending["link_id"]]
    assert [row["link_id"] for row in coach_links] == [pending["link_id"]]
    assert await service.list_for(OTHER, "all") == []

    revoked = await service.update(
        TRAINEE,
        pending["link_id"],
        CoachLinkUpdateInput(status="revoked", request_id="coach-revoke-1"),
    )
    assert revoked["status"] == "revoked"

    with pytest.raises(WorkoutDomainError) as error:
        await service.accept(
            COACH,
            CoachLinkAcceptInput(invite_token=pending["invite_token"], request_id="coach-accept-2"),
        )
    assert error.value.code == "coach_link_revoked"
    assert error.value.status_code == 409


@pytest.mark.asyncio
async def test_invite_and_accept_are_idempotent_by_request_id():
    service = CoachLinkService(FakeDatabase())
    first = await invite(service, request_id="coach-invite-1")
    replay = await invite(service, request_id="coach-invite-1")
    assert replay["link_id"] == first["link_id"]
    assert replay["invite_token"] == first["invite_token"]

    accepted = await service.accept(
        COACH, CoachLinkAcceptInput(invite_token=first["invite_token"], request_id="coach-accept-1"),
    )
    replayed_accept = await service.accept(
        COACH, CoachLinkAcceptInput(invite_token=first["invite_token"], request_id="coach-accept-1"),
    )
    assert replayed_accept["status"] == "active"
    assert replayed_accept["updated_at"] == accepted["updated_at"]


@pytest.mark.asyncio
async def test_accept_rejects_email_mismatch():
    service = CoachLinkService(FakeDatabase())
    pending = await invite(service)

    with pytest.raises(WorkoutDomainError) as error:
        await service.accept(
            OTHER,
            CoachLinkAcceptInput(invite_token=pending["invite_token"], request_id="coach-accept-other"),
        )
    assert error.value.code == "coach_link_email_mismatch"
    assert error.value.status_code == 403


@pytest.mark.asyncio
async def test_accept_rejects_expired_invite():
    database = FakeDatabase()
    service = CoachLinkService(database)
    pending = await invite(service)
    database.coach_links.documents[0]["invite_expires_at"] = "2020-01-01T00:00:00Z"

    with pytest.raises(WorkoutDomainError) as error:
        await service.accept(
            COACH,
            CoachLinkAcceptInput(invite_token=pending["invite_token"], request_id="coach-accept-expired"),
        )
    assert error.value.code == "coach_link_expired"
    assert error.value.status_code == 409


@pytest.mark.asyncio
async def test_unknown_token_is_not_found():
    service = CoachLinkService(FakeDatabase())
    with pytest.raises(WorkoutDomainError) as error:
        await service.accept(
            COACH,
            CoachLinkAcceptInput(invite_token="not-a-real-token-value", request_id="coach-accept-missing"),
        )
    assert error.value.code == "coach_link_not_found"
    assert error.value.status_code == 404


@pytest.mark.asyncio
async def test_view_only_coach_can_read_but_not_write_and_revoke_stops_act_as():
    service = CoachLinkService(FakeDatabase())
    link = await active_link(service, CoachPermissions(view_progress=True, edit_programs=False))

    resolved = await service.resolve_act_as(COACH["account_id"], link["link_id"], "view_progress")
    assert resolved["account_id"] == TRAINEE["account_id"]

    with pytest.raises(WorkoutDomainError) as error:
        await service.resolve_act_as(COACH["account_id"], link["link_id"], "edit_programs")
    assert error.value.code == "coach_link_forbidden"
    assert error.value.status_code == 403

    with pytest.raises(WorkoutDomainError) as error:
        await service.resolve_act_as(OTHER["account_id"], link["link_id"], "view_progress")
    assert error.value.code == "coach_link_forbidden"

    await service.update(TRAINEE, link["link_id"], CoachLinkUpdateInput(status="revoked", request_id="coach-revoke-2"))
    with pytest.raises(WorkoutDomainError) as error:
        await service.resolve_act_as(COACH["account_id"], link["link_id"], "view_progress")
    assert error.value.code == "coach_link_revoked"
    assert error.value.status_code == 409


@pytest.mark.asyncio
async def test_pending_link_cannot_act_as_and_permissions_are_trainee_only():
    service = CoachLinkService(FakeDatabase())
    pending = await invite(service)

    with pytest.raises(WorkoutDomainError) as error:
        await service.resolve_act_as(COACH["account_id"], pending["link_id"], "view_progress")
    assert error.value.code == "coach_link_forbidden"

    with pytest.raises(WorkoutDomainError) as error:
        await service.update(
            COACH,
            pending["link_id"],
            CoachLinkUpdateInput(permissions=CoachPermissions(view_progress=True), request_id="coach-patch-1"),
        )
    assert error.value.code == "coach_link_forbidden"

    updated = await service.update(
        TRAINEE,
        pending["link_id"],
        CoachLinkUpdateInput(permissions=CoachPermissions(view_progress=True), request_id="coach-patch-2"),
    )
    assert updated["permissions"] == {"view_progress": True, "edit_programs": False}

    with pytest.raises(ValueError):
        CoachPermissions(view_progress=False, edit_programs=True)


class StubWorkoutService:
    def __init__(self):
        self.reads = []

    async def workouts(self, account_id, start, end):
        self.reads.append(account_id)
        return [{"date": start, "account_id": account_id}]

    async def log_set(self, *_args, **_kwargs):
        raise AssertionError("a denied write must not reach the workout domain")


def test_routes_recheck_the_link_per_request(monkeypatch):
    from fastapi.testclient import TestClient

    database = FakeDatabase()
    service = CoachLinkService(database)
    stub = StubWorkoutService()
    monkeypatch.setattr(main, "coach_links", lambda: service)
    monkeypatch.setattr(main, "workouts", lambda: stub)
    monkeypatch.setattr(main, "browser_account", lambda _identity: _async_value(COACH))
    main.app.dependency_overrides[main.require_identity] = lambda: Identity(
        subject="did:privy:coach", email="coach@example.com",
    )
    client = TestClient(main.app)
    try:
        pending = _run(service.create_invite(TRAINEE, CoachLinkInviteInput(
            coach_email="coach@example.com",
            permissions=CoachPermissions(view_progress=True, edit_programs=False),
            request_id="route-invite-1",
        )))
        link = _run(service.accept(COACH, CoachLinkAcceptInput(
            invite_token=pending["invite_token"], request_id="route-accept-1",
        )))

        own = client.get("/v1/workouts?start=2026-09-21&end=2026-09-21")
        assert own.status_code == 200
        assert own.json()[0]["account_id"] == COACH["account_id"]

        acting = client.get(
            f"/v1/workouts?start=2026-09-21&end=2026-09-21&act_as_link_id={link['link_id']}",
        )
        assert acting.status_code == 200
        assert acting.json()[0]["account_id"] == TRAINEE["account_id"]
        assert stub.reads == [COACH["account_id"], TRAINEE["account_id"]]

        denied = client.patch(
            f"/v1/workouts/wrk_0123456789abcdef0123456789abcdef/sets/set_1?act_as_link_id={link['link_id']}",
            json={
                "actual": {"status": "skipped"},
                "expected_revision": "rev_0123456789abcdef0123456789abcdef",
                "request_id": "route-write-1",
            },
        )
        assert denied.status_code == 403
        assert denied.json()["detail"]["code"] == "coach_link_forbidden"

        _run(service.update(TRAINEE, link["link_id"], CoachLinkUpdateInput(
            status="revoked", request_id="route-revoke-1",
        )))
        stopped = client.get(
            f"/v1/workouts?start=2026-09-21&end=2026-09-21&act_as_link_id={link['link_id']}",
        )
        assert stopped.status_code == 409
        assert stopped.json()["detail"]["code"] == "coach_link_revoked"
    finally:
        main.app.dependency_overrides.clear()


def _async_value(value):
    async def result():
        return value
    return result()


def _run(coroutine):
    import asyncio
    return asyncio.run(coroutine)
