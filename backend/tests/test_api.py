import json

import httpx
import pytest

from app.core.config import Settings
from app.core.errors import ServiceError

TOKEN = "test-admin-token-at-least-32-characters"
HEADERS = {"Authorization": f"Bearer {TOKEN}"}


def conversation(client, **kwargs):
    response = client.post(
        "/api/v1/conversations", headers=HEADERS, json={"peer_id": "friend-1", **kwargs}
    )
    assert response.status_code == 201, response.text
    return response.json()["id"]


def provider(client):
    response = client.post(
        "/api/v1/providers",
        headers=HEADERS,
        json={
            "name": "demo",
            "base_url": "https://example.test/v1",
            "api_key_env": "TEST_PROVIDER_KEY",
        },
    )
    assert response.status_code == 201
    return response.json()["id"]


def configure(client, cid, pid):
    result = client.put(
        f"/api/v1/conversations/{cid}/settings",
        headers=HEADERS,
        json={"provider_id": pid, "model_id": "demo-model"},
    )
    assert result.status_code == 200


def test_auth(client):
    health = client.get("/health")
    assert health.json() == {"status": "ok"}
    assert health.headers["x-caicai-service"] == "caicai-bot"
    assert "x-caicai-instance" not in health.headers
    assert client.get("/api/v1/providers").status_code == 401
    assert client.get("/api/v1/providers", headers=HEADERS).json() == []


def test_desktop_health_instance(client):
    client.app.state.desktop_run_id = "owned-test-instance"
    response = client.get("/health")
    assert response.headers["x-caicai-instance"] == "owned-test-instance"
    assert response.json() == {"status": "ok"}


def test_debug_dedup_and_persistence(client):
    cid = conversation(client)
    url = f"/api/v1/debug/conversations/{cid}/messages"
    payload = {"external_id": "m1", "text": "你好"}
    first = client.post(url, headers=HEADERS, json=payload)
    assert first.status_code == 200
    assert first.json()["assistant_text"] == "模拟回复：你好"
    assert first.json()["status"] == "completed"
    assert client.post(url, headers=HEADERS, json=payload).json() == first.json()
    history = client.get(f"/api/v1/conversations/{cid}/messages", headers=HEADERS)
    assert len(history.json()) == 1


def test_provider_validation(client):
    provider(client)
    response = client.get("/api/v1/providers", headers=HEADERS)
    assert set(response.json()[0]) == {
        "id",
        "name",
        "base_url",
        "api_key_env",
        "has_api_key",
        "key_source",
    }
    assert (
        client.post(
            "/api/v1/providers",
            headers=HEADERS,
            json={
                "name": "demo",
                "base_url": "https://example.test/v1",
                "api_key_env": "KEY",
            },
        ).status_code
        == 409
    )
    assert (
        client.post(
            "/api/v1/providers",
            headers=HEADERS,
            json={
                "name": "bad",
                "base_url": "https://user:secret@example.test/v1",
                "api_key_env": "KEY",
            },
        ).status_code
        == 422
    )


def test_settings_require_an_existing_voice_for_speech(client):
    cid = conversation(client)
    url = f"/api/v1/conversations/{cid}/settings"
    assert client.put(url, headers=HEADERS, json={"model_id": "x"}).status_code == 422
    assert (
        client.put(
            url, headers=HEADERS, json={"provider_id": "missing", "model_id": "x"}
        ).status_code
        == 404
    )
    assert client.put(url, headers=HEADERS, json={"reply_mode": "both"}).status_code == 422
    result = client.put(url, headers=HEADERS, json={"reply_mode": "both", "voice_id": "missing"})
    assert result.status_code == 404
    assert result.json()["error"]["code"] == "voice_not_found"


