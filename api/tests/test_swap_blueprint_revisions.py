from copy import deepcopy

import pytest

from aifit_api.workouts import BlueprintInput, GenerateInput, SwapInput, WorkoutDomainError, WorkoutService
from test_workout_contract import blueprint
from test_workout_partial_progress import log_set_at
from test_workout_transactions import FakeCollection, FakeDatabase, ReplaceResult


async def fixture():
    plan = blueprint()
    unrelated = deepcopy(plan['days'][0]['segments'][0])
    unrelated.update(segment_id='seg_unrelated', order=2)
    slot = unrelated['slots'][0]
    slot.update(slot_id='slot_unrelated', role='squat', candidates=slot['candidates'][:1])
    slot['candidates'][0].update(candidate_id='cand_unrelated', exercise_id='ex_leg_press')
    plan['days'][0]['segments'].append(unrelated)
    db = FakeDatabase()
    db.seed_blueprint_catalog(plan)
    service = WorkoutService(db)
    published = await service.solidify_blueprint('acc_one', BlueprintInput(**plan), None, 'publish', {})
    workout = (await service.generate('acc_one', GenerateInput(date='2026-09-21', request_id='generate')))['workout']
    return db, service, plan, published, workout


async def republish(service, plan, published, request_id='republish'):
    return await service.solidify_blueprint(
        'acc_one', BlueprintInput(**plan), published['revision'], request_id, {}, published['resource_id'],
    )


def swap_input(workout, choices, request_id='swap'):
    return SwapInput(
        expected_revision=workout['revision'], expected_blueprint_revision=choices['blueprint_revision'],
        target_candidate_id=choices['candidates'][0]['candidate_id'], reason='Requested alternative.', request_id=request_id,
    )


@pytest.mark.asyncio
@pytest.mark.parametrize('logged', [False, True])
async def test_new_publication_swaps_only_remaining_work_and_records_item_lineage(logged):
    db, service, plan, published, workout = await fixture()
    if logged:
        workout, _ = await log_set_at(service, workout, 0, 'log-first')
    original = deepcopy(workout)
    target = workout['segments'][0]['items'][0]
    plan['days'][0]['intent_md'] = 'Updated coaching intent; the slot is unchanged.'
    current = await republish(service, plan, published)
    blueprints_before = deepcopy(db.documents['blueprints'])
    choices = await service.swap_candidates('acc_one', workout['workout_id'], target['exercise_instance_id'])
    assert choices['blueprint_revision'] == current['revision'] != published['revision']
    assert len(choices['candidates']) == 1
    assert choices['candidates'][0]['sets'] == (2 if logged else 3)
    body = swap_input(workout, choices)
    receipt = await service.swap('acc_one', workout['workout_id'], target['exercise_instance_id'], body)
    saved = receipt['workout']
    items = saved['segments'][0]['items']
    replacement = items[-1]
    assert saved['segments'][1:] == original['segments'][1:]
    assert saved['lineage']['blueprint_revision'] == published['revision']
    assert replacement['source_blueprint'] == {
        'blueprint_id': current['resource_id'], 'blueprint_revision': current['revision'], 'day_id': 'day_upper_a',
    }
    assert len(replacement['sets']) == (2 if logged else 3)
    assert all(row['actual'] is None for row in replacement['sets'])
    if logged:
        assert items[0]['sets'] == [original['segments'][0]['items'][0]['sets'][0]]
        assert items[0]['exercise_snapshot'] == target['exercise_snapshot']
        assert 'source_blueprint' not in items[0]
    assert db.documents['blueprints'] == blueprints_before
    assert await service.swap('acc_one', workout['workout_id'], target['exercise_instance_id'], body) == receipt


@pytest.mark.asyncio
async def test_repeat_swaps_follow_the_replacements_revision_across_publications():
    _, service, plan, published, workout = await fixture()
    current = await republish(service, plan, published)
    for index in range(3):
        item = workout['segments'][0]['items'][0]
        choices = await service.swap_candidates('acc_one', workout['workout_id'], item['exercise_instance_id'])
        workout = (await service.swap('acc_one', workout['workout_id'], item['exercise_instance_id'],
                                      swap_input(workout, choices, f'swap-{index}')))['workout']
        assert workout['segments'][0]['items'][0]['source_blueprint']['blueprint_revision'] == current['revision']
        assert len(workout['segments'][0]['items'][0]['sets']) == 3
        current = await republish(service, plan, current, f'publish-{index}')


