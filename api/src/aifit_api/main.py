import hashlib
import os
from datetime import UTC, datetime
from typing import Any
from urllib.parse import parse_qsl, quote, urlparse
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field
from pymongo import ASCENDING, AsyncMongoClient, ReturnDocument

from .auth import Identity, require_identity
from .ez import call as ez_call, provision_telegram, telegram_provisioning_configured, verified_binding
from .model_policy import fallback_available, fallback_choice, filter_control, require_allowed


def now() -> datetime:
    return datetime.now(UTC)


def stable_id(prefix: str, value: str) -> str:
    return f"{prefix}_{hashlib.sha256(value.encode()).hexdigest()[:16]}"


mongo = AsyncMongoClient(os.getenv("MONGO_URL", "mongodb://localhost:27017"))
db = mongo[os.getenv("MONGO_DB", "aifit_dev")]
app = FastAPI(title="AIFit API", version="0.1.0")
origins = [item.strip() for item in os.getenv(
    "CORS_ORIGINS",
    "http://localhost:5175,http://127.0.0.1:5175,http://[::1]:5175,http://localhost:5176,http://127.0.0.1:5176",
).split(",") if item.strip()]
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_credentials=True, allow_methods=["*"], allow_headers=["Authorization", "Content-Type"])

TERMINAL = {"completed", "failed", "cancelled"}
MAX_INBOX_PAGES = 10
MAX_INBOX_RUNS = 500
MAX_MESSAGES_PER_RUN = 200
MAX_MESSAGE_TEXT = 64_000


class SessionInput(BaseModel):
    model_config = ConfigDict(extra="ignore")
    user_id: str
    payload: dict[str, Any]


class ChatInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str
    request_id: UUID
    message: str = Field(min_length=1, max_length=16_000)
    scope_id: str | None = Field(default=None, max_length=200)
    reference_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    exercise_id: str | None = Field(default=None, min_length=1, max_length=200)
    act_as_owner_id: str | None = None


class ModelSelectionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_session: str | None = None
    cli: str = Field(min_length=1, max_length=80)
    model: str | None = Field(default=None, min_length=1, max_length=160)
    effort: str | None = Field(default=None, min_length=1, max_length=40)


class TelegramBotInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    bot_token: str = Field(min_length=26, max_length=512, pattern=r"^\d{5,}:[A-Za-z0-9_-]{20,}$")


class NewChatInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str
    expected_session: str | None = None
    act_as_owner_id: str | None = None


async def account_for(identity: Identity) -> dict:
    account_id = stable_id("acc", identity.subject)
    tenant_id = stable_id("ten", identity.subject)
    timestamp = now()
    return await db.accounts.find_one_and_update(
        {"privy_subject": identity.subject},
        {"$set": {"email": identity.email, "updated_at": timestamp}, "$setOnInsert": {
            "account_id": account_id, "tenant_id": tenant_id, "role": "administrator", "created_at": timestamp,
        }}, upsert=True, return_document=ReturnDocument.AFTER)


def public_account(account: dict, setup_status: str) -> dict:
    return {"account_id": account["account_id"], "tenant_id": account["tenant_id"], "role": account["role"],
            "email": account.get("email"), "setup": {"status": setup_status, "agent_available": setup_status == "ready"}}


