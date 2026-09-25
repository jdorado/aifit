import asyncio
import hashlib
import logging
import os
from datetime import UTC, datetime
from typing import Annotated, Any, Literal
from urllib.parse import parse_qsl, quote, urlparse
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, ConfigDict, Field
from pymongo import ASCENDING, AsyncMongoClient, ReturnDocument

from .auth import (
    AgentCapability,
    Identity,
    mint_agent_capability,
    require_agent_capability,
    require_agent_request,
    require_identity,
)
from . import telegram_admit
from . import videos
from .coach_links import (
    CoachLinkAcceptInput,
    CoachLinkInviteInput,
    CoachLinkRole,
    CoachLinkService,
    CoachLinkUpdateInput,
)
from .ez import call as ez_call, provision_telegram, verified_binding
from .model_policy import filter_control, require_allowed
from .workouts import (
    BlueprintInput,
    ClearWorkoutInput,
    CopyLastWeekInput,
    ExerciseDefinitionInput,
    ExerciseNoteInput,
    GenerateInput,
    PlanEntryRemoveInput,
    PlanInput,
    PlanItemMoveInput,
    PlanItemExtractInput,
    ExerciseAddInput,
    PlanReorderInput,
    PublishInput,
    SetAddInput,
    SetLogInput,
    SetRemoveInput,
    SetTargetInput,
    SetUnlogInput,
    SwapInput,
    WorkoutDomainError,
    WorkoutNotesInput,
    WorkoutOverrideInput,
    WorkoutService,
)


def now() -> datetime:
    return datetime.now(UTC)


def stable_id(prefix: str, value: str) -> str:
    return f"{prefix}_{hashlib.sha256(value.encode()).hexdigest()[:16]}"


mongo = AsyncMongoClient(os.getenv("MONGO_URL", "mongodb://localhost:27017"))
db = mongo[os.getenv("MONGO_DB", "aifit_dev")]
app = FastAPI(title="AIFit API", version="0.1.0-beta.1")
origins = [item.strip() for item in os.getenv(
    "CORS_ORIGINS",
    "http://localhost:5175,http://127.0.0.1:5175,http://[::1]:5175,http://localhost:5176,http://127.0.0.1:5176",
).split(",") if item.strip()]
origin_regex = os.getenv("CORS_ORIGIN_REGEX", "").strip() or None
app.add_middleware(CORSMiddleware, allow_origins=origins, allow_origin_regex=origin_regex, allow_credentials=True, allow_methods=["*"], allow_headers=["Authorization", "Content-Type"])


@app.exception_handler(WorkoutDomainError)
async def workout_domain_error(_request: Request, error: WorkoutDomainError) -> JSONResponse:
    return JSONResponse(status_code=error.status_code, content={"detail": {"code": error.code, "message": error.message}})


@app.exception_handler(RequestValidationError)
async def request_validation_error(_request: Request, error: RequestValidationError) -> JSONResponse:
    """Keep the documented {code, message} error contract for typed failures."""
    errors = [
        {"loc": [str(part) for part in item.get("loc", [])], "msg": str(item.get("msg", "invalid value")),
         "type": str(item.get("type", "value_error"))}
        for item in error.errors()
    ]
    summary = "; ".join(f"{'.'.join(item['loc'])}: {item['msg']}" for item in errors) or "Invalid request."
    return JSONResponse(status_code=422, content={"detail": {"code": "validation_error", "message": summary, "errors": errors}})

MAX_INBOX_PAGES = 10
MAX_INBOX_RUNS = 500
MAX_MESSAGES_PER_RUN = 200
MAX_MESSAGE_TEXT = 64_000
AGENT_API_BASE_URL = os.getenv("AIFIT_AGENT_API_BASE_URL", "").rstrip("/")

logger = logging.getLogger("aifit.api")
if not AGENT_API_BASE_URL:
    logger.warning(
        "AIFIT_AGENT_API_BASE_URL is not configured; chat runs are admitted "
        "without AIFit plugin context and every agent write refuses with "
        "'no scoped application context'.")


def agent_api_base_url() -> str | None:
    """Accept only an operator-supplied HTTP(S) origin without userinfo."""
    value = AGENT_API_BASE_URL.strip()
    if not value or any(character.isspace() for character in value):
        return None
    parsed = urlparse(value)
    if parsed.scheme not in {"http", "https"} or not parsed.hostname:
        return None
    if parsed.username or parsed.password or parsed.query or parsed.fragment:
        return None
    return value


def workouts() -> WorkoutService:
    return WorkoutService(db)


def coach_links() -> CoachLinkService:
    return CoachLinkService(db)


def agent_actor(capability: AgentCapability) -> dict[str, str]:
    return {"kind": "agent", "job_id": capability.job_id}


AGENT_READ = "aifit:read"
AGENT_WRITE = "aifit:write"


def require_agent_permission(capability: AgentCapability, permission: str) -> None:
    if permission not in capability.permissions:
        raise HTTPException(403, "This agent run does not have the required AIFit permission.")


