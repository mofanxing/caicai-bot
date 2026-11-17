import json

import pytest
from conftest import TOKEN

HEADERS = {"Authorization": f"Bearer {TOKEN}"}


def create_conversation(client, channel="desktop"):
    response = client.post(
        "/api/v1/conversations",
        headers=HEADERS,
        json={"channel": channel, "account_id": "desktop", "peer_id": "日常聊天"},
    )
    assert response.status_code == 201
    return response.json()["id"]


@pytest.mark.parametrize("streaming", [False, True])
def test_desktop_available_in_production_with_real_adapter_and_dedup(
    client, monkeypatch, streaming
):
    cid = create_conversation(client)
    debug = create_conversation(client, "debug")
    provider = client.post(
        "/api/v1/providers",
        headers=HEADERS,
        json={
            "name": "desktop-provider",
            "base_url": "https://example.test/v1",
            "api_key_env": "DESKTOP_TEST_KEY",
        },
    ).json()["id"]
    assert (
        client.put(
            f"/api/v1/conversations/{cid}/settings",
            headers=HEADERS,
            json={
                "provider_id": provider,
                "model_id": "test",
            },
        ).status_code
        == 200
    )
    client.app.state.settings.app_env = "production"
    client.app.state.settings.mock_llm_enabled = False
    calls = []

    def complete(*args):
        calls.append(args)
        return "桌面回复。"

    def stream(*args):
        calls.append(args)
        yield "桌面"
        yield "回复。"

    service = client.app.state.chat_service
    monkeypatch.setattr(service.llm, "complete", complete)
    monkeypatch.setattr(service.llm, "stream", stream)
    monkeypatch.setattr(
        service.wechat, "send_text", lambda *args: pytest.fail("desktop must not send to WeChat")
    )
    suffix = "/stream" if streaming else ""
    url = f"/api/v1/desktop/conversations/{cid}/messages{suffix}"
    payload = {"external_id": "desktop-once", "text": "你好"}
    assert client.post(url, json=payload).status_code == 401
    result = None
    for _ in range(2):
        response = client.post(url, headers=HEADERS, json=payload)
        assert response.status_code == 200, response.text
        if streaming:
            events = [
                json.loads(line[6:])
                for line in response.text.splitlines()
                if line.startswith("data: ")
            ]
            assert events[-1]["type"] == "done"
            message = events[-1]["message"]
        else:
            message = response.json()
        assert message["assistant_text"] == "桌面回复。"
        assert message["status"] == "completed"
        assert result is None or message == result
        result = message
    assert len(calls) == 1
    assert (
        client.post(
            f"/api/v1/debug/conversations/{debug}/messages{suffix}", headers=HEADERS, json=payload
        ).status_code
        == 404
    )
    assert (
        client.delete(
            f"/api/v1/conversations/{cid}/messages/{result['id']}", headers=HEADERS
        ).status_code
        == 200
    )
    assert client.get(f"/api/v1/conversations/{cid}/messages", headers=HEADERS).json() == []
    assert client.delete(f"/api/v1/conversations/{cid}", headers=HEADERS).status_code == 200


@pytest.mark.parametrize("channel", ["debug", "wechat_personal"])
@pytest.mark.parametrize("suffix", ["", "/stream"])
def test_desktop_rejects_other_channels(client, channel, suffix):
    cid = create_conversation(client, channel)
    response = client.post(
        f"/api/v1/desktop/conversations/{cid}/messages{suffix}",
        headers=HEADERS,
        json={"external_id": "wrong", "text": "你好"},
    )
    assert response.status_code == 409
    assert response.json()["error"]["code"] == "wrong_channel"
