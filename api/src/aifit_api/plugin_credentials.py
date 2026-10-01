"""Operator-only tenant plugin credential issuance; never an engine runner."""
import argparse
import asyncio
import hashlib
import json
import os
import secrets
from pathlib import Path
from urllib.parse import urlparse

from .main import db


async def issue(account_id: str, api_url: str, output: Path | None, revoke: bool = False) -> None:
    account = await db.accounts.find_one({"account_id": account_id})
    if not account or not account.get("tenant_id"):
        raise ValueError("Registered tenant account required")
    if revoke:
        await db.accounts.update_one({"account_id": account_id}, {"$unset": {"agent_plugin_token_hash": ""}})
        return
    parsed = urlparse(api_url)
    if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password or parsed.query or parsed.fragment or parsed.path:
        raise ValueError("An HTTPS API origin is required")
    if output is None or not output.is_absolute():
        raise ValueError("Absolute private output path required")
    if output.exists():
        if output.is_symlink() or output.stat().st_mode & 0o077:
            raise ValueError("Output must be a private regular file")
        existing = json.loads(output.read_text())
        digest = hashlib.sha256(existing["capability"].encode()).hexdigest()
        if digest == account.get("agent_plugin_token_hash") and existing["api_base_url"] == api_url:
            return
        raise ValueError("Output already exists with a different binding")
    if account.get("agent_plugin_token_hash"):
        raise ValueError("Credential already issued; reuse its private file or revoke explicitly before replacement")
    token = "aifit_plugin_" + secrets.token_urlsafe(48)
    digest = hashlib.sha256(token.encode()).hexdigest()
    descriptor = os.open(output, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        json.dump({"api_base_url": api_url, "capability": token}, stream)
        stream.write("\n")
    result = await db.accounts.update_one(
        {"account_id": account_id, "agent_plugin_token_hash": {"$exists": False}},
        {"$set": {"agent_plugin_token_hash": digest}},
    )
    if result.modified_count != 1:
        output.unlink()
        raise ValueError("Credential binding changed; no credential issued")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--account-id", required=True)
    parser.add_argument("--api-url", default="https://api.aifit.living")
    parser.add_argument("--output", type=Path)
    parser.add_argument("--revoke", action="store_true")
    args = parser.parse_args()
    asyncio.run(issue(args.account_id, args.api_url, args.output, args.revoke))
    print(json.dumps({"ok": True, "account_id": args.account_id, "revoked": args.revoke}))


if __name__ == "__main__":
    main()
