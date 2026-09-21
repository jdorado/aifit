"""Coach sharing: typed invite links and deterministic delegated authority.

The module owns one canonical collection (``coach_links``) plus the permission
re-check behind the browser act-as surface. It never trusts a browser-supplied
account, owner, or permission value: invites and accepts resolve the account
from the signed-in identity, and every act-as request re-reads the stored link
instead of caching trust.
"""

from __future__ import annotations

import json
import secrets
from datetime import UTC, datetime, timedelta
from hashlib import sha256
from typing import Any, Literal

from pydantic import Field, model_validator
from pymongo import ASCENDING, ReturnDocument
from pymongo.errors import DuplicateKeyError

from .workouts import StrictModel, WorkoutDomainError, new_id, utc_now


INVITE_TTL_DAYS = 14
VIEW_PROGRESS = "view_progress"
EDIT_PROGRAMS = "edit_programs"
COACH_PERMISSIONS = (VIEW_PROGRESS, EDIT_PROGRAMS)
CoachLinkRole = Literal["all", "coach", "trainee"]


class CoachPermissions(StrictModel):
    view_progress: bool = False
    edit_programs: bool = False

    @model_validator(mode="after")
    def edit_implies_view(self) -> "CoachPermissions":
        if self.edit_programs and not self.view_progress:
            raise ValueError("edit_programs requires view_progress")
        return self