@pytest.mark.asyncio
@pytest.mark.parametrize(('change', 'code'), [('slot', 'blueprint_slot_missing'), ('day', 'blueprint_day_missing'),
                                            ('blueprint', 'blueprint_slot_missing'), ('pattern', 'no_eligible_swap')])
async def test_removed_or_incompatible_slot_never_rebuilds_or_relinks_the_day(change, code):
    db, service, plan, published, workout = await fixture()
    slot = plan['days'][0]['segments'][0]['slots'][0]
    if change == 'slot':
        # The same exercise in a renamed slot must not silently relink an old slot.
        slot['slot_id'] = 'slot_replacement'
    elif change == 'day':
        plan['days'][0]['day_id'] = 'day_replacement'
    elif change == 'pattern':
        slot['role'] = 'elbow_extension'
        for index, candidate in enumerate(slot['candidates']):
            candidate['exercise_id'] = f'ex_triceps_{index}'
        db.seed_blueprint_catalog(plan)
    if change == 'blueprint':
        await service.solidify_blueprint('acc_one', BlueprintInput(**plan), None, 'different-blueprint', {})
    else:
        await republish(service, plan, published)
    item = workout['segments'][0]['items'][0]
    for operation in ('read', 'write'):
        with pytest.raises(WorkoutDomainError) as error:
            if operation == 'read':
                await service.swap_candidates('acc_one', workout['workout_id'], item['exercise_instance_id'])
            else:
                await service.swap('acc_one', workout['workout_id'], item['exercise_instance_id'], SwapInput(
                    expected_revision=workout['revision'], reason='Requested alternative.', request_id='blocked-swap',
                ))
        assert error.value.code == code
    assert await service.workout('acc_one', workout['workout_id']) == workout
    assert not any(row['request_id'] == 'blocked-swap' for row in db.documents['mutation_receipts'])


@pytest.mark.asyncio
async def test_current_slot_filters_incompatible_and_forbidden_alternatives():
    db, service, plan, published, workout = await fixture()
    slot = plan['days'][0]['segments'][0]['slots'][0]
    incompatible = deepcopy(slot['candidates'][1])
    incompatible.update(candidate_id='cand_press', exercise_id='ex_triceps_press')
    slot['candidates'].append(incompatible)
    db.seed_blueprint_catalog(plan)
    next(row for row in db.documents['exercises'] if row['exercise_id'] == 'ex_triceps_press')['movement_pattern'] = 'elbow_extension'
    current = await republish(service, plan, published)
    item = workout['segments'][0]['items'][0]
    choices = await service.swap_candidates('acc_one', workout['workout_id'], item['exercise_instance_id'])
    assert [row['candidate_id'] for row in choices['candidates']] == ['cand_row_cable']
    # Published legacy records may contain an inconsistent hard-constraint pool.
    stored = next(row for row in db.documents['blueprints'] if row['revision'] == current['revision'])
    stored['hard_constraints']['forbidden_exercise_ids'] = ['ex_chest_supported_row_cable']
    with pytest.raises(WorkoutDomainError) as error:
        await service.swap_candidates('acc_one', workout['workout_id'], item['exercise_instance_id'])
    assert error.value.code == 'no_eligible_swap'
    assert await service.workout('acc_one', workout['workout_id']) == workout


@pytest.mark.asyncio
@pytest.mark.parametrize(('race', 'code'), [('workout', 'stale_revision'), ('blueprint', 'stale_blueprint')])
async def test_changed_revision_after_picker_read_rejects_the_write(race, code):
    _, service, plan, published, workout = await fixture()
    item = workout['segments'][0]['items'][0]
    choices = await service.swap_candidates('acc_one', workout['workout_id'], item['exercise_instance_id'])
    body = swap_input(workout, choices)
    if race == 'workout':
        saved, _ = await log_set_at(service, workout, 0, 'concurrent-log')
    else:
        await republish(service, plan, published)
        saved = workout
    with pytest.raises(WorkoutDomainError) as error:
        await service.swap('acc_one', workout['workout_id'], item['exercise_instance_id'], body)
    assert error.value.code == code
    assert await service.workout('acc_one', workout['workout_id']) == saved


