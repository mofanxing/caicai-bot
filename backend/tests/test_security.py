import os
import sqlite3
from threading import Lock

import httpx
import pytest
from cryptography.fernet import Fernet
from sqlalchemy import create_engine, inspect, select, text
from test_api import HEADERS, TOKEN, configure, conversation, provider

from app.core.config import Settings
from app.core.errors import ServiceError
from app.core.secrets import SecretVault
from app.migrations import initialize_database
from app.models import Message, Provider

CANARY = "sk-test-private-canary-never-expose-123456"


def create_encrypted_provider(client, **extra):
    response = client.post(
        "/api/v1/providers",
        headers=HEADERS,
        json={
            "name": "encrypted-site",
            "base_url": "https://example.test/v1",
            "api_key": CANARY,
            **extra,
        },
    )
    assert response.status_code == 201, response.text
    return response


def test_key_is_encrypted_at_rest_and_write_only(client):
    response = create_encrypted_provider(client)
    assert response.json()["has_api_key"] is True
    assert response.json()["key_source"] == "encrypted"
    assert response.json()["api_key_env"] == ""
    assert CANARY not in response.text
    assert "api_key_encrypted" not in response.json()
    listed = client.get("/api/v1/providers", headers=HEADERS)
    assert CANARY not in listed.text
    assert listed.headers["cache-control"] == "no-store"
    with client.app.state.session_factory() as db:
        stored = db.get(Provider, response.json()["id"])
        ciphertext = stored.api_key_encrypted
        assert CANARY not in ciphertext
        assert ciphertext not in response.text
        assert ciphertext not in listed.text
        assert client.app.state.secret_vault.decrypt(ciphertext) == CANARY


def test_deleted_turns_are_removed_from_next_model_context(client, monkeypatch):
    pid = create_encrypted_provider(client).json()["id"]
    cid = conversation(client)
    configure(client, cid, pid)
    contexts = []

    def complete(provider, model, messages):
        contexts.append(messages)
        return "reply"

    monkeypatch.setattr(client.app.state.chat_service.llm, "complete", complete)
    url = f"/api/v1/debug/conversations/{cid}/messages"
    first = client.post(url, headers=HEADERS, json={"external_id": "1", "text": "delete me"}).json()
    client.post(url, headers=HEADERS, json={"external_id": "2", "text": "keep me"})
    client.delete(f"/api/v1/conversations/{cid}/messages/{first['id']}", headers=HEADERS)
    client.post(url, headers=HEADERS, json={"external_id": "3", "text": "next"})
    assert [message["content"] for message in contexts[-1][1:]] == ["keep me", "reply", "next"]
    client.delete(f"/api/v1/conversations/{cid}/messages", headers=HEADERS)
    client.post(url, headers=HEADERS, json={"external_id": "4", "text": "fresh"})
    assert [message["content"] for message in contexts[-1][1:]] == ["fresh"]


def test_corrupt_encrypted_key_never_falls_back_to_environment(client, monkeypatch):
    pid = create_encrypted_provider(client).json()["id"]
    monkeypatch.setenv("LEGACY_KEY", "never-use-this-key")
    with client.app.state.session_factory() as db:
        stored = db.get(Provider, pid)
        stored.api_key_encrypted = "corrupt-ciphertext"
        stored.api_key_env = "LEGACY_KEY"
        db.commit()
    response = client.get(f"/api/v1/providers/{pid}/models", headers=HEADERS)
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "secret_decryption_failed"
    assert "never-use-this-key" not in response.text


def test_encrypted_key_used_only_for_bound_upstream(client, monkeypatch):
    pid = create_encrypted_provider(client).json()["id"]
    original = httpx.Client
    requests = []

    def upstream(request):
        requests.append(request)
        assert str(request.url) == "https://example.test/v1/models"
        assert request.headers["authorization"] == "Bearer " + CANARY
        return httpx.Response(200, json={"data": [{"id": "demo-model"}]})

    monkeypatch.setattr(
        "app.integrations.llm.httpx.Client",
        lambda **kwargs: original(transport=httpx.MockTransport(upstream), **kwargs),
    )
    assert client.get(f"/api/v1/providers/{pid}/models", headers=HEADERS).json() == {
        "models": ["demo-model"],
    }
    assert len(requests) == 1