def agent_run_context(account: dict[str, Any], request_id: str) -> dict[str, Any] | None:
    """Opaque data for the AIFit Ez plugin; never sent to or stored by the browser."""
    api_base_url = agent_api_base_url()
    if not api_base_url:
        return None
    return {"plugins": {"aifit": {
        "api_base_url": api_base_url,
        "capability": mint_agent_capability(
            account_id=account["account_id"], tenant_id=account["tenant_id"], job_id=request_id,
            permissions={AGENT_READ, AGENT_WRITE},
        ),
    }}}


OWNER_CHAT_SCOPE = "owner-chat"
MINI_CHAT_SCOPE = "owner-minichat"
ChatScope = Literal["owner-chat", "owner-minichat"]


class ChatInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str
    request_id: UUID
    message: str = Field(min_length=1, max_length=16_000)
    scope: ChatScope = OWNER_CHAT_SCOPE
    scope_id: str | None = Field(default=None, max_length=200)
    reference_date: str | None = Field(default=None, pattern=r"^\d{4}-\d{2}-\d{2}$")
    exercise_id: str | None = Field(default=None, min_length=1, max_length=200)
    workout_id: str | None = Field(default=None, min_length=1, max_length=200)
    exercise_instance_id: str | None = Field(default=None, min_length=1, max_length=200)
    expected_revision: str | None = Field(default=None, pattern=r"^rev_[a-f0-9]{32}$")
    act_as_link_id: str | None = Field(default=None, max_length=200)


class ModelSelectionInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    expected_session: str | None = None
    scope: ChatScope = OWNER_CHAT_SCOPE
    act_as_link_id: str | None = Field(default=None, max_length=200)
    cli: str = Field(min_length=1, max_length=80)
    provider: str | None = Field(default=None, min_length=1, max_length=80)
    model: str | None = Field(default=None, min_length=1, max_length=160)
    effort: str | None = Field(default=None, min_length=1, max_length=40)


class TelegramBotInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    bot_token: str = Field(min_length=26, max_length=512, pattern=r"^\d{5,}:[A-Za-z0-9_-]{20,}$")


class NewChatInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    user_id: str
    expected_session: str | None = None


class PlanDraftInput(PlanInput):
    expected_revision: str | None = Field(default=None, pattern=r"^rev_[a-f0-9]{32}$")
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")
    plan_id: str | None = Field(default=None, pattern=r"^plan_[a-f0-9]{32}$")


class BlueprintDraftInput(BlueprintInput):
    expected_revision: str | None = Field(default=None, pattern=r"^rev_[a-f0-9]{32}$")
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")
    blueprint_id: str | None = Field(default=None, pattern=r"^bp_[a-f0-9]{32}$")


class BlueprintSolidifyInput(BlueprintInput):
    expected_revision: str | None = Field(default=None, pattern=r"^rev_[a-f0-9]{32}$")
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")
    blueprint_id: str | None = Field(default=None, pattern=r"^bp_[a-f0-9]{32}$")


class ExerciseMutationInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    definition: ExerciseDefinitionInput
    expected_revision: str | None = Field(default=None, pattern=r"^rev_[a-f0-9]{32}$")
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")


class WorkoutScopeInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    kind: Literal["workout", "workout_exercise"]
    workout_id: str = Field(min_length=1, max_length=200)
    exercise_instance_id: str | None = Field(default=None, min_length=1, max_length=200)


class AgentMessageInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    conversation_id: str = Field(min_length=1, max_length=200, pattern=r"^[A-Za-z0-9_.:-]+$")
    request_id: UUID
    message: str = Field(min_length=1, max_length=16_000)
    scope: WorkoutScopeInput


class AgentWorkoutSwapInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    workout_id: str = Field(pattern=r"^wrk_[a-f0-9]{32}$")
    exercise_instance_id: str = Field(pattern=r"^wex_[a-f0-9]{32}$")
    reason: str = Field(min_length=1, max_length=500)
    source: Literal["default", "jev"] = "jev"
    target_candidate_id: str | None = Field(default=None, pattern=r"^cand_[a-z0-9_]{3,120}$")
    expected_revision: str = Field(pattern=r"^rev_[a-f0-9]{32}$")
    expected_blueprint_revision: str = Field(pattern=r"^rev_[a-f0-9]{32}$")
    request_id: str = Field(min_length=1, max_length=160, pattern=r"^[A-Za-z0-9_.:-]+$")


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
        if set(value) not in ({"connected"}, {"connected", "ready"}) or ("ready" in value and not isinstance(value["ready"], bool)):
            raise HTTPException(502, "Ez returned an invalid Telegram connection receipt.")
        # The saved pairing survives paused polling and transport outages.
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


async def chat_account(identity: Identity, requested_user_id: str, act_as_link_id: str | None) -> dict[str, Any]:
    """Resolve the account a chat turn runs as.

    Without a link this is the signed-in owner's own account. With one, the
    stored coach link is re-checked (`edit_programs` implies coach chat, as in
    the legacy access rule) and the turn runs in the trainee's bound agent. A
    trainee without a binding fails exactly like an unbound owner.
    """
    if not act_as_link_id:
        return await owned_account(identity, requested_user_id)
    coach = await account_for(identity)
    resolved = await coach_links().resolve_act_as(coach["account_id"], act_as_link_id, "edit_programs")
    trainee = await db.accounts.find_one({"account_id": resolved["account_id"]})
    if not trainee:
        raise HTTPException(404, "Coach link trainee was not found.")
    return trainee


