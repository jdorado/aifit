from copy import deepcopy

import httpx
import pytest

from aifit_api import main
from aifit_api.workouts import BlueprintInput, ExerciseAddInput, GenerateInput, SetActual, SetLogInput, SwapInput, WorkoutDomainError, WorkoutService
from test_workout_contract import blueprint
from test_workout_partial_progress import log_set_at
from test_workout_transactions import FakeDatabase


async def repertoire_fixture():
    database = FakeDatabase()
    service = WorkoutService(database)
    plan = blueprint()
    plan['end_date'] = '2026-09-22'
    day = deepcopy(plan['days'][0])
    day.update(day_id='day_arms', date='2026-09-22', title='Arms')
    segment = day['segments'][0]
    segment.update(kind='circuit', title='Arms circuit')
    slot = segment['slots'][0]
    slot.update(slot_id='slot_arms', role='arms')
    for index, candidate in enumerate(slot['candidates']):
        candidate.update(candidate_id=f'cand_curl_{index}', exercise_id=f'ex_curl_{index}')
        candidate['prescription']['round_targets'] = [
            {'reps': {'min': 10 + number, 'max': 10 + number}, 'load': {'value': 8 + number, 'unit': 'kg'}} for number in range(3)
        ]
    plan['days'].append(day)
    await service.solidify_blueprint('acc_one', BlueprintInput(**plan), None, 'publish', {'kind': 'agent'})
    result = await service.generate('acc_one', GenerateInput(date='2026-09-21', request_id='generate'))
    workout, _ = await log_set_at(service, result['workout'], 0, 'log-original')
    repertoire = await service.exercise_repertoire('acc_one', workout['workout_id'])
    candidate = next(item for item in repertoire['candidates'] if item['exercise_id'] == 'ex_curl_0')
    body = ExerciseAddInput(
        expected_revision=workout['revision'], request_id='quick-add', blueprint_id=repertoire['blueprint_id'],
        expected_blueprint_revision=repertoire['blueprint_revision'],
        **{key: candidate[key] for key in ('day_id', 'slot_id', 'candidate_id')},
    )
    return database, service, workout, repertoire, body


@pytest.mark.asyncio
async def test_repertoire_includes_other_days_marks_existing_and_deduplicates():
    database, service, workout, repertoire, _ = await repertoire_fixture()
    candidates = repertoire['candidates']
    assert len(candidates) == 4
    assert sum(item['already_added'] for item in candidates) == 1
    assert next(item for item in candidates if item['exercise_id'] == 'ex_curl_0')['sets'] == 3
    assert next(item for item in candidates if item['exercise_id'] == 'ex_curl_0')['target_summary'] == '10 reps · 8kg / 11 reps · 9kg / 12 reps · 10kg'
    # Duplicate an exercise with a different prescription on the other day.
    plan = database.documents['blueprints'][0]
    plan['days'][1]['segments'][0]['slots'][0]['candidates'].append(deepcopy(plan['days'][0]['segments'][0]['slots'][0]['candidates'][0]))
    result = await service.exercise_repertoire('acc_one', workout['workout_id'])
    assert len(result['candidates']) == 4
    assert next(item for item in result['candidates'] if item['exercise_id'] == 'ex_chest_supported_row_machine')['day_id'] == 'day_upper_a'


@pytest.mark.asyncio
async def test_add_preserves_logs_round_targets_and_blueprint_with_idempotent_readback():
    database, service, workout, repertoire, body = await repertoire_fixture()
    original_blueprint = deepcopy(database.documents['blueprints'])
    response = await service.add_exercise('acc_one', workout['workout_id'], body)
    saved = await service.workout('acc_one', workout['workout_id'])
    assert response['effect'] == 'exercise_added'
    assert saved == response['workout']
    assert saved['segments'][:-1] == workout['segments']
    assert saved['status'] == 'in_progress'
    segment = saved['segments'][-1]
    assert segment['kind'] == 'straight_sets'
    assert segment['segment_id'] != workout['segments'][0]['segment_id']
    item = segment['items'][0]
    targets = original_blueprint[0]['days'][1]['segments'][0]['slots'][0]['candidates'][0]['prescription']['round_targets']
    assert [row['target'] for row in item['sets']] == targets
    assert all(row['actual'] is None for row in item['sets'])
    assert len({row['set_id'] for row in item['sets']}) == 3
    assert database.documents['blueprints'] == original_blueprint
    assert await service.add_exercise('acc_one', workout['workout_id'], body) == response
    updated = await service.exercise_repertoire('acc_one', workout['workout_id'])
    assert next(row for row in updated['candidates'] if row['exercise_id'] == 'ex_curl_0')['already_added']


@pytest.mark.asyncio
async def test_cross_day_add_can_swap_after_partial_logging():
    _, service, workout, _, body = await repertoire_fixture()
    saved = (await service.add_exercise('acc_one', workout['workout_id'], body))['workout']
    item = saved['segments'][-1]['items'][0]
    candidates = await service.swap_candidates('acc_one', saved['workout_id'], item['exercise_instance_id'])
    assert candidates['candidates'][0]['exercise_id'] == 'ex_curl_1'
    saved = (await service.log_set('acc_one', saved['workout_id'], item['sets'][0]['set_id'], SetLogInput(
        actual=SetActual(status='completed', reps=10), expected_revision=saved['revision'], request_id='log-added',
    )))['workout']
    saved = (await service.swap('acc_one', saved['workout_id'], item['exercise_instance_id'], SwapInput(
        expected_revision=saved['revision'], request_id='swap-added', reason='Equipment occupied.', target_candidate_id='cand_curl_1',
    )))['workout']
    assert saved['segments'][-1]['items'][0]['sets'][0]['actual']['reps'] == 10
    assert saved['segments'][-1]['items'][1]['source_blueprint'] == item['source_blueprint']