def public_telegram_connection(value: Any, needs_link: bool = False) -> dict:
    if not isinstance(value, dict) or not isinstance(value.get("connected"), bool):
        raise HTTPException(502, "Ez returned an invalid Telegram connection receipt.")
    if value["connected"]:
        if set(value) not in ({"connected"}, {"connected", "ready"}) or ("ready" in value and value["ready"] is not True):
            raise HTTPException(502, "Ez returned an invalid Telegram connection receipt.")
        return {"state": "connected"}
    if not needs_link:
        if set(value) == {"connected"}:
            return {"state": "needs_bot"}
        if set(value) != {"connected", "ready"} or not isinstance(value["ready"], bool):
            raise HTTPException(502, "Ez returned an invalid Telegram connection receipt.")
        return {"state": "ready" if value["ready"] else "needs_bot"}
    if set(value) != {"connected", "url", "expiresAt"}:
        raise HTTPException(502, "Ez returned an invalid Telegram connection receipt.")
    url, expires_at = value["url"], value["expiresAt"]
    if not isinstance(url, str) or not isinstance(expires_at, str):
        raise HTTPException(502, "Ez returned an invalid Telegram connection receipt.")
    parsed = urlparse(url)
    try:
        query = parse_qsl(parsed.query, strict_parsing=True)
    except ValueError as error:
        raise HTTPException(502, "Ez returned an invalid Telegram connection receipt.") from error
    if parsed.scheme != "https" or parsed.netloc != "t.me" or not parsed.path or parsed.params or parsed.fragment:
        raise HTTPException(502, "Ez returned an invalid Telegram connection receipt.")
    username = parsed.path.removeprefix("/")
    if not (5 <= len(username) <= 32) or not username[0].isascii() or not username[0].isalpha() or not all(char.isascii() and (char.isalnum() or char == "_") for char in username):
        raise HTTPException(502, "Ez returned an invalid Telegram connection receipt.")
    if len(query) != 1 or query[0][0] != "start" or len(query[0][1]) != 43:
        raise HTTPException(502, "Ez returned an invalid Telegram connection receipt.")
    if not all(char.isalnum() or char in "_-" for char in query[0][1]):
        raise HTTPException(502, "Ez returned an invalid Telegram connection receipt.")
    try:
        datetime.fromisoformat(expires_at.replace("Z", "+00:00"))
    except ValueError as error:
        raise HTTPException(502, "Ez returned an invalid Telegram connection receipt.") from error
    return {"state": "link", "connect_url": url, "expires_at": expires_at}


async def owned_account(identity: Identity, requested_user_id: str) -> dict:
    account = await account_for(identity)
    if requested_user_id not in {identity.subject, account["account_id"], identity.email}:
        raise HTTPException(403, "Account mismatch.")
    return account


def validated_messages(value: Any) -> list[dict]:
    if not isinstance(value, list) or len(value) > MAX_MESSAGES_PER_RUN:
        raise HTTPException(502, "Ez returned an invalid message list.")
    projected: list[dict] = []
    seen: set[str] = set()
    for item in value:
        if not isinstance(item, dict) or not isinstance(item.get("id"), str) or not isinstance(item.get("text"), str):
            raise HTTPException(502, "Ez returned an invalid message receipt.")
        if not item["id"] or len(item["id"]) > 200 or len(item["text"]) > MAX_MESSAGE_TEXT:
            raise HTTPException(502, "Ez returned an oversized message receipt.")
        if item["id"] not in seen:
            seen.add(item["id"])
            projected.append({"id": item["id"], "text": item["text"]})
    return projected


def validated_preset(value: Any) -> dict | None:
    if value is None:
        return None
    if not isinstance(value, dict) or not isinstance(value.get("id"), str) or not isinstance(value.get("name"), str):
        raise HTTPException(502, "Ez returned an invalid model receipt.")
    if not isinstance(value.get("cli"), str) or not value["cli"]:
        raise HTTPException(502, "Ez returned an invalid model receipt.")
    projected = {"id": value["id"], "name": value["name"], "cli": value["cli"]}
    for field in ("model", "effort"):
        item = value.get(field)
        if item is not None:
            if not isinstance(item, str) or not item:
                raise HTTPException(502, "Ez returned an invalid model receipt.")
            projected[field] = item
    return projected