def chat_run_scope(scope: ChatScope, act_as_link_id: str | None) -> str:
    return stable_id("coach", f"{act_as_link_id}:{scope}") if act_as_link_id else scope


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
    provider = value.get("provider")
    if provider is not None and (not isinstance(provider, str) or not provider or len(provider) > 80):
        raise HTTPException(502, "Ez returned an invalid model receipt.")
    if provider:
        projected["provider"] = provider
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
        provider = item.get("provider")
        if provider is not None and (not isinstance(provider, str) or not provider or len(provider) > 80):
            raise HTTPException(502, "Ez returned invalid model controls.")
        if provider:
            model["provider"] = provider
        models.append(model)
    active_session = value.get("activeSessionId")
    if active_session is not None and not isinstance(active_session, str):
        raise HTTPException(502, "Ez returned invalid model controls.")
    return {"presets": presets, "selected_id": ai["selectedId"], "models": models,
            "active_session_id": active_session}


async def lock_control(binding: dict, identity: Identity, control: dict | None = None) -> dict:
    """Thin transport: filter the Ez control catalog, never auto-select."""
    current = control or public_model_control(await ez_call(binding, "GET", "/v1/control"))
    return filter_control(current, identity.subject)


def public_turn_from_snapshot(run_id: str, request_id: str, snapshot: dict) -> dict:
    """Map one Ez run snapshot to the public turn shape without storing."""
    status = snapshot.get("status")
    if not isinstance(status, str):
        raise HTTPException(502, "Ez returned an invalid run status.")
    messages = validated_messages(snapshot.get("messages", []))
    result: dict[str, Any] = {"job_id": run_id, "request_id": request_id,
                              "status": "complete" if status == "completed" else status, "messages": messages}
    if messages:
        result["reply"] = messages[-1]["text"]
    if snapshot.get("error"):
        result["error"] = snapshot["error"]
    preset = validated_preset(snapshot.get("preset"))
    if preset:
        result["preset"] = preset
    return result


_telegram_admit_task: asyncio.Task | None = None
_telegram_admit_stop: asyncio.Event | None = None


@app.on_event("startup")
async def indexes() -> None:
    await db.accounts.create_index([("privy_subject", ASCENDING)], unique=True)
    await db.accounts.create_index([("account_id", ASCENDING)], unique=True)
    await workouts().ensure_indexes()
    await coach_links().ensure_indexes()
    global _telegram_admit_task, _telegram_admit_stop
    if telegram_admit.admit_enabled() and _telegram_admit_task is None:
        _telegram_admit_stop = asyncio.Event()
        _telegram_admit_task = asyncio.create_task(telegram_admit.run_forever(_telegram_admit_stop))


@app.on_event("shutdown")
async def stop_background() -> None:
    global _telegram_admit_task, _telegram_admit_stop
    if _telegram_admit_stop is not None:
        _telegram_admit_stop.set()
    if _telegram_admit_task is not None:
        await asyncio.gather(_telegram_admit_task, return_exceptions=True)
    _telegram_admit_task, _telegram_admit_stop = None, None


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
    binding = await verified_binding(account["account_id"], telegram=True)
    receipt = await ez_call(binding, "GET", "/v1/telegram")
    return public_telegram_connection(receipt)


@app.post("/account/telegram/link")
async def create_telegram_connection(identity: Identity = Depends(require_identity)) -> dict:
    account = await account_for(identity)
    binding = await verified_binding(account["account_id"], telegram=True)
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
    binding = await verified_binding(account["account_id"], telegram=True)
    await provision_telegram(binding, body.bot_token)
    try:
        connection = await ez_call(binding, "POST", "/v1/telegram/link")
    except HTTPException as error:
        if error.status_code in {400, 403}:
            raise HTTPException(503, "Telegram started but is not ready to issue a connection link yet.") from error
        raise
    return public_telegram_connection(connection, needs_link=True)


@app.get("/chat/models")
async def chat_models(identity: Identity = Depends(require_identity),
                      scope: ChatScope = OWNER_CHAT_SCOPE,
                      act_as_link_id: Annotated[str | None, Query(max_length=200)] = None) -> dict:
    """Shared owner control, or one private scope's control for mini-chat.

    The owner scope uses the shared Ez control; any other admitted chat scope
    uses its own scope-control, so mini-chat can run a faster model while the
    main chat keeps a planning model. Neither operation changes the other.
    """
    account = await chat_account(identity, identity.subject, act_as_link_id)
    binding = await verified_binding(account["account_id"])
    run_scope = chat_run_scope(scope, act_as_link_id)
    if run_scope != OWNER_CHAT_SCOPE:
        control = public_model_control(await ez_call(
            binding, "GET", f"/v1/scope-control?scope={quote(run_scope, safe='')}"))
        return await lock_control(binding, identity, control)
    return await lock_control(binding, identity)


