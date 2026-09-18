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
