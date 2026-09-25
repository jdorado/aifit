"""Restore per-workout exercise names from verified legacy exports.

Dry-run by default. Applying writes an fsynced BSON-JSON backup before any update.
Only display names change; set values and exercise identities remain untouched.
"""

from __future__ import annotations

import argparse
import json
import os
import re
from collections import Counter, defaultdict
from copy import deepcopy
from datetime import UTC, datetime
from pathlib import Path
from uuid import uuid4

from bson import json_util
from dotenv import dotenv_values
from pymongo import MongoClient


def stamp(value: object) -> str:
    text = str(value or "")
    return "".join(re.findall(r"\d", text))[:20]


def slot(exercise: dict) -> str:
    key = str(exercise.get("id") or "")
    slug = re.sub(r"[^a-z0-9]+", "_", key.lower()).strip("_") or "exercise"
    return f"slot_legacy_{slug}"[:124]


def source_for(workout: dict, sources: dict[str, dict]) -> dict | None:
    source = sources.get(workout.get("date"))
    if not source or source.get("label") != workout.get("title"):
        return None
    if stamp(source.get("updated_at")) != stamp((workout.get("lineage") or {}).get("legacy_updated_at")):
        return None
    return source


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--env-file", type=Path, required=True)
    parser.add_argument("--mirror-root", type=Path, required=True)
    parser.add_argument("--backup-file", type=Path)
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    if args.apply and not args.backup_file:
        parser.error("--apply requires --backup-file")
    config = dotenv_values(args.env_file)
    if not config.get("MONGO_URL") or not config.get("MONGO_DB"):
        parser.error("env file needs MONGO_URL and MONGO_DB")
    client = MongoClient(config["MONGO_URL"], serverSelectionTimeoutMS=10000)
    db = client[config["MONGO_DB"]]
    mirrors = {}
    for person in ("juan", "ale", "dad"):
        folder = args.mirror_root / f"aifit-{person}" / "workouts"
        mirrors[person] = {p.stem: json.loads(p.read_text()) for p in folder.glob("*.json")}
    workouts = list(db.workouts.find({"lineage.source": "legacy_import"}))
    by_account = defaultdict(list)
    for workout in workouts:
        by_account[workout["account_id"]].append(workout)
    # Infer the mirror binding from many independently matching source timestamps.
    scores = {account: Counter({person: sum(source_for(w, source) is not None for w in days)
                                for person, source in mirrors.items()})
              for account, days in by_account.items()}
    bindings = {}
    for account, score in scores.items():
        ranked = score.most_common()
        if not ranked or ranked[0][1] < 5 or (len(ranked) > 1 and ranked[1][1] != 0):
            raise RuntimeError("mirror binding is not unique")
        bindings[account] = ranked[0][0]
    if set(bindings.values()) != set(mirrors):
        raise RuntimeError("not every mirror has a unique account binding")

    changes = []
    skipped = Counter()
    for account, days in by_account.items():
        person = bindings[account]
        for workout in days:
            source = source_for(workout, mirrors[person])
            if source is None:
                skipped["unverified_day"] += 1
                continue
            originals = defaultdict(list)
            for exercise in (source.get("workout") or {}).get("exercises") or []:
                originals[slot(exercise)].append(exercise)
            items = defaultdict(list)
            for segment in workout.get("segments") or []:
                for item in segment.get("items") or []:
                    items[item.get("slot_id")].append(item)
            edits = []
            for item_slot, matching_items in items.items():
                matching_source = originals.get(item_slot, [])
                if len(matching_source) != 1 or len(matching_items) != 1:
                    skipped["ambiguous_item"] += len(matching_items)
                    continue
                item = matching_items[0]
                name = matching_source[0].get("name")
                current = (item.get("exercise_snapshot") or {}).get("name")
                if not isinstance(name, str) or not name.strip() or not isinstance(current, str):
                    skipped["invalid_name"] += 1
                    continue
                if name != current:
                    edits.append((item, current, name))
            if not edits:
                continue
            set_ids = [row["set_id"] for item, _, _ in edits for row in item.get("sets") or []]
            rows = list(db.performance_index.find({"account_id": account, "workout_id": workout["workout_id"],
                                                   "set_id": {"$in": set_ids}}))
            if len({row["set_id"] for row in rows}) != len(rows):
                raise RuntimeError("duplicate performance row")
            row_map = {row["set_id"]: row for row in rows}
            for item, old, _ in edits:
                for set_row in item.get("sets") or []:
                    index = row_map.get(set_row["set_id"])
                    if index and (index.get("exercise_name") != old or
                                  index.get("exercise_id") != item["exercise_snapshot"]["exercise_id"]):
                        raise RuntimeError("performance index disagrees with workout")
            changes.append((person, workout, edits, rows))

    print(json.dumps({"verified_workouts_to_update": len(changes),
                      "exercise_names_to_update": sum(len(c[2]) for c in changes),
                      "performance_rows_to_update": sum(len(c[3]) for c in changes),
                      "by_mirror": dict(Counter(person for person, _, edits, _ in changes for _ in edits)),
                      "skipped": dict(skipped)}, sort_keys=True))
    if not args.apply or not changes:
        return

    backup_path = args.backup_file
    backup_path.parent.mkdir(parents=True, exist_ok=True)
    fd = os.open(backup_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(fd, "w") as backup:
        for person, workout, _, rows in changes:
            backup.write(json_util.dumps({"mirror": person, "workout": workout, "performance_rows": rows}) + "\n")
        backup.flush()
        os.fsync(backup.fileno())

    for person, workout, edits, rows in changes:
        expected = deepcopy(workout)
        new_revision = f"rev_{uuid4().hex}"
        expected["revision"] = new_revision
        expected["updated_at"] = datetime.now(UTC).isoformat().replace("+00:00", "Z")
        renamed = {row["set_id"]: (old, new) for item, old, new in edits
                   for row in item.get("sets") or []}
        for segment in expected["segments"]:
            for item in segment["items"]:
                if item["slot_id"] in {edit[0]["slot_id"] for edit in edits}:
                    item["exercise_snapshot"]["name"] = next(new for original, _, new in edits
                                                                 if original["slot_id"] == item["slot_id"])
        expected_rows = []
        for row in rows:
            fixed = deepcopy(row)
            fixed["exercise_name"] = renamed[row["set_id"]][1]
            expected_rows.append(fixed)
        with client.start_session() as session:
            with session.start_transaction():
                result = db.workouts.replace_one({"_id": workout["_id"], "revision": workout["revision"]},
                                                 expected, session=session)
                if result.modified_count != 1:
                    raise RuntimeError("workout changed during repair")
                for old_row, fixed in zip(rows, expected_rows):
                    result = db.performance_index.update_one(
                        {"_id": old_row["_id"], "exercise_name": old_row["exercise_name"]},
                        {"$set": {"exercise_name": fixed["exercise_name"]}}, session=session)
                    if result.modified_count != 1:
                        raise RuntimeError("performance row changed during repair")
        if db.workouts.find_one({"_id": workout["_id"]}) != expected:
            raise RuntimeError("workout readback failed")
        for fixed in expected_rows:
            if db.performance_index.find_one({"_id": fixed["_id"]}) != fixed:
                raise RuntimeError("performance row readback failed")
    print(json.dumps({"updated_workouts": len(changes), "updated_exercise_names": sum(len(c[2]) for c in changes),
                      "backup_file": str(backup_path)}, sort_keys=True))


if __name__ == "__main__":
    main()