@app.post("/chat/models")
async def select_chat_model(body: ModelSelectionInput, identity: Identity = Depends(require_identity)) -> dict:
    account = await chat_account(identity, identity.subject, body.act_as_link_id)
    binding = await verified_binding(account["account_id"])
    require_allowed(identity.subject, body.cli, body.model, body.effort)
    selection: dict[str, Any] = {"action": "model", "expectedSession": body.expected_session, "cli": body.cli}
    if body.provider is not None:
        selection["provider"] = body.provider
    if body.model is not None:
        selection["model"] = body.model
    if body.effort is not None:
        selection["effort"] = body.effort
    run_scope = chat_run_scope(body.scope, body.act_as_link_id)
    if run_scope != OWNER_CHAT_SCOPE:
        control = public_model_control(await ez_call(
            binding, "POST", f"/v1/scope-control?scope={quote(run_scope, safe='')}", selection))
        return await lock_control(binding, identity, control)
    control = public_model_control(await ez_call(binding, "POST", "/v1/control", selection))
    return await lock_control(binding, identity, control)


@app.post("/chat/clear")
async def clear_chat(body: NewChatInput, identity: Identity = Depends(require_identity)) -> dict:
    account = await owned_account(identity, body.user_id)
    binding = await verified_binding(account["account_id"])
    control = public_model_control(await ez_call(binding, "POST", "/v1/control", {
        "action": "new", "expectedSession": body.expected_session,
    }))
    return await lock_control(binding, identity, control)


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
    """Thin transport over the Ez inbox. No backend conversation store.

    The engine owns history; the backend only projects Ez run snapshots.
    User text lives in the native session, so only Ez-returned ai messages
    are projected here. Historic workouts remain canonical backend reads.
    """
    account = await owned_account(identity, user_id)
    try:
        binding = await verified_binding(account["account_id"])
        snapshots = await inbox_snapshots(binding)
    except HTTPException:
        return []
    bounded = snapshots[-min(max(limit, 1), 100):]
    history: list[dict] = []
    for snapshot in bounded:
        run_id = snapshot.get("originRunId", snapshot["id"])
        if not isinstance(run_id, str) or not run_id:
            continue
        try:
            current = await ez_call(binding, "GET", f"/v1/runs/{run_id}")
        except HTTPException:
            continue
        preset = validated_preset(current.get("preset"))
        for item in validated_messages(current.get("messages")):
            history.append({"id": item["id"], "role": "ai", "content": item["text"],
                            "timestamp": current.get("updated_at", ""),
                            **({"agent_cli": preset["cli"], "agent_model": preset.get("model"),
                                "agent_reasoning_effort": preset.get("effort"),
                                "agent_label": preset["name"]} if preset else {})})
    return history


@app.post("/chat/async", status_code=202)
async def enqueue_chat(body: ChatInput, identity: Identity = Depends(require_identity)) -> dict:
    """Thin admission: untouched user text + slim scope references only.

    No domain resolution, no history lookup, no text mutation, no turn store.
    Idempotency is owned by Ez via requestId (409 on conflicting reuse).
    The owner scope follows the shared native conversation; any other
    admitted chat scope (mini-chat) runs in its own native session with its
    own model selection, so the two surfaces never change each other's AI.
    """
    account = await chat_account(identity, body.user_id, body.act_as_link_id)
    binding = await verified_binding(account["account_id"])
    request_id = str(body.request_id)
    references = {key: value for key, value in {"scopeId": body.scope_id, "referenceDate": body.reference_date,
                                                 "exerciseId": body.exercise_id, "workoutId": body.workout_id,
                                                 "exerciseInstanceId": body.exercise_instance_id,
                                                 "expectedRevision": body.expected_revision}.items() if value is not None}
    # A coach's general conversation belongs to the trainee agent, but must
    # never resume the trainee's own chat or another coach's conversation.
    run_scope = chat_run_scope(body.scope, body.act_as_link_id)
    admission: dict[str, Any] = {"requestId": request_id, "scope": run_scope, "text": body.message}
    if body.scope == OWNER_CHAT_SCOPE and not body.act_as_link_id:
        admission["followOwner"] = True
    context = dict(references)
    plugin_context = agent_run_context(account, request_id)
    if plugin_context:
        context.update(plugin_context)
    if context:
        admission["context"] = context
    run = await ez_call(binding, "POST", "/v1/runs", admission)
    if not isinstance(run.get("id"), str):
        raise HTTPException(502, "Ez returned an invalid run receipt.")
    current = await ez_call(binding, "GET", f"/v1/runs/{run['id']}")
    return public_turn_from_snapshot(run["id"], request_id, current)


@app.get("/chat/jobs/{job_id}")
async def chat_job(job_id: str, user_id: str, identity: Identity = Depends(require_identity),
                   act_as_link_id: str | None = Query(default=None, max_length=200)) -> dict:
    account = await chat_account(identity, user_id, act_as_link_id)
    binding = await verified_binding(account["account_id"])
    if not job_id or len(job_id) > 200:
        raise HTTPException(404, "Chat job not found.")
    try:
        current = await ez_call(binding, "GET", f"/v1/runs/{job_id}")
    except HTTPException as error:
        if error.status_code == 404:
            raise HTTPException(404, "Chat job not found.") from error
        raise
    request_id = current.get("requestId") if isinstance(current.get("requestId"), str) else job_id
    return public_turn_from_snapshot(job_id, request_id, current)