def test_real_adapter_payload_and_context(client, monkeypatch):
    pid, cid = provider(client), conversation(client)
    configure(client, cid, pid)
    monkeypatch.setenv("TEST_PROVIDER_KEY", "private-test-key")
    requests = []

    def upstream(request):
        requests.append(request)
        assert request.headers["Authorization"] == "Bearer private-test-key"
        if request.url.path == "/v1/models":
            return httpx.Response(200, json={"data": [{"id": "demo-model"}]})
        assert request.url.path == "/v1/chat/completions"
        return httpx.Response(200, json={"choices": [{"message": {"content": "你好呀"}}]})

    original_client = httpx.Client
    monkeypatch.setattr(
        "app.integrations.llm.httpx.Client",
        lambda **kwargs: original_client(transport=httpx.MockTransport(upstream), **kwargs),
    )
    result = client.get(f"/api/v1/providers/{pid}/models", headers=HEADERS)
    assert result.json() == {"models": ["demo-model"]}
    for external_id in ["m1", "m2"]:
        response = client.post(
            f"/api/v1/debug/conversations/{cid}/messages",
            headers=HEADERS,
            json={"external_id": external_id, "text": "你好"},
        )
        assert response.json()["assistant_text"] == "你好呀"
    assert len(json.loads(requests[-1].content)["messages"]) == 4


def test_wechat_contract_and_dedup(client, monkeypatch):
    url = "/api/v1/channels/wechat-personal/inbound"
    payload = {"account_id": "local", "peer_id": "friend-1", "external_id": "wx-1", "text": "你好"}
    assert client.post(url, json=payload).status_code == 401
    cid = conversation(client, channel="wechat_personal")
    configure(client, cid, provider(client))
    deliveries = []
    service = client.app.state.chat_service
    monkeypatch.setattr(service.llm, "complete", lambda *args: "你好呀")
    monkeypatch.setattr(service.wechat, "send_text", lambda *args: deliveries.append(args))
    for _ in range(2):
        result = client.post(url, headers={"Authorization": "Bearer test-inbound"}, json=payload)
        assert result.json()["status"] == "sent"
    assert len(deliveries) == 1


def test_failed_generation_persists(client, monkeypatch):
    cid = conversation(client)
    configure(client, cid, provider(client))

    def fail(*args):
        raise ServiceError("llm_upstream_error", "模型服务请求失败", 502)

    monkeypatch.setattr(client.app.state.chat_service.llm, "complete", fail)
    result = client.post(
        f"/api/v1/debug/conversations/{cid}/messages",
        headers=HEADERS,
        json={"external_id": "fail-1", "text": "你好"},
    )
    assert result.status_code == 502
    history = client.get(f"/api/v1/conversations/{cid}/messages", headers=HEADERS)
    assert history.json()[0]["status"] == "failed"


def test_production_rejects_mock():
    with pytest.raises(ValueError, match="MOCK_LLM_ENABLED"):
        Settings(_env_file=None, admin_token=TOKEN, app_env="production", mock_llm_enabled=True)


def test_uncertain_delivery_does_not_send_again(client, monkeypatch):
    cid = conversation(client, channel="wechat_personal")
    configure(client, cid, provider(client))
    service = client.app.state.chat_service
    monkeypatch.setattr(service.llm, "complete", lambda *args: "你好呀")
    deliveries = []

    def uncertain(*args):
        deliveries.append(args)
        raise ServiceError("wechat_send_failed", "微信桥接发送失败", 502)

    monkeypatch.setattr(service.wechat, "send_text", uncertain)
    url = "/api/v1/channels/wechat-personal/inbound"
    headers = {"Authorization": "Bearer test-inbound"}
    payload = {
        "account_id": "local",
        "peer_id": "friend-1",
        "external_id": "wx-timeout",
        "text": "你好",
    }
    assert client.post(url, headers=headers, json=payload).status_code == 502
    result = client.post(url, headers=headers, json=payload)
    assert result.json()["status"] == "delivery_unknown"
    assert len(deliveries) == 1


def test_same_conversation_is_serialized(client):
    from threading import Lock

    cid = conversation(client)
    lock = Lock()
    client.app.state.chat_service._locks[cid] = lock
    lock.acquire()
    try:
        result = client.post(
            f"/api/v1/debug/conversations/{cid}/messages",
            headers=HEADERS,
            json={"external_id": "busy", "text": "你好"},
        )
        assert result.status_code == 409
        assert result.json()["error"]["code"] == "conversation_busy"
    finally:
        lock.release()


def test_production_disables_debug(client):
    cid = conversation(client)
    client.app.state.settings.app_env = "production"
    result = client.post(
        f"/api/v1/debug/conversations/{cid}/messages",
        headers=HEADERS,
        json={"external_id": "prod", "text": "你好"},
    )
    assert result.status_code == 404
