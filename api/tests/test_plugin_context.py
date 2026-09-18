import asyncio

from aifit_api import auth, main


def test_agent_context_is_namespaced_to_the_aifit_plugin(monkeypatch):
    secret = "test-secret-with-at-least-thirty-two-bytes"
    monkeypatch.setattr(main, "AIFIT_AGENT_CAPABILITY_SECRET", secret)
    monkeypatch.setattr(auth, "AIFIT_AGENT_CAPABILITY_SECRET", secret)
    monkeypatch.setattr(main, "AGENT_API_BASE_URL", "http://aifit-api:8100")

    context = main.agent_run_context({"account_id": "acc_one", "tenant_id": "ten_one"}, "job_one")

    assert context is not None
    assert set(context) == {"plugins"}
    plugin = context["plugins"]["aifit"]
    assert plugin["api_base_url"] == "http://aifit-api:8100"
    assert asyncio.run(auth.require_agent_capability(f"Bearer {plugin['capability']}"))