@app.post("/chat/jobs/{job_id}/cancel")
async def cancel_chat(job_id: str, user_id: str, identity: Identity = Depends(require_identity),
                      act_as_link_id: str | None = Query(default=None, max_length=200)) -> dict:
    account = await chat_account(identity, user_id, act_as_link_id)
    binding = await verified_binding(account["account_id"])
    if not job_id or len(job_id) > 200:
        raise HTTPException(404, "Chat job not found.")
    try:
        await ez_call(binding, "POST", f"/v1/runs/{job_id}/cancel", {})
    except HTTPException as error:
        if error.status_code == 404:
            raise HTTPException(404, "Chat job not found.") from error
        raise
    current = await ez_call(binding, "GET", f"/v1/runs/{job_id}")
    request_id = current.get("requestId") if isinstance(current.get("requestId"), str) else job_id
    return public_turn_from_snapshot(job_id, request_id, current)


# End-state workout API. These routes intentionally accept only the v1 structured
# records defined in workouts.py; there are no legacy session or flat-array aliases.


async def browser_account(identity: Identity) -> dict[str, Any]:
    return await account_for(identity)


def canonical_account(permission: str):
    """Resolve the canonical account for the browser /v1 surface.

    Without ``act_as_link_id`` this is the signed-in account. With it, the
    server re-reads the stored coach link on every request, requires the caller
    to be its coach, and derives the trainee account; a browser-supplied owner
    or account id is never trusted.
    """
    async def dependency(
        act_as_link_id: str | None = Query(default=None, max_length=200),
        identity: Identity = Depends(require_identity),
    ) -> dict[str, Any]:
        account = await browser_account(identity)
        if act_as_link_id is None:
            return account
        return await coach_links().resolve_act_as(account["account_id"], act_as_link_id, permission)
    return dependency


require_view_account = canonical_account("view_progress")
require_edit_account = canonical_account("edit_programs")


@app.post("/v1/coach-links")
async def create_coach_link_v1(body: CoachLinkInviteInput, identity: Identity = Depends(require_identity)) -> dict:
    account = await browser_account(identity)
    return await coach_links().create_invite(account, body)


@app.post("/v1/coach-links/accept")
async def accept_coach_link_v1(body: CoachLinkAcceptInput, identity: Identity = Depends(require_identity)) -> dict:
    account = await browser_account(identity)
    return await coach_links().accept(account, body)


@app.get("/v1/coach-links")
async def list_coach_links_v1(role: CoachLinkRole = Query(default="all"),
                              identity: Identity = Depends(require_identity)) -> list[dict]:
    account = await browser_account(identity)
    return await coach_links().list_for(account, role)


@app.patch("/v1/coach-links/{link_id}")
async def update_coach_link_v1(link_id: str, body: CoachLinkUpdateInput,
                               identity: Identity = Depends(require_identity)) -> dict:
    account = await browser_account(identity)
    return await coach_links().update(account, link_id, body)


@app.post("/v1/exercises")
async def create_exercise_v1(body: ExerciseMutationInput, account: dict = Depends(require_edit_account)) -> dict:
    return await workouts().create_exercise(account["account_id"], body.definition, body.request_id,
                                            {"kind": "browser", "account_id": account["account_id"]}, body.expected_revision)


@app.get("/v1/workouts/{workout_id}/progression")
async def workout_progression_v1(workout_id: str, account: dict = Depends(require_view_account)) -> dict:
    return await workouts().progression(account["account_id"], workout_id)


@app.get("/v1/agent/workouts/{workout_id}/progression")
async def agent_workout_progression_v1(
    workout_id: str, capability: AgentCapability = Depends(require_agent_capability),
) -> dict:
    require_agent_permission(capability, AGENT_READ)
    return await workouts().progression(capability.account_id, workout_id)


@app.get("/v1/exercises/{exercise_id}/history")
async def exercise_history_v1(exercise_id: str, before: str | None = None, limit: int = 10,
                              account: dict = Depends(require_view_account)) -> list[dict]:
    return await workouts().history(account["account_id"], exercise_id, before, limit)


@app.get("/v1/exercises/{exercise_id}/related-history")
async def exercise_related_history_v1(exercise_id: str, limit: int = 20,
                                      account: dict = Depends(require_view_account)) -> dict:
    return await workouts().related_history(account["account_id"], exercise_id, limit)


@app.get("/v1/exercises/{exercise_id}")
async def get_exercise_v1(exercise_id: str, revision: str | None = None,
                          account: dict = Depends(require_view_account)) -> dict:
    return await workouts().exercise(account["account_id"], exercise_id, revision)


@app.get("/v1/videos")
async def search_videos_v1(q: str = Query(min_length=1, max_length=200),
                           limit: int = Query(default=20, ge=1, le=40),
                           identity: Identity = Depends(require_identity)) -> dict:
    await browser_account(identity)
    return await videos.search_videos(q, limit)


