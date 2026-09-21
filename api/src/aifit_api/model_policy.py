import json
import os
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Any

from fastapi import HTTPException


@dataclass(frozen=True)
class ModelChoice:
    cli: str
    model: str
    effort: str


@dataclass(frozen=True)
class ModelPolicy:
    privileged_subjects: frozenset[str]
    default: tuple[ModelChoice, ...]
    privileged: tuple[ModelChoice, ...]

    def choices_for(self, subject: str) -> frozenset[ModelChoice]:
        return frozenset(self.privileged if subject in self.privileged_subjects else self.default)


def _choice(value: Any) -> ModelChoice:
    if not isinstance(value, dict) or set(value) != {"cli", "model", "effort"}:
        raise ValueError("Each model policy choice must contain only cli, model and effort.")
    fields = [value.get(field) for field in ("cli", "model", "effort")]
    if any(not isinstance(field, str) or not field.strip() for field in fields):
        raise ValueError("Model policy choices require non-empty cli, model and effort strings.")
    if any(len(field) > limit for field, limit in zip(fields, (80, 160, 40), strict=True)):
        raise ValueError("A model policy choice is too long.")
    return ModelChoice(*(field.strip() for field in fields))


def load_model_policy(path: str) -> ModelPolicy:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    if not isinstance(value, dict) or set(value) != {"privileged_subjects", "default", "privileged"}:
        raise ValueError("Model policy must contain privileged_subjects, default and privileged.")
    subjects = value["privileged_subjects"]
    if not isinstance(subjects, list) or not subjects or any(
        not isinstance(subject, str) or not subject.startswith("did:privy:") for subject in subjects
    ):
        raise ValueError("privileged_subjects must be a non-empty list of Privy subject IDs.")
    if len(set(subjects)) != len(subjects):
        raise ValueError("privileged_subjects contains duplicates.")
    groups: dict[str, tuple[ModelChoice, ...]] = {}
    for name in ("default", "privileged"):
        raw = value[name]
        if not isinstance(raw, list) or not raw:
            raise ValueError(f"{name} must contain at least one model choice.")
        choices = tuple(_choice(item) for item in raw)
        if len(set(choices)) != len(raw):
            raise ValueError(f"{name} contains duplicate model choices.")
        groups[name] = choices
    if not set(groups["default"]).issubset(groups["privileged"]):
        raise ValueError("privileged choices must include every default choice.")
    return ModelPolicy(frozenset(subjects), groups["default"], groups["privileged"])


@lru_cache(maxsize=1)
def configured_model_policy() -> ModelPolicy | None:
    path = os.getenv("AIFIT_MODEL_POLICY_FILE", "").strip()
    if not path:
        return None
    try:
        return load_model_policy(path)
    except (OSError, ValueError, json.JSONDecodeError) as error:
        raise HTTPException(503, "AIFit model policy is unavailable.") from error


def allowed_choices(subject: str) -> frozenset[ModelChoice] | None:
    policy = configured_model_policy()
    return policy.choices_for(subject) if policy else None


def require_allowed(subject: str, cli: str, model: str | None, effort: str | None) -> None:
    allowed = allowed_choices(subject)
    if allowed is not None and ModelChoice(cli, model or "", effort or "") not in allowed:
        raise HTTPException(403, "This model is not enabled for this AIFit account.")


def filter_control(value: dict, subject: str) -> dict:
    allowed = allowed_choices(subject)
    if allowed is None:
        return value
    permitted_efforts: dict[tuple[str, str], set[str]] = {}
    for choice in allowed:
        permitted_efforts.setdefault((choice.cli, choice.model), set()).add(choice.effort)
    models = []
    for item in value["models"]:
        efforts = permitted_efforts.get((item["cli"], item.get("model", "")))
        if efforts:
            enabled_efforts = [effort for effort in item["efforts"] if effort in efforts]
            if enabled_efforts:
                models.append({**item, "efforts": enabled_efforts})
    presets = [item for item in value["presets"] if ModelChoice(
        item["cli"], item.get("model", ""), item.get("effort", "")
    ) in allowed]
    selected_id = value["selected_id"] if any(
        item["id"] == value["selected_id"] for item in presets
    ) else ""
    return {**value, "models": models, "presets": presets, "selected_id": selected_id}