def public_model_control(value: Any) -> dict:
    if not isinstance(value, dict) or not isinstance(value.get("ai"), dict) or not isinstance(value.get("models"), list):
        raise HTTPException(502, "Ez returned invalid model controls.")
    ai = value["ai"]
    presets = [validated_preset(item) for item in ai.get("presets", [])]
    if any(item is None for item in presets) or not isinstance(ai.get("selectedId"), str):
        raise HTTPException(502, "Ez returned invalid model controls.")
    models: list[dict] = []
    for item in value["models"]:
        if not isinstance(item, dict) or not isinstance(item.get("cli"), str) or not isinstance(item.get("name"), str):
            raise HTTPException(502, "Ez returned invalid model controls.")
        efforts = item.get("efforts", [])
        if not isinstance(efforts, list) or any(not isinstance(effort, str) for effort in efforts):
            raise HTTPException(502, "Ez returned invalid model controls.")
        model = {"cli": item["cli"], "name": item["name"], "efforts": efforts}
        if item.get("model") is not None:
            if not isinstance(item["model"], str):
                raise HTTPException(502, "Ez returned invalid model controls.")
            model["model"] = item["model"]
        models.append(model)
    active_session = value.get("activeSessionId")
    if active_session is not None and not isinstance(active_session, str):
        raise HTTPException(502, "Ez returned invalid model controls.")
    return {"presets": presets, "selected_id": ai["selectedId"], "models": models,
            "active_session_id": active_session}


async def lock_control(binding: dict, identity: Identity, control: dict | None = None) -> dict:
    current = control or public_model_control(await ez_call(binding, "GET", "/v1/control"))
    filtered = filter_control(current, identity.subject)
    fallback = fallback_choice(identity.subject)
    if filtered["selected_id"] or fallback is None or not fallback_available(filtered, fallback):
        return filtered
    require_allowed(identity.subject, fallback.cli, fallback.model, fallback.effort)
    selection: dict[str, Any] = {
        "action": "model", "expectedSession": current["active_session_id"],
        "cli": fallback.cli, "model": fallback.model, "effort": fallback.effort,
    }
    return filter_control(public_model_control(await ez_call(binding, "POST", "/v1/control", selection)), identity.subject)


def public_turn(turn: dict) -> dict:
    messages = validated_messages(turn.get("messages", []))
    result: dict[str, Any] = {"job_id": turn["request_id"], "request_id": turn["request_id"],
                              "status": "complete" if turn["status"] == "completed" else turn["status"], "messages": messages}
    if messages:
        result["reply"] = messages[-1]["text"]
    if turn.get("error"):
        result["error"] = turn["error"]
    preset = validated_preset(turn.get("preset"))
    if preset:
        result["preset"] = preset
    return result


async def reconcile_turn(account: dict, turn: dict, snapshot: dict | None = None) -> dict:
    if not turn.get("run_id") or (turn["status"] in TERMINAL and turn.get("preset")):
        return turn
    binding = await verified_binding(account["account_id"])
    if turn.get("binding_id") != binding["bindingId"]:
        raise HTTPException(409, "This message belongs to an earlier Ez binding.")
    current = snapshot or await ez_call(binding, "GET", f"/v1/runs/{turn['run_id']}")
    status = current.get("status")
    if not isinstance(status, str):
        raise HTTPException(502, "Ez returned an invalid run status.")
    update: dict[str, Any] = {"status": status, "messages": validated_messages(current.get("messages")), "updated_at": now()}
    preset = validated_preset(current.get("preset"))
    if preset:
        update["preset"] = preset
    if status == "failed":
        update["error"] = current.get("error", "Agent run failed.")
    update_guard: dict[str, Any] = {"_id": turn["_id"]}
    if turn["status"] in TERMINAL:
        update_guard["preset"] = {"$exists": False}
    else:
        update_guard["status"] = {"$nin": list(TERMINAL)}
    await db.chat_turns.update_one(update_guard, {"$set": update})
    return await db.chat_turns.find_one({"_id": turn["_id"]})


@app.on_event("startup")
async def indexes() -> None:
    await db.accounts.create_index([("privy_subject", ASCENDING)], unique=True)
    await db.accounts.create_index([("account_id", ASCENDING)], unique=True)
    await db.sessions.create_index([("account_id", ASCENDING)], unique=True)
    # Stage 1 originally stored one document per projected chat message. The
    # Step 3 turn model intentionally omits those legacy fields, so retaining
    # their unique index makes every turn after the first collide on null/null.
    legacy_chat_index = await db.chat_turns.index_information()
    legacy_job_role = legacy_chat_index.get("job_id_1_role_1")
    if legacy_job_role and legacy_job_role.get("key") == [("job_id", 1), ("role", 1)]:
        await db.chat_turns.drop_index("job_id_1_role_1")
    await db.chat_turns.create_index(
        [("tenant_id", ASCENDING), ("request_id", ASCENDING)],
        unique=True,
        partialFilterExpression={"tenant_id": {"$type": "string"}, "request_id": {"$type": "string"}},
    )
    await db.chat_turns.create_index([("run_id", ASCENDING)], sparse=True)