@app.post("/v1/plans/draft")
async def draft_plan_v1(body: PlanDraftInput, identity: Identity = Depends(require_identity)) -> dict:
    account = await browser_account(identity)
    return await workouts().draft_plan(account["account_id"], PlanInput(title=body.title, content_md=body.content_md),
                                       body.expected_revision, body.request_id, {"kind": "browser", "account_id": account["account_id"]}, body.plan_id)


@app.post("/v1/blueprints/draft")
async def draft_blueprint_v1(body: BlueprintDraftInput, identity: Identity = Depends(require_identity)) -> dict:
    account = await browser_account(identity)
    blueprint = BlueprintInput(**body.model_dump(exclude={"expected_revision", "request_id", "blueprint_id"}))
    return await workouts().draft_blueprint(account["account_id"], blueprint, body.expected_revision, body.request_id,
                                            {"kind": "browser", "account_id": account["account_id"]}, body.blueprint_id)


@app.post("/v1/programs/publish")
async def publish_program_v1(body: PublishInput, identity: Identity = Depends(require_identity)) -> dict:
    account = await browser_account(identity)
    return await workouts().publish(account["account_id"], body, {"kind": "browser", "account_id": account["account_id"]})


@app.get("/v1/programs/active")
async def active_program_v1(date: str | None = None, identity: Identity = Depends(require_identity)) -> dict:
    account = await browser_account(identity)
    return await workouts().active_release(account["account_id"], date)


@app.get("/v1/blueprints/active")
async def active_blueprint_v1(date: str | None = None, account: dict = Depends(require_view_account)) -> dict:
    return await workouts().active_blueprint(account["account_id"], date)


@app.post("/v1/workouts/generate")
async def generate_workout_v1(body: GenerateInput, account: dict = Depends(require_edit_account)) -> dict:
    return await workouts().generate(account["account_id"], body)


@app.post("/v1/workouts/copy-last-week")
async def copy_last_week_v1(body: CopyLastWeekInput, account: dict = Depends(require_edit_account)) -> dict:
    return await workouts().copy_last_week(account["account_id"], body)


@app.post("/v1/workouts/{workout_id}/clear")
async def clear_workout_v1(workout_id: str, body: ClearWorkoutInput, account: dict = Depends(require_edit_account)) -> dict:
    return await workouts().clear_workout(account["account_id"], workout_id, body)


@app.get("/v1/workouts")
async def list_workouts_v1(start: str, end: str, account: dict = Depends(require_view_account)) -> list[dict]:
    return await workouts().workouts(account["account_id"], start, end)


@app.get("/v1/workouts/{workout_id}")
async def get_workout_v1(workout_id: str, account: dict = Depends(require_view_account)) -> dict:
    return await workouts().workout(account["account_id"], workout_id)


@app.patch("/v1/workouts/{workout_id}/sets/{set_id}")
async def log_workout_set_v1(workout_id: str, set_id: str, body: SetLogInput,
                             account: dict = Depends(require_edit_account)) -> dict:
    return await workouts().log_set(account["account_id"], workout_id, set_id, body)


@app.post("/v1/workouts/{workout_id}/sets/{set_id}/unlog")
async def unlog_workout_set_v1(workout_id: str, set_id: str, body: SetUnlogInput,
                               account: dict = Depends(require_edit_account)) -> dict:
    return await workouts().unlog_set(account["account_id"], workout_id, set_id, body)


@app.post("/v1/workouts/{workout_id}/exercises/{exercise_instance_id}/sets")
async def add_workout_set_v1(workout_id: str, exercise_instance_id: str, body: SetAddInput,
                             account: dict = Depends(require_edit_account)) -> dict:
    return await workouts().add_set(account["account_id"], workout_id, exercise_instance_id, body)


@app.post("/v1/workouts/{workout_id}/sets/{set_id}/remove")
async def remove_workout_set_v1(workout_id: str, set_id: str, body: SetRemoveInput,
                                account: dict = Depends(require_edit_account)) -> dict:
    return await workouts().remove_set(account["account_id"], workout_id, set_id, body)


@app.patch("/v1/workouts/{workout_id}/sets/{set_id}/target")
async def update_workout_set_target_v1(workout_id: str, set_id: str, body: SetTargetInput,
                                       account: dict = Depends(require_edit_account)) -> dict:
    return await workouts().update_set_target(account["account_id"], workout_id, set_id, body)


@app.post("/v1/workouts/{workout_id}/exercises/{exercise_instance_id}/remove")
async def remove_workout_exercise_v1(workout_id: str, exercise_instance_id: str, body: PlanEntryRemoveInput,
                                     account: dict = Depends(require_edit_account)) -> dict:
    return await workouts().remove_exercise(account["account_id"], workout_id, exercise_instance_id, body)


@app.post("/v1/workouts/{workout_id}/segments/{segment_id}/remove")
async def remove_workout_segment_v1(workout_id: str, segment_id: str, body: PlanEntryRemoveInput,
                                    account: dict = Depends(require_edit_account)) -> dict:
    return await workouts().remove_segment(account["account_id"], workout_id, segment_id, body)