def test_key_replacement_is_not_retrievable_and_clears_env_source(client, monkeypatch):
    monkeypatch.setenv("TEST_PROVIDER_KEY", "old-env-key")
    pid = provider(client)
    service = client.app.state.chat_service
    service.llm._responses_models.add((pid, "https://example.test/v1", "demo"))
    response = client.put(f"/api/v1/providers/{pid}/key", headers=HEADERS, json={"api_key": CANARY})
    assert response.status_code == 200
    assert response.json()["key_source"] == "encrypted"
    assert response.json()["api_key_env"] == ""
    assert CANARY not in response.text
    assert not service.llm._responses_models
    assert client.get(f"/api/v1/providers/{pid}/key", headers=HEADERS).status_code == 405
    assert (
        client.put(
            f"/api/v1/providers/{pid}/key",
            headers=HEADERS,
            json={"api_key": CANARY, "base_url": "https://attacker.test"},
        ).status_code
        == 422
    )
    assert (
        client.get("/api/v1/providers", headers=HEADERS).json()[0]["base_url"]
        == "https://example.test/v1"
    )


@pytest.mark.parametrize(
    "payload",
    [
        {"api_key": CANARY},
        {"name": "x", "base_url": "https://example.test/v1", "api_key": CANARY + chr(10) + "bad"},
        {"name": "x", "base_url": "https://example.test/v1", "api_key": CANARY, "extra": CANARY},
        {
            "name": "x",
            "base_url": "https://example.test/v1",
            "api_key": CANARY,
            "api_key_env": "KEY",
        },
    ],
)
def test_validation_never_echoes_input_secret(client, payload):
    response = client.post("/api/v1/providers", headers=HEADERS, json=payload)
    assert response.status_code == 422
    assert CANARY not in response.text
    assert "input" not in response.json()["detail"][0]


def test_unauthorized_writes_and_deletes_are_rejected(client):
    pid = create_encrypted_provider(client).json()["id"]
    cid = conversation(client)
    for method, url, body in [
        (
            "POST",
            "/api/v1/providers",
            {"name": "x", "base_url": "https://example.test", "api_key": CANARY},
        ),
        ("PUT", f"/api/v1/providers/{pid}/key", {"api_key": CANARY}),
        ("DELETE", f"/api/v1/providers/{pid}", None),
        ("DELETE", f"/api/v1/conversations/{cid}/messages", None),
        ("DELETE", f"/api/v1/conversations/{cid}", None),
    ]:
        response = client.request(method, url, json=body)
        assert response.status_code == 401
        assert CANARY not in response.text


@pytest.mark.parametrize(
    "url", ["http://example.com/v1", "ftp://example.com", "https://example.com/v1#fragment"]
)
def test_insecure_external_destinations_rejected(client, url):
    response = client.post(
        "/api/v1/providers",
        headers=HEADERS,
        json={"name": "unsafe", "base_url": url, "api_key": CANARY},
    )
    assert response.status_code == 422
    assert CANARY not in response.text


def test_delete_provider_keeps_history_and_unbinds_conversations(client):
    pid = create_encrypted_provider(client).json()["id"]
    cid = conversation(client)
    message = client.post(
        f"/api/v1/debug/conversations/{cid}/messages",
        headers=HEADERS,
        json={"external_id": "m1", "text": "hello"},
    )
    assert message.status_code == 200
    configure(client, cid, pid)
    result = client.delete(f"/api/v1/providers/{pid}", headers=HEADERS)
    assert result.json() == {"deleted": True, "affected_conversations": 1}
    assert client.get("/api/v1/providers", headers=HEADERS).json() == []
    remaining = client.get("/api/v1/conversations", headers=HEADERS).json()[0]
    assert remaining["provider_id"] is None and remaining["model_id"] is None
    assert len(client.get(f"/api/v1/conversations/{cid}/messages", headers=HEADERS).json()) == 1
    with client.app.state.session_factory() as db:
        assert db.get(Provider, pid) is None


def test_delete_turn_clear_history_and_delete_session(client):
    cid = conversation(client)
    turns = []
    for external_id in ["m1", "m2"]:
        turns.append(
            client.post(
                f"/api/v1/debug/conversations/{cid}/messages",
                headers=HEADERS,
                json={"external_id": external_id, "text": "hi"},
            ).json()
        )
    assert (
        client.delete(
            f"/api/v1/conversations/{cid}/messages/{turns[0]['id']}", headers=HEADERS
        ).status_code
        == 200
    )
    assert len(client.get(f"/api/v1/conversations/{cid}/messages", headers=HEADERS).json()) == 1
    assert client.delete(f"/api/v1/conversations/{cid}/messages", headers=HEADERS).json() == {
        "deleted_count": 1
    }
    assert len(client.get("/api/v1/conversations", headers=HEADERS).json()) == 1
    assert client.get(f"/api/v1/conversations/{cid}/messages", headers=HEADERS).json() == []
    client.post(
        f"/api/v1/debug/conversations/{cid}/messages",
        headers=HEADERS,
        json={"external_id": "m3", "text": "hi"},
    )
    assert client.delete(f"/api/v1/conversations/{cid}", headers=HEADERS).status_code == 200
    assert client.get("/api/v1/conversations", headers=HEADERS).json() == []
    with client.app.state.session_factory() as db:
        assert db.scalars(select(Message)).all() == []