class CoachLinkInviteInput(StrictModel):
    coach_email: str = Field(min_length=3, max_length=254, pattern=r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
    permissions: CoachPermissions = Field(default_factory=CoachPermissions)
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")


class CoachLinkAcceptInput(StrictModel):
    invite_token: str = Field(min_length=8, max_length=200)
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")


class CoachLinkUpdateInput(StrictModel):
    permissions: CoachPermissions | None = None
    status: Literal["revoked"] | None = None
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")

    @model_validator(mode="after")
    def one_change(self) -> "CoachLinkUpdateInput":
        if self.permissions is None and self.status is None:
            raise ValueError("provide permissions or status")
        return self


def _fingerprint(value: Any) -> str:
    return sha256(json.dumps(value, sort_keys=True, separators=(",", ":"), default=str).encode()).hexdigest()


def _email(value: Any) -> str | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().lower()
    return normalized if "@" in normalized else None


class CoachLinkService:
    """Canonical persistence for coach invites and the delegated permission check."""

    def __init__(self, database: Any):
        self.db = database

    async def ensure_indexes(self) -> None:
        await self.db.coach_links.create_index([("link_id", ASCENDING)], unique=True)
        await self.db.coach_links.create_index([("coach_account_id", ASCENDING)])
        await self.db.coach_links.create_index([("trainee_account_id", ASCENDING)])
        await self.db.coach_links.create_index([("invite_token", ASCENDING)], unique=True)
        await self.db.coach_link_receipts.create_index([("account_id", ASCENDING), ("request_id", ASCENDING)], unique=True)

    async def _receipt(self, account_id: str, request_id: str, fingerprint: str) -> dict[str, Any] | None:
        current = await self.db.coach_link_receipts.find_one({"account_id": account_id, "request_id": request_id})
        if not current:
            return None
        if current["fingerprint"] != fingerprint:
            raise WorkoutDomainError("idempotency_conflict", "This request ID was already used for different content.")
        return current["response"]

    async def _save_receipt(self, account_id: str, request_id: str, fingerprint: str, response: dict[str, Any]) -> dict[str, Any]:
        document = {"account_id": account_id, "request_id": request_id, "fingerprint": fingerprint,
                    "response": response, "created_at": utc_now()}
        try:
            await self.db.coach_link_receipts.insert_one(document)
            return response
        except DuplicateKeyError:
            existing = await self._receipt(account_id, request_id, fingerprint)
            if existing is None:
                raise
            return existing

    @staticmethod
    def public(link: dict[str, Any]) -> dict[str, Any]:
        return {key: value for key, value in link.items() if key != "_id"}

    async def create_invite(self, account: dict[str, Any], input: CoachLinkInviteInput) -> dict[str, Any]:
        coach_email = input.coach_email.strip().lower()
        fingerprint = _fingerprint({"account_id": account["account_id"], "coach_email": coach_email,
                                    "permissions": input.permissions.model_dump()})
        prior = await self._receipt(account["account_id"], input.request_id, fingerprint)
        if prior:
            return prior
        timestamp = utc_now()
        document = {
            "link_id": new_id("cl"),
            "trainee_account_id": account["account_id"],
            "trainee_email": _email(account.get("email")),
            "coach_account_id": None,
            "coach_email": coach_email,
            "permissions": input.permissions.model_dump(),
            "status": "pending",
            "invite_token": secrets.token_urlsafe(24),
            "invite_expires_at": (datetime.now(UTC) + timedelta(days=INVITE_TTL_DAYS)).isoformat().replace("+00:00", "Z"),
            "created_at": timestamp,
            "updated_at": timestamp,
        }
        await self.db.coach_links.insert_one(document)
        return await self._save_receipt(account["account_id"], input.request_id, fingerprint, self.public(document))

    async def accept(self, account: dict[str, Any], input: CoachLinkAcceptInput) -> dict[str, Any]:
        fingerprint = _fingerprint({"account_id": account["account_id"], "invite_token": input.invite_token})
        prior = await self._receipt(account["account_id"], input.request_id, fingerprint)
        if prior:
            return prior
        link = await self.db.coach_links.find_one({"invite_token": input.invite_token})
        if not link:
            raise WorkoutDomainError("coach_link_not_found", "Coach invite was not found.", 404)
        if link["status"] == "revoked":
            raise WorkoutDomainError("coach_link_revoked", "This coach link was revoked.", 409)
        if link["status"] != "pending":
            raise WorkoutDomainError("coach_link_not_pending", "This coach invite was already accepted.", 409)
        if link.get("invite_expires_at") and link["invite_expires_at"] <= utc_now():
            raise WorkoutDomainError("coach_link_expired", "This coach invite has expired.", 409)
        email = _email(account.get("email"))
        if link.get("coach_email") and link["coach_email"] != email:
            raise WorkoutDomainError("coach_link_email_mismatch", "This invite belongs to another email.", 403)
        timestamp = utc_now()
        updated = await self.db.coach_links.find_one_and_update(
            {"link_id": link["link_id"], "status": "pending"},
            {"$set": {"status": "active", "coach_account_id": account["account_id"],
                      "coach_email": email or link["coach_email"], "accepted_at": timestamp, "updated_at": timestamp}},
            return_document=ReturnDocument.AFTER,
        )
        if not updated:
            raise WorkoutDomainError("coach_link_not_pending", "This coach invite was already accepted.", 409)
        return await self._save_receipt(account["account_id"], input.request_id, fingerprint, self.public(updated))

    async def list_for(self, account: dict[str, Any], role: CoachLinkRole = "all") -> list[dict[str, Any]]:
        clauses: list[dict[str, Any]] = []
        if role in {"all", "trainee"}:
            clauses.append({"trainee_account_id": account["account_id"]})
        if role in {"all", "coach"}:
            email = _email(account.get("email"))
            coach_or: list[dict[str, Any]] = [{"coach_account_id": account["account_id"]}]
            if email:
                coach_or.append({"coach_email": email, "status": "pending"})
            clauses.append({"$or": coach_or})
        query = clauses[0] if len(clauses) == 1 else {"$or": clauses}
        rows = await self.db.coach_links.find(query).sort("updated_at", -1).to_list(length=200)
        seen: set[str] = set()
        results: list[dict[str, Any]] = []
        for row in rows:
            if row["link_id"] in seen:
                continue
            seen.add(row["link_id"])
            results.append(self.public(row))
        return results

    async def update(self, account: dict[str, Any], link_id: str, input: CoachLinkUpdateInput) -> dict[str, Any]:
        fingerprint = _fingerprint({"account_id": account["account_id"], "link_id": link_id,
                                    **input.model_dump(exclude_none=True)})
        prior = await self._receipt(account["account_id"], input.request_id, fingerprint)
        if prior:
            return prior
        link = await self.db.coach_links.find_one({"link_id": link_id})
        if not link:
            raise WorkoutDomainError("coach_link_not_found", "Coach link was not found.", 404)
        email = _email(account.get("email"))
        is_trainee = link["trainee_account_id"] == account["account_id"]
        is_coach = link.get("coach_account_id") == account["account_id"] or (
            link.get("coach_account_id") is None and email is not None and link.get("coach_email") == email
        )
        if not is_trainee and not is_coach:
            raise WorkoutDomainError("coach_link_forbidden", "This coach link belongs to another account.", 403)
        if link["status"] == "revoked":
            raise WorkoutDomainError("coach_link_revoked", "Revoked coach links cannot be changed.", 409)
        timestamp = utc_now()
        changes: dict[str, Any] = {"updated_at": timestamp}
        if input.status == "revoked":
            changes["status"] = "revoked"
            changes["revoked_at"] = timestamp
        if input.permissions is not None:
            if not is_trainee:
                raise WorkoutDomainError("coach_link_forbidden", "Only the trainee can change coach permissions.", 403)
            changes["permissions"] = input.permissions.model_dump()
        updated = await self.db.coach_links.find_one_and_update(
            {"link_id": link_id, "status": link["status"]},
            {"$set": changes},
            return_document=ReturnDocument.AFTER,
        )
        if not updated:
            raise WorkoutDomainError("coach_link_revoked", "Revoked coach links cannot be changed.", 409)
        return await self._save_receipt(account["account_id"], input.request_id, fingerprint, self.public(updated))

    async def resolve_act_as(self, coach_account_id: str, link_id: str, permission: str) -> dict[str, Any]:
        """Re-check delegated authority on every call, never from cached trust."""
        link = await self.db.coach_links.find_one({"link_id": link_id})
        if not link:
            raise WorkoutDomainError("coach_link_not_found", "Coach link was not found.", 404)
        if link.get("coach_account_id") != coach_account_id:
            raise WorkoutDomainError("coach_link_forbidden", "This coach link is not yours.", 403)
        if link["status"] == "revoked":
            raise WorkoutDomainError("coach_link_revoked", "This coach link was revoked.", 409)
        if link["status"] != "active":
            raise WorkoutDomainError("coach_link_forbidden", "This coach invite is not active yet.", 403)
        if not link.get("permissions", {}).get(permission):
            raise WorkoutDomainError("coach_link_forbidden", f"This coach link does not allow {permission}.", 403)
        return {"account_id": link["trainee_account_id"], "link_id": link_id,
                "permissions": link["permissions"], "trainee_email": link.get("trainee_email")}