@app.get("/v1/workouts/{workout_id}/exercise-repertoire")
async def workout_exercise_repertoire_v1(workout_id: str, account: dict = Depends(require_view_account)) -> dict:
    return await workouts().exercise_repertoire(account["account_id"], workout_id)


@app.post("/v1/workouts/{workout_id}/exercises")
async def add_workout_exercise_v1(workout_id: str, body: ExerciseAddInput,
                                  account: dict = Depends(require_edit_account)) -> dict:
    return await workouts().add_exercise(account["account_id"], workout_id, body)


@app.post("/v1/workouts/{workout_id}/segments/reorder")
async def reorder_workout_segments_v1(workout_id: str, body: PlanReorderInput,
                                      account: dict = Depends(require_edit_account)) -> dict:
    return await workouts().reorder_segments(account["account_id"], workout_id, body)


@app.post("/v1/workouts/{workout_id}/exercises/{exercise_instance_id}/move")
async def move_workout_item_v1(workout_id: str, exercise_instance_id: str, body: PlanItemMoveInput,
                               account: dict = Depends(require_edit_account)) -> dict:
    return await workouts().move_item(account["account_id"], workout_id, exercise_instance_id, body)


@app.post("/v1/workouts/{workout_id}/exercises/{exercise_instance_id}/extract")
async def extract_workout_item_v1(workout_id: str, exercise_instance_id: str, body: PlanItemExtractInput,
                                  account: dict = Depends(require_edit_account)) -> dict:
    return await workouts().extract_item(account["account_id"], workout_id, exercise_instance_id, body)


@app.patch("/v1/workouts/{workout_id}/notes")
async def update_workout_notes_v1(workout_id: str, body: WorkoutNotesInput,
                                  account: dict = Depends(require_edit_account)) -> dict:
    return await workouts().update_notes(account["account_id"], workout_id, body)


@app.patch("/v1/workouts/{workout_id}/exercises/{exercise_instance_id}/notes")
async def update_workout_exercise_notes_v1(workout_id: str, exercise_instance_id: str, body: ExerciseNoteInput,
                                           account: dict = Depends(require_edit_account)) -> dict:
    return await workouts().update_exercise_notes(account["account_id"], workout_id, exercise_instance_id, body)


@app.get("/v1/workouts/{workout_id}/exercises/{exercise_instance_id}/swap-candidates")
async def swap_candidates_v1(workout_id: str, exercise_instance_id: str,
                             account: dict = Depends(require_view_account)) -> dict:
    return await workouts().swap_candidates(account["account_id"], workout_id, exercise_instance_id)


@app.post("/v1/workouts/{workout_id}/exercises/{exercise_instance_id}/swap")
async def swap_workout_exercise_v1(workout_id: str, exercise_instance_id: str, body: SwapInput,
                                   account: dict = Depends(require_edit_account)) -> dict:
    return await workouts().swap(account["account_id"], workout_id, exercise_instance_id, body)


@app.post("/v1/agent/messages", status_code=202)
async def agent_message_v1(body: AgentMessageInput, identity: Identity = Depends(require_identity)) -> dict:
    account = await browser_account(identity)
    workout = await workouts().workout(account["account_id"], body.scope.workout_id)
    if body.scope.kind == "workout_exercise":
        if not body.scope.exercise_instance_id or not any(
            item["exercise_instance_id"] == body.scope.exercise_instance_id
            for segment in workout["segments"] for item in segment["items"]
        ):
            raise HTTPException(404, "Workout exercise was not found.")
    return await enqueue_chat(ChatInput(
        user_id=identity.subject, request_id=body.request_id, message=body.message, scope_id=body.conversation_id,
        reference_date=workout["date"], workout_id=workout["workout_id"], exercise_id=body.scope.exercise_instance_id,
        exercise_instance_id=body.scope.exercise_instance_id, expected_revision=workout["revision"],
    ), identity)


@app.get("/v1/agent/jobs/{job_id}")
async def agent_job_v1(job_id: UUID, identity: Identity = Depends(require_identity)) -> dict:
    return await chat_job(str(job_id), identity.subject, identity)


# The agent surface is the same canonical reads and deterministic domain writes
# the frontend uses. Scope is derived entirely from the signed capability
# admitted into the current Ez run's opaque context: reads require aifit:read,
# mutations require aifit:write.


@app.post("/v1/agent/exercises")
async def agent_create_exercise_v1(
    body: ExerciseMutationInput,
    capability: AgentCapability = Depends(require_agent_capability),
) -> dict:
    require_agent_permission(capability, AGENT_WRITE)
    require_agent_request(capability, body.request_id)
    return await workouts().create_exercise(
        capability.account_id, body.definition, body.request_id, agent_actor(capability), body.expected_revision,
    )


@app.get("/v1/agent/exercises")
async def agent_list_exercises_v1(
    after: str | None = Query(default=None, pattern=r"^ex_[a-z0-9_]{3,120}$"),
    limit: int = Query(default=50, ge=1, le=100),
    capability: AgentCapability = Depends(require_agent_capability),
) -> dict:
    require_agent_permission(capability, AGENT_READ)
    return await workouts().list_exercises(capability.account_id, after, limit)