@pytest.mark.asyncio
async def test_compare_and_swap_failure_during_write_creates_no_receipt(monkeypatch):
    db, service, plan, published, workout = await fixture()
    await republish(service, plan, published)
    item = workout['segments'][0]['items'][0]
    choices = await service.swap_candidates('acc_one', workout['workout_id'], item['exercise_instance_id'])
    original_replace = FakeCollection.replace_one

    async def changed_revision(collection, query, document, **kwargs):
        if collection.name == 'workouts':
            assert query['revision'] == workout['revision']
            return ReplaceResult(0)
        return await original_replace(collection, query, document, **kwargs)

    monkeypatch.setattr(FakeCollection, 'replace_one', changed_revision)
    with pytest.raises(WorkoutDomainError) as error:
        await service.swap('acc_one', workout['workout_id'], item['exercise_instance_id'], swap_input(workout, choices))
    assert error.value.code == 'stale_revision'
    assert await service.workout('acc_one', workout['workout_id']) == workout
    assert not any(row['request_id'] == 'swap' for row in db.documents['mutation_receipts'])


@pytest.mark.asyncio
async def test_fully_logged_target_stays_locked_after_new_publication():
    _, service, plan, published, workout = await fixture()
    for index in range(3):
        workout, _ = await log_set_at(service, workout, index, f'log-{index}')
    await republish(service, plan, published)
    item = workout['segments'][0]['items'][0]
    with pytest.raises(WorkoutDomainError) as error:
        await service.swap_candidates('acc_one', workout['workout_id'], item['exercise_instance_id'])
    assert error.value.code == 'completed_exercise_locked'
    with pytest.raises(WorkoutDomainError) as error:
        await service.swap('acc_one', workout['workout_id'], item['exercise_instance_id'], SwapInput(
            expected_revision=workout['revision'], reason='Requested alternative.', request_id='locked-swap',
        ))
    assert error.value.code == 'completed_exercise_locked'
    assert await service.workout('acc_one', workout['workout_id']) == workout


@pytest.mark.asyncio
@pytest.mark.parametrize('dose', [1, 5])
async def test_revised_alternative_dose_never_adds_sets_or_rewrites_logs(dose):
    _, service, plan, published, workout = await fixture()
    workout, _ = await log_set_at(service, workout, 0, 'log-first')
    logged = deepcopy(workout['segments'][0]['items'][0]['sets'][0])
    plan['days'][0]['segments'][0]['slots'][0]['candidates'][1]['prescription']['set_count'] = dose
    await republish(service, plan, published)
    item = workout['segments'][0]['items'][0]
    choices = await service.swap_candidates('acc_one', workout['workout_id'], item['exercise_instance_id'])
    assert choices['candidates'][0]['sets'] == min(2, dose)
    saved = (await service.swap('acc_one', workout['workout_id'], item['exercise_instance_id'],
                                swap_input(workout, choices)))['workout']
    assert saved['segments'][0]['items'][0]['sets'] == [logged]
    assert len(saved['segments'][0]['items'][1]['sets']) == min(2, dose)


@pytest.mark.asyncio
async def test_cross_day_added_item_uses_its_own_source_day_after_publication():
    from test_workout_quick_add import repertoire_fixture

    db, service, workout, _, body = await repertoire_fixture()
    workout = (await service.add_exercise('acc_one', workout['workout_id'], body))['workout']
    plan = db.documents['blueprints'][0]
    await service.solidify_blueprint('acc_one', BlueprintInput(**{
        key: plan[key] for key in BlueprintInput.model_fields if key in plan
    }), plan['revision'], 'republish-added', {}, plan['blueprint_id'])
    current = (await service.active_blueprint('acc_one'))['blueprint']
    item = workout['segments'][-1]['items'][0]
    choices = await service.swap_candidates('acc_one', workout['workout_id'], item['exercise_instance_id'])
    saved = (await service.swap('acc_one', workout['workout_id'], item['exercise_instance_id'],
                                swap_input(workout, choices)))['workout']
    assert saved['segments'][:-1] == workout['segments'][:-1]
    assert saved['segments'][-1]['items'][0]['source_blueprint'] == {
        'blueprint_id': current['blueprint_id'], 'blueprint_revision': current['revision'], 'day_id': 'day_arms',
    }
