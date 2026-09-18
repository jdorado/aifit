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
    monkeypatch.setattr(auth, "AIFIT_DEV_AUTH_TOKEN", "")
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