@app.get("/v1/agent/exercises/{exercise_id}")
async def agent_exercise_v1(
    exercise_id: str,
    revision: str | None = None,
    capability: AgentCapability = Depends(require_agent_capability),
) -> dict:
    require_agent_permission(capability, AGENT_READ)
    return await workouts().exercise(capability.account_id, exercise_id, revision)


@app.get("/v1/agent/exercises/{exercise_id}/history")
async def agent_exercise_history_v1(
    exercise_id: str,
    before: str | None = None,
    limit: int = 10,
    capability: AgentCapability = Depends(require_agent_capability),
) -> list[dict]:
    require_agent_permission(capability, AGENT_READ)
    return await workouts().history(capability.account_id, exercise_id, before, limit)


@app.get("/v1/agent/exercises/{exercise_id}/related-history")
async def agent_exercise_related_history_v1(
    exercise_id: str,
    limit: int = 20,
    capability: AgentCapability = Depends(require_agent_capability),
) -> dict:
    require_agent_permission(capability, AGENT_READ)
    return await workouts().related_history(capability.account_id, exercise_id, limit)


@app.post("/v1/agent/blueprints/draft")
async def agent_draft_blueprint_v1(
    body: BlueprintDraftInput,
    capability: AgentCapability = Depends(require_agent_capability),
) -> dict:
    require_agent_permission(capability, AGENT_WRITE)
    require_agent_request(capability, body.request_id)
    blueprint = BlueprintInput(**body.model_dump(exclude={"expected_revision", "request_id", "blueprint_id"}))
    return await workouts().draft_blueprint(
        capability.account_id, blueprint, body.expected_revision, body.request_id, agent_actor(capability), body.blueprint_id,
    )


@app.get("/v1/agent/blueprints/active")
async def agent_active_blueprint_v1(
    date: str | None = None,
    capability: AgentCapability = Depends(require_agent_capability),
) -> dict:
    require_agent_permission(capability, AGENT_READ)
    return await workouts().active_blueprint(capability.account_id, date)


@app.post("/v1/agent/blueprints/solidify")
async def agent_solidify_blueprint_v1(
    body: BlueprintSolidifyInput,
    capability: AgentCapability = Depends(require_agent_capability),
) -> dict:
    require_agent_permission(capability, AGENT_WRITE)
    require_agent_request(capability, body.request_id)
    blueprint = BlueprintInput(**body.model_dump(exclude={"expected_revision", "request_id", "blueprint_id"}))
    return await workouts().solidify_blueprint(
        capability.account_id,
        blueprint,
        body.expected_revision,
        body.request_id,
        agent_actor(capability),
        body.blueprint_id,
    )


@app.post("/v1/agent/workouts/override")
async def agent_override_workout_v1(
    body: WorkoutOverrideInput,
    capability: AgentCapability = Depends(require_agent_capability),
) -> dict:
    require_agent_permission(capability, AGENT_WRITE)
    require_agent_request(capability, body.request_id)
    return await workouts().override(capability.account_id, body, agent_actor(capability))


@app.post("/v1/agent/workouts/swap")
async def agent_swap_v1(
    body: AgentWorkoutSwapInput,
    capability: AgentCapability = Depends(require_agent_capability),
) -> dict:
    require_agent_permission(capability, AGENT_WRITE)
    require_agent_request(capability, body.request_id)
    return await workouts().swap(
        capability.account_id,
        body.workout_id,
        body.exercise_instance_id,
        SwapInput(
            source=body.source,
            reason=body.reason,
            target_candidate_id=body.target_candidate_id,
            expected_revision=body.expected_revision,
            expected_blueprint_revision=body.expected_blueprint_revision,
            request_id=body.request_id,
        ),
    )


@app.post("/v1/agent/workouts/generate")
async def agent_generate_workout_v1(
    body: GenerateInput,
    capability: AgentCapability = Depends(require_agent_capability),
) -> dict:
    require_agent_permission(capability, AGENT_WRITE)
    require_agent_request(capability, body.request_id)
    return await workouts().generate(capability.account_id, body)


@app.get("/v1/agent/workouts")
async def agent_list_workouts_v1(
    start: str,
    end: str,
    capability: AgentCapability = Depends(require_agent_capability),
) -> list[dict]:
    require_agent_permission(capability, AGENT_READ)
    return await workouts().workouts(capability.account_id, start, end)


@app.get("/v1/agent/workouts/{workout_id}")
async def agent_get_workout_v1(
    workout_id: str,
    capability: AgentCapability = Depends(require_agent_capability),
) -> dict:
    require_agent_permission(capability, AGENT_READ)
    return await workouts().workout(capability.account_id, workout_id)


@app.patch("/v1/agent/workouts/{workout_id}/sets/{set_id}")
async def agent_log_set_v1(
    workout_id: str,
    set_id: str,
    body: SetLogInput,
    capability: AgentCapability = Depends(require_agent_capability),
) -> dict:
    require_agent_permission(capability, AGENT_WRITE)
    require_agent_request(capability, body.request_id)
    return await workouts().log_set(capability.account_id, workout_id, set_id, body)
