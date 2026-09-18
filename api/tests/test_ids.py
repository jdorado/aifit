from aifit_api.main import stable_id


def test_stable_id_is_deterministic_and_opaque() -> None:
    value = stable_id("acc", "did:privy:example")
    assert value == stable_id("acc", "did:privy:example")
    assert value.startswith("acc_")
    assert "privy" not in value