@pytest.mark.asyncio
@pytest.mark.parametrize(('change', 'code'), [
    ({'expected_revision': 'rev_' + 'f' * 32}, 'stale_revision'),
    ({'expected_blueprint_revision': 'rev_' + 'f' * 32}, 'stale_blueprint'),
    ({'blueprint_id': 'bp_another_account'}, 'stale_blueprint'),
    ({'candidate_id': 'cand_missing'}, 'add_candidate_not_found'),
    ({'day_id': 'day_missing'}, 'add_candidate_not_found'),
])
async def test_invalid_or_stale_selection_never_changes_workout(change, code):
    _, service, workout, _, body = await repertoire_fixture()
    with pytest.raises(WorkoutDomainError) as error:
        await service.add_exercise('acc_one', workout['workout_id'], body.model_copy(update=change))
    assert error.value.code == code
    assert await service.workout('acc_one', workout['workout_id']) == workout


@pytest.mark.asyncio
async def test_duplicate_and_other_account_adds_are_rejected():
    _, service, workout, _, body = await repertoire_fixture()
    for operation in (service.exercise_repertoire('acc_other', workout['workout_id']), service.add_exercise('acc_other', workout['workout_id'], body)):
        with pytest.raises(WorkoutDomainError) as error:
            await operation
        assert error.value.code == 'workout_not_found'
    saved = (await service.add_exercise('acc_one', workout['workout_id'], body))['workout']
    with pytest.raises(WorkoutDomainError) as error:
        await service.add_exercise('acc_one', workout['workout_id'], body.model_copy(update={'request_id': 'second-tap', 'expected_revision': saved['revision']}))
    assert error.value.code == 'exercise_already_added'
    assert await service.workout('acc_one', workout['workout_id']) == saved


@pytest.mark.asyncio
async def test_routes_use_authenticated_owner_and_require_edit_permission(monkeypatch):
    _, service, workout, _, body = await repertoire_fixture()
    monkeypatch.setattr(main, 'workouts', lambda: service)
    async def owner():
        return {'account_id': 'acc_one'}
    main.app.dependency_overrides[main.require_view_account] = owner
    main.app.dependency_overrides[main.require_edit_account] = owner
    try:
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=main.app), base_url='http://test') as client:
            route = f'/v1/workouts/{workout["workout_id"]}'
            assert (await client.get(route + '/exercise-repertoire')).status_code == 200
            result = await client.post(route + '/exercises', json=body.model_dump())
            assert result.status_code == 200
            assert result.json()['effect'] == 'exercise_added'
            async def forbidden():
                raise main.HTTPException(status_code=403, detail='Read-only coach')
            main.app.dependency_overrides[main.require_edit_account] = forbidden
            assert (await client.post(route + '/exercises', json=body.model_dump())).status_code == 403
    finally:
        main.app.dependency_overrides.clear()


@pytest.mark.asyncio
async def test_repertoire_uses_exact_exercise_revision_and_owner_metadata():
    database, service, workout, _, _ = await repertoire_fixture()
    revision = database.documents['blueprints'][0]['days'][1]['segments'][0]['slots'][0]['candidates'][0]['exercise_revision']
    database.documents['exercises'].extend([
        {'account_id': 'acc_other', 'exercise_id': 'ex_curl_0', 'revision': revision, 'name': 'Other private exercise'},
        {'account_id': 'acc_one', 'exercise_id': 'ex_curl_0', 'revision': 'rev_' + 'f' * 32, 'name': 'Obsolete curl'},
        {'account_id': 'acc_one', 'exercise_id': 'ex_curl_0', 'revision': revision, 'name': 'Dumbbell curl', 'primary_muscles': ['biceps'], 'equipment_kind': 'dumbbell'},
    ])
    result = await service.exercise_repertoire('acc_one', workout['workout_id'])
    curl = next(row for row in result['candidates'] if row['exercise_id'] == 'ex_curl_0')
    assert curl['name'] == 'Dumbbell curl'
    assert curl['primary_muscles'] == ['biceps']
    assert curl['equipment_kind'] == 'dumbbell'


@pytest.mark.asyncio
async def test_forbidden_exercise_is_hidden_and_cannot_be_added():
    database, service, workout, _, body = await repertoire_fixture()
    database.documents['blueprints'][0]['hard_constraints']['forbidden_exercise_ids'] = ['ex_curl_0']
    result = await service.exercise_repertoire('acc_one', workout['workout_id'])
    assert not any(row['exercise_id'] == 'ex_curl_0' for row in result['candidates'])
    with pytest.raises(WorkoutDomainError) as error:
        await service.add_exercise('acc_one', workout['workout_id'], body)
    assert error.value.code == 'exercise_forbidden'
    assert await service.workout('acc_one', workout['workout_id']) == workout