def test_cannot_delete_a_turn_from_another_conversation(client):
    first, second = conversation(client), conversation(client, peer_id="other")
    turn = client.post(
        f"/api/v1/debug/conversations/{first}/messages",
        headers=HEADERS,
        json={"external_id": "m1", "text": "hi"},
    ).json()
    assert (
        client.delete(
            f"/api/v1/conversations/{second}/messages/{turn['id']}", headers=HEADERS
        ).status_code
        == 404
    )
    assert len(client.get(f"/api/v1/conversations/{first}/messages", headers=HEADERS).json()) == 1


def test_busy_resources_block_destructive_mutations(client):
    pid, cid = provider(client), conversation(client)
    service = client.app.state.chat_service
    provider_lock, conversation_lock = Lock(), Lock()
    service._provider_locks[pid] = provider_lock
    service._locks[cid] = conversation_lock
    provider_lock.acquire()
    conversation_lock.acquire()
    try:
        assert client.delete(f"/api/v1/providers/{pid}", headers=HEADERS).status_code == 409
        assert (
            client.put(
                f"/api/v1/providers/{pid}/key", headers=HEADERS, json={"api_key": CANARY}
            ).status_code
            == 409
        )
        assert (
            client.delete(f"/api/v1/conversations/{cid}/messages", headers=HEADERS).status_code
            == 409
        )
        assert client.delete(f"/api/v1/conversations/{cid}", headers=HEADERS).status_code == 409
    finally:
        provider_lock.release()
        conversation_lock.release()


def test_wechat_history_not_deleted_by_debug_operations(client):
    cid = conversation(client, channel="wechat_personal")
    assert (
        client.delete(f"/api/v1/conversations/{cid}/messages", headers=HEADERS).status_code == 409
    )
    assert client.delete(f"/api/v1/conversations/{cid}", headers=HEADERS).status_code == 409


def test_master_key_persists_and_wrong_key_fails_closed(tmp_path):
    keyfile = tmp_path / "keys" / "provider.key"
    settings = Settings(
        _env_file=None,
        admin_token=TOKEN,
        provider_encryption_key="",
        provider_encryption_key_file=str(keyfile),
        app_env="test",
    )
    first = SecretVault(settings)
    encrypted = first.encrypt(CANARY)
    assert SecretVault(settings).decrypt(encrypted) == CANARY
    if os.name == "posix":
        assert keyfile.stat().st_mode & 0o777 == 0o600
    wrong = SecretVault(
        Settings(
            _env_file=None,
            admin_token=TOKEN,
            provider_encryption_key=Fernet.generate_key().decode(),
        )
    )
    with pytest.raises(ServiceError, match="无法解密"):
        wrong.decrypt(encrypted)


def test_production_does_not_generate_a_local_master_key(tmp_path):
    keyfile = tmp_path / "missing.key"
    vault = SecretVault(
        Settings(
            _env_file=None,
            admin_token=TOKEN,
            app_env="production",
            mock_llm_enabled=False,
            provider_encryption_key="",
            provider_encryption_key_file=str(keyfile),
        )
    )
    with pytest.raises(ServiceError) as exc:
        vault.encrypt(CANARY)
    assert exc.value.code == "encryption_not_configured"
    assert not keyfile.exists()


def test_existing_database_additive_migration_is_idempotent(tmp_path):
    path = tmp_path / "old.db"
    with sqlite3.connect(path) as db:
        db.execute(
            "CREATE TABLE providers (id VARCHAR PRIMARY KEY, name VARCHAR, "
            "base_url VARCHAR, api_key_env VARCHAR NOT NULL)"
        )
        db.execute("INSERT INTO providers VALUES ('old','legacy','https://example.test/v1','KEY')")
    engine = create_engine("sqlite:///" + str(path))
    initialize_database(engine)
    initialize_database(engine)
    assert "api_key_encrypted" in {
        column["name"] for column in inspect(engine).get_columns("providers")
    }
    with engine.connect() as connection:
        assert connection.execute(
            text("SELECT api_key_env, api_key_encrypted FROM providers")
        ).one() == ("KEY", None)
    engine.dispose()