@app.get("/health")
async def health() -> dict:
    await db.command("ping")
    return {"status": "ok"}


@app.get("/account")
async def get_account(identity: Identity = Depends(require_identity)) -> dict:
    account = await account_for(identity)
    try:
        await verified_binding(account["account_id"])
        ready = True
    except HTTPException:
        ready = False
    return public_account(account, "ready" if ready else "setup_required")


@app.get("/account/telegram")
async def get_telegram_connection(identity: Identity = Depends(require_identity)) -> dict:
    account = await account_for(identity)
    binding = await verified_binding(account["account_id"])
    try:
        receipt = await ez_call(binding, "GET", "/v1/telegram")
    except HTTPException as error:
        if error.status_code in {400, 404, 503} and telegram_provisioning_configured(binding):
            return {"state": "needs_bot"}
        raise
    return public_telegram_connection(receipt)


@app.post("/account/telegram/link")
async def create_telegram_connection(identity: Identity = Depends(require_identity)) -> dict:
    account = await account_for(identity)
    binding = await verified_binding(account["account_id"])
    try:
        connection = await ez_call(binding, "POST", "/v1/telegram/link")
    except HTTPException as error:
        if error.status_code in {400, 403}:
            raise HTTPException(409, "Telegram is not available for this agent yet.") from error
        raise
    return public_telegram_connection(connection, needs_link=True)


@app.post("/account/telegram/bot")
async def configure_telegram_bot(body: TelegramBotInput, identity: Identity = Depends(require_identity)) -> dict:
    account = await account_for(identity)
    binding = await verified_binding(account["account_id"])
    await provision_telegram(binding, body.bot_token)
    try:
        connection = await ez_call(binding, "POST", "/v1/telegram/link")
    except HTTPException as error:
        if error.status_code in {400, 403}:
            raise HTTPException(503, "Telegram started but is not ready to issue a connection link yet.") from error
        raise
    return public_telegram_connection(connection, needs_link=True)


@app.get("/chat/models")
async def chat_models(identity: Identity = Depends(require_identity)) -> dict:
    account = await account_for(identity)
    binding = await verified_binding(account["account_id"])
    return await lock_control(binding, identity)


@app.post("/chat/models")
async def select_chat_model(body: ModelSelectionInput, identity: Identity = Depends(require_identity)) -> dict:
    account = await account_for(identity)
    binding = await verified_binding(account["account_id"])
    require_allowed(identity.subject, body.cli, body.model, body.effort)
    selection: dict[str, Any] = {"action": "model", "expectedSession": body.expected_session, "cli": body.cli}
    if body.model is not None:
        selection["model"] = body.model
    if body.effort is not None:
        selection["effort"] = body.effort
    fresh = public_model_control(await ez_call(binding, "POST", "/v1/control", {
        "action": "new", "expectedSession": body.expected_session,
    }))
    selection["expectedSession"] = fresh["active_session_id"]
    control = public_model_control(await ez_call(binding, "POST", "/v1/control", selection))
    await db.chat_turns.delete_many({"tenant_id": account["tenant_id"]})
    return await lock_control(binding, identity, control)


@app.post("/chat/clear")
async def clear_chat(body: NewChatInput, identity: Identity = Depends(require_identity)) -> dict:
    if body.act_as_owner_id:
        raise HTTPException(403, "Coach mode is not part of Stage 1.")
    account = await owned_account(identity, body.user_id)
    binding = await verified_binding(account["account_id"])
    control = public_model_control(await ez_call(binding, "POST", "/v1/control", {
        "action": "new", "expectedSession": body.expected_session,
    }))
    await db.chat_turns.delete_many({"tenant_id": account["tenant_id"]})
    return await lock_control(binding, identity, control)


