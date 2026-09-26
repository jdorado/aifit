from copy import deepcopy
from types import SimpleNamespace

import pytest

from aifit_api import main
from aifit_api.auth import Identity


class Accounts:
    def __init__(self):
        self.docs = {}

    async def find_one_and_update(self, query, update, **_kwargs):
        key = query["privy_subject"]
        existing = self.docs.get(key)
        if existing is None:
            doc = {"privy_subject": key, **deepcopy(update.get("$setOnInsert", {})), **deepcopy(update.get("$set", {}))}
            self.docs[key] = doc
            return deepcopy(doc)
        existing.update(deepcopy(update.get("$set", {})))
        return deepcopy(existing)

    async def find_one(self, query, _projection=None):
        return next((deepcopy(doc) for doc in self.docs.values()
                     if doc.get("account_id") == query.get("account_id")), None)

    async def update_one(self, query, update):
        for doc in self.docs.values():
            if doc.get("account_id") == query.get("account_id"):
                doc.update(deepcopy(update["$set"]))
                return


@pytest.mark.asyncio
async def test_account_is_created_from_privy_identity(monkeypatch):
    accounts = Accounts()
    monkeypatch.setattr(main, "db", SimpleNamespace(accounts=accounts))
    identity = Identity(subject="did:privy:owner", email="owner@example.com")

    created = await main.account_for(identity)
    reused = await main.account_for(identity)

    assert created["privy_subject"] == "did:privy:owner"
    assert created["email"] == "owner@example.com"
    assert created["account_id"] == main.stable_id("acc", identity.subject)
    assert created["tenant_id"] == main.stable_id("ten", identity.subject)
    assert reused["account_id"] == created["account_id"]
    assert "dev:aifit-local" not in accounts.docs
    assert created["account_id"] != main.stable_id("acc", "dev:aifit-local")


@pytest.mark.asyncio
async def test_language_preference_is_saved_to_the_signed_in_account(monkeypatch):
    accounts = Accounts()
    monkeypatch.setattr(main, "db", SimpleNamespace(accounts=accounts))
    pedro = Identity(subject="did:privy:pedro", email="pedro@example.com")
    coach = Identity(subject="did:privy:coach", email="coach@example.com")
    pedro_account = await main.account_for(pedro)
    coach_account = await main.account_for(coach)

    await main.set_account_language(main.LanguagePreferenceInput(language="es"), pedro)

    assert await main.get_account_language(pedro_account) == {"language": "es"}
    assert await main.get_account_language(coach_account) == {"language": None}
    assert main.public_account(await main.account_for(pedro), "ready")["language"] == "es"
