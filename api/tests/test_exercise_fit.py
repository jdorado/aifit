from copy import deepcopy

import httpx
import pytest

from aifit_api import exercise_fit
from test_workout_quick_add import repertoire_fixture


@pytest.mark.asyncio
async def test_fit_is_scoped_read_only_and_never_fabricates_ratings(monkeypatch):
    database, service, workout, repertoire, _ = await repertoire_fixture()
    # Only the selected tenant's earlier, non-deleted training may reach Jev.
    for account, day, deleted in [
        ('acc_one', '2026-09-20', False), ('acc_other', '2026-09-20', False),
        ('acc_one', '2026-09-22', False), ('acc_one', '2026-09-19', True),
        ('acc_one', '2026-08-01', False),
    ]:
        row = deepcopy(database.documents['workouts'][0])
        row.update(account_id=account, date=day, workout_id=f'{account}-{day}')
        if deleted:
            row['deleted_at'] = '2026-09-20'
        database.documents['workouts'].append(row)
    before = deepcopy(database.documents)
    monkeypatch.setenv('TYPESAFE_API_KEY', 'test-only')
    requests = []

    async def provider(_client, url, **kwargs):
        body = kwargs['json']
        requests.append(body)
        answers = {key: {'type': 'score', 'score': 1 + int(key.split('_')[0]) % 3, 'confidence': 0.9}
                   for key in body['questions']}
        return httpx.Response(200, request=httpx.Request('POST', url), json={'model': 'jev-test', 'answers': answers})

    monkeypatch.setattr(httpx.AsyncClient, 'post', provider)
    ranked = await exercise_fit.rank_candidates(service, 'acc_one', repertoire, 'add')
    assert ranked['ranking']['status'] == 'ranked'
    assert ranked['workout_revision'] == repertoire['workout_revision']
    assert ranked['blueprint_revision'] == repertoire['blueprint_revision']
    assert {r['exercise_id'] for r in ranked['candidates']} == {r['exercise_id'] for r in repertoire['candidates']}
    assert ranked['candidates'][-1]['already_added'] and 'fit' not in ranked['candidates'][-1]
    scores = [r['fit']['score'] for r in ranked['candidates'] if 'fit' in r]
    assert scores == sorted(scores, reverse=True)
    assert requests[0]['state']['recent_logged_training'][0]['date'] == '2026-09-20'
    assert len(requests[0]['state']['recent_logged_training']) == 1
    assert requests[0]['state']['today']['exercises'][0]['logged_sets'] == 1
    assert requests[0]['state']['today']['exercises'][0]['remaining_sets'] == 2
    assert all('candidate' in q['instructions'] for q in requests[0]['questions'].values())
    assert 'account_id' not in str(requests)

    item = workout['segments'][0]['items'][0]
    swaps = await service.swap_candidates('acc_one', workout['workout_id'], item['exercise_instance_id'])
    ranked_swaps = await exercise_fit.rank_candidates(service, 'acc_one', swaps, 'swap')
    assert ranked_swaps['candidates'][0]['fit']['score'] == 25
    assert requests[-1]['state']['replacing_exercise_instance_id'] == item['exercise_instance_id']
    assert database.documents == before  # scoring never writes logs, plans or receipts

    async def malformed(_client, url, **_kwargs):
        return httpx.Response(200, request=httpx.Request('POST', url), json={'model': 'jev-test', 'answers': {}})

    monkeypatch.setattr(httpx.AsyncClient, 'post', malformed)
    fallback = await exercise_fit.rank_candidates(service, 'acc_one', repertoire, 'add')
    assert fallback['ranking']['status'] == 'unavailable'
    assert fallback['candidates'] == repertoire['candidates']
    monkeypatch.delenv('TYPESAFE_API_KEY')
    assert (await exercise_fit.rank_candidates(service, 'acc_one', repertoire, 'add'))['candidates'] == repertoire['candidates']