@app.get("/sessions/latest")
async def latest_session(user_id: str, identity: Identity = Depends(require_identity)) -> dict:
    account = await owned_account(identity, user_id)
    session = await db.sessions.find_one({"account_id": account["account_id"]})
    if not session:
        raise HTTPException(404, "No session yet.")
    return {"user_id": identity.subject, "payload": session["payload"], "created_at": session["created_at"],
            "updated_at": session["updated_at"], "profile_revision": None, "training_plan_revision": None}


@app.post("/sessions")
async def save_session(body: SessionInput, identity: Identity = Depends(require_identity)) -> dict:
    account = await owned_account(identity, body.user_id)
    timestamp = now()
    session = await db.sessions.find_one_and_update(
        {"account_id": account["account_id"]},
        {"$set": {"payload": body.payload, "updated_at": timestamp}, "$setOnInsert": {"created_at": timestamp}},
        upsert=True, return_document=ReturnDocument.AFTER)
    return {"user_id": identity.subject, "payload": session["payload"], "created_at": session["created_at"],
            "updated_at": session["updated_at"], "profile_revision": None, "training_plan_revision": None}


async def inbox_snapshots(binding: dict) -> list[dict]:
    page = await ez_call(binding, "GET", "/v1/runs")
    snapshots: list[dict] = []
    seen: set[str] = set()
    for _ in range(MAX_INBOX_PAGES):
        runs = page.get("runs")
        if not isinstance(runs, list) or any(not isinstance(item, dict) or not isinstance(item.get("id"), str) for item in runs):
            raise HTTPException(502, "Ez returned an invalid inbox.")
        snapshots = runs + snapshots
        if len(snapshots) > MAX_INBOX_RUNS:
            raise HTTPException(502, "Ez returned an oversized inbox.")
        cursor = page.get("nextCursor")
        if not cursor:
            return snapshots
        if not isinstance(cursor, str) or cursor in seen or len(cursor) > 500:
            raise HTTPException(502, "Ez returned an invalid inbox cursor.")
        seen.add(cursor)
        page = await ez_call(binding, "GET", "/v1/runs?before=" + quote(cursor, safe=""))
    raise HTTPException(502, "Ez inbox pagination limit reached.")


@app.get("/chat/history")
async def chat_history(user_id: str, limit: int = 40, identity: Identity = Depends(require_identity)) -> list[dict]:
    account = await owned_account(identity, user_id)
    try:
        binding = await verified_binding(account["account_id"])
        snapshots = await inbox_snapshots(binding)
        run_ids = [snapshot.get("originRunId", snapshot["id"]) for snapshot in snapshots]
        turns = await db.chat_turns.find({"tenant_id": account["tenant_id"], "binding_id": binding["bindingId"],
                                          "run_id": {"$in": run_ids}}).to_list()
        by_run = {turn["run_id"]: turn for turn in turns}
        for snapshot in snapshots:
            turn = by_run.get(snapshot.get("originRunId", snapshot["id"]))
            if turn and (turn["status"] not in TERMINAL or not turn.get("preset")):
                await reconcile_turn(account, turn, snapshot)
    except HTTPException:
        pass
    rows = await db.chat_turns.find({"tenant_id": account["tenant_id"]}).sort("created_at", -1).limit(min(max(limit, 1), 100)).to_list()
    rows.reverse()
    history: list[dict] = []
    for row in rows:
        history.append({"id": row["request_id"], "role": "user", "content": row["text"], "timestamp": row["created_at"].isoformat()})
        preset = validated_preset(row.get("preset"))
        history.extend({"id": item["id"], "role": "ai", "content": item["text"], "timestamp": row["updated_at"].isoformat(),
                        **({"agent_cli": preset["cli"], "agent_model": preset.get("model"),
                            "agent_reasoning_effort": preset.get("effort"), "agent_label": preset["name"]} if preset else {})}
                       for item in validated_messages(row.get("messages", [])))
    return history


