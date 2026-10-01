import time

import jwt
import pytest
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.hazmat.primitives.serialization import Encoding, PublicFormat
from fastapi import HTTPException

from aifit_api import auth


def _token(claims: dict, key) -> str:
    return jwt.encode(claims, key, algorithm="ES256")


@pytest.fixture
def privy_key(monkeypatch):
    key = ec.generate_private_key(ec.SECP256R1())
    pem = key.public_key().public_bytes(Encoding.PEM, PublicFormat.SubjectPublicKeyInfo).decode()
    monkeypatch.setattr(auth, "PRIVY_APP_ID", "test-app")
    monkeypatch.setattr(auth, "PRIVY_APP_SECRET", "test-secret")
    async def verification_key() -> str:
        return pem
    monkeypatch.setattr(auth, "_verification_key", verification_key)
    return key


def _claims(**overrides) -> dict:
    now = int(time.time())
    return {
        "sub": "did:privy:owner",
        "email": "owner@example.com",
        "iss": "privy.io",
        "aud": "test-app",
        "iat": now,
        "exp": now + 60,
        **overrides,
    }


@pytest.mark.asyncio
async def test_privy_token_returns_real_subject(privy_key):
    identity = await auth.require_identity(f"Bearer {_token(_claims(), privy_key)}")
    assert identity.subject == "did:privy:owner"


@pytest.mark.asyncio
async def test_non_privy_subject_is_rejected(privy_key):
    token = _token(_claims(sub="dev:aifit-local"), privy_key)
    with pytest.raises(HTTPException) as error:
        await auth.require_identity(f"Bearer {token}")
    assert error.value.status_code == 401


@pytest.mark.asyncio
async def test_wrong_audience_is_rejected(privy_key):
    token = _token(_claims(aud="another-app"), privy_key)
    with pytest.raises(HTTPException) as error:
        await auth.require_identity(f"Bearer {token}")
    assert error.value.status_code == 401


@pytest.mark.asyncio
async def test_missing_bearer_is_rejected():
    with pytest.raises(HTTPException) as error:
        await auth.require_identity(None)
    assert error.value.status_code == 401


@pytest.mark.parametrize("request_id", [
    "job_1",
    "blueprint-2026-09-21-a",
    "override-2026-09-21-b",
    "swap-2026-09-21-c",
])
def test_agent_write_accepts_unique_per_write_request_ids(request_id):
    capability = auth.AgentCapability(
        "acc_1", "tenant_1", "job_1",
        frozenset({"blueprints:write", "workouts:override", "workouts:swap"}),
    )

    assert auth.require_agent_request(capability, request_id) is None


def test_agent_write_rejects_missing_run_scope():
    capability = auth.AgentCapability(
        "acc_1", "tenant_1", "",
        frozenset({"blueprints:write"}),
    )

    with pytest.raises(HTTPException) as error:
        auth.require_agent_request(capability, "blueprint-2026-09-21-a")
    assert error.value.status_code == 403


def test_capability_secret_falls_back_to_ephemeral_process_secret(monkeypatch):
    monkeypatch.setattr(auth, "AIFIT_AGENT_CAPABILITY_SECRET", "")
    monkeypatch.setattr(auth, "_ephemeral_warned", True)

    first = auth._agent_capability_secret()
    assert len(first) >= 32
    assert auth._agent_capability_secret() == first

@pytest.mark.asyncio
async def test_installed_plugin_credential_is_tenant_bound_and_revocable(monkeypatch):
    import hashlib
    from aifit_api import main
    token = 'aifit_plugin_' + 'private-test-token' * 4
    digest = hashlib.sha256(token.encode()).hexdigest()
    account = {"account_id": "acc_one", "tenant_id": "tenant_one"}
    class Accounts:
        async def find_one(self, query):
            return account if query == {"agent_plugin_token_hash": digest} else None
    class Database:
        accounts = Accounts()
    monkeypatch.setattr(main, "db", Database())
    capability = await auth.require_agent_capability(f'Bearer {token}')
    assert (capability.account_id, capability.tenant_id) == ('acc_one', 'tenant_one')
    assert capability.permissions == frozenset({'aifit:read', 'aifit:write'})
    with pytest.raises(HTTPException) as invalid:
        await auth.require_agent_capability(f'Bearer {token}-wrong')
    assert invalid.value.status_code == 401
    account.clear()  # canonical revocation removes the lookup
    with pytest.raises(HTTPException) as revoked:
        await auth.require_agent_capability(f'Bearer {token}')
    assert revoked.value.status_code == 401

@pytest.mark.asyncio
async def test_operator_credential_issuance_is_private_and_idempotent(monkeypatch, tmp_path):
    import hashlib
    import json
    from types import SimpleNamespace
    from aifit_api import plugin_credentials
    account = {"account_id": "acc_one", "tenant_id": "tenant_one"}
    class Accounts:
        async def find_one(self, query):
            return account if query.get('account_id') == account['account_id'] else None
        async def update_one(self, query, update):
            if '$unset' in update:
                account.pop('agent_plugin_token_hash', None)
            else:
                account.update(update['$set'])
            return SimpleNamespace(modified_count=1)
    monkeypatch.setattr(plugin_credentials, 'db', SimpleNamespace(accounts=Accounts()))
    output = tmp_path / 'connection.json'
    await plugin_credentials.issue('acc_one', 'https://aifit.test', output)
    original = output.read_bytes()
    token = json.loads(original)['capability']
    assert account['agent_plugin_token_hash'] == hashlib.sha256(token.encode()).hexdigest()
    assert output.stat().st_mode & 0o077 == 0
    await plugin_credentials.issue('acc_one', 'https://aifit.test', output)
    assert output.read_bytes() == original
    with pytest.raises(ValueError, match='Registered tenant'):
        await plugin_credentials.issue('acc_other', 'https://aifit.test', tmp_path / 'other.json')
    with pytest.raises(ValueError, match='already issued'):
        await plugin_credentials.issue('acc_one', 'https://aifit.test', tmp_path / 'duplicate.json')
    await plugin_credentials.issue('acc_one', 'https://aifit.test', None, revoke=True)
    assert 'agent_plugin_token_hash' not in account