@app.post("/chat/async", status_code=202)
async def enqueue_chat(body: ChatInput, identity: Identity = Depends(require_identity)) -> dict:
    if body.act_as_owner_id:
        raise HTTPException(403, "Coach mode is not part of Stage 1.")
    account = await owned_account(identity, body.user_id)
    binding = await verified_binding(account["account_id"])
    request_id = str(body.request_id)
    key = f"{account['tenant_id']}:{request_id}"
    references = {key: value for key, value in {"scopeId": body.scope_id, "referenceDate": body.reference_date,
                                                 "exerciseId": body.exercise_id}.items() if value is not None}
    timestamp = now()
    turn = await db.chat_turns.find_one_and_update({"_id": key}, {"$setOnInsert": {
        "tenant_id": account["tenant_id"], "account_id": account["account_id"], "request_id": request_id,
        "text": body.message, "references": references, "binding_id": binding["bindingId"], "status": "submitting",
        "messages": [], "created_at": timestamp, "updated_at": timestamp,
    }}, upsert=True, return_document=ReturnDocument.AFTER)
    if turn["text"] != body.message or turn.get("references", {}) != references or turn.get("binding_id") != binding["bindingId"]:
        raise HTTPException(409, "This request already contains different content or binding.")
    if turn["status"] not in TERMINAL:
        if not turn.get("run_id"):
            if fallback_choice(identity.subject) is not None:
                locked = await lock_control(binding, identity)
                if not locked["selected_id"]:
                    raise HTTPException(403, "This model is not enabled for this AIFit account.")
            admission: dict[str, Any] = {"requestId": request_id, "scope": "owner-chat", "text": turn["text"], "followOwner": True}
            if references:
                admission["context"] = references
            run = await ez_call(binding, "POST", "/v1/runs", admission)
            if not isinstance(run.get("id"), str):
                raise HTTPException(502, "Ez returned an invalid run receipt.")
            await db.chat_turns.update_one({"_id": key}, {"$set": {"run_id": run["id"], "updated_at": now()}})
            turn = await db.chat_turns.find_one({"_id": key})
        turn = await reconcile_turn(account, turn)
    return public_turn(turn)


@app.get("/chat/jobs/{job_id}")
async def chat_job(job_id: UUID, user_id: str, identity: Identity = Depends(require_identity)) -> dict:
    account = await owned_account(identity, user_id)
    turn = await db.chat_turns.find_one({"_id": f"{account['tenant_id']}:{job_id}"})
    if not turn:
        raise HTTPException(404, "Chat job not found.")
    return public_turn(await reconcile_turn(account, turn))


@app.post("/chat/jobs/{request_id}/cancel")
async def cancel_chat(request_id: UUID, user_id: str, identity: Identity = Depends(require_identity)) -> dict:
    account = await owned_account(identity, user_id)
    turn = await db.chat_turns.find_one({"_id": f"{account['tenant_id']}:{request_id}"})
    if not turn:
        raise HTTPException(404, "Chat job not found.")
    if not turn.get("run_id"):
        raise HTTPException(409, "Check the submission outcome before cancelling.")
    if turn["status"] not in TERMINAL:
        binding = await verified_binding(account["account_id"])
        if turn.get("binding_id") != binding["bindingId"]:
            raise HTTPException(409, "This message belongs to an earlier Ez binding.")
        await ez_call(binding, "POST", f"/v1/runs/{turn['run_id']}/cancel", {})
    return public_turn(await reconcile_turn(account, turn))


@app.post("/chat/jobs/{request_id}/retry", status_code=202)
async def retry_chat(request_id: UUID, user_id: str, identity: Identity = Depends(require_identity)) -> dict:
    account = await owned_account(identity, user_id)
    turn = await db.chat_turns.find_one({"_id": f"{account['tenant_id']}:{request_id}"})
    if not turn:
        raise HTTPException(404, "Chat job not found.")
    refs = turn.get("references", {})
    return await enqueue_chat(ChatInput(user_id=user_id, request_id=request_id, message=turn["text"],
                                        scope_id=refs.get("scopeId"), reference_date=refs.get("referenceDate"),
                                        exercise_id=refs.get("exerciseId")), identity)
