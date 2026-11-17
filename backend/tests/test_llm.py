import json

import httpx
import pytest

from app.core.errors import ServiceError
from app.integrations.llm import OpenAICompatibleClient
from app.models import Provider


def sse(*events):
    return httpx.Response(
        200,
        headers={"content-type": "text/event-stream"},
        content="".join(
            "data: " + (event if isinstance(event, str) else json.dumps(event)) + "\n\n"
            for event in events
        ),
    )


def test_stream_chat_emits_text_and_checks_completion(upstream):
    def handler(request):
        assert json.loads(request.content)["stream"] is True
        return sse(
            {"choices": [{"index": 0, "delta": {"role": "assistant"}}]},
            {"choices": [{"index": 0, "delta": {"content": "你好"}}]},
            {"choices": [{"index": 0, "delta": {"content": "呀。"}}]},
            {"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]},
            "[DONE]",
        )

    upstream(handler)
    stream = OpenAICompatibleClient(45).stream(site(), "demo", [])
    assert next(stream) == "你好"
    assert list(stream) == ["呀。"]


def test_stream_responses_protocol_switch_and_cache(upstream):
    calls = []

    def handler(request):
        calls.append(request.url.path)
        if request.url.path.endswith("chat/completions"):
            return httpx.Response(
                400, json={"error": {"message": "requires the responses protocol"}}
            )
        body = json.loads(request.content)
        assert body["stream"] is True and body["store"] is False
        assert body["instructions"] == "你是菜菜"
        return sse(
            {"type": "response.output_text.delta", "delta": "你好。"},
            {"type": "response.completed"},
        )

    upstream(handler)
    client = OpenAICompatibleClient(45)
    messages = [{"role": "system", "content": "你是菜菜"}]
    assert list(client.stream(site(), "demo", messages)) == ["你好。"]
    assert list(client.stream(site(), "demo", messages)) == ["你好。"]
    assert calls == ["/v1/chat/completions", "/v1/responses", "/v1/responses"]


@pytest.mark.parametrize("ending", [None, "length", "content_filter"])
def test_stream_rejects_truncation_and_does_not_retry(upstream, ending):
    calls = []

    def handler(request):
        calls.append(request)
        events = [{"choices": [{"delta": {"content": "已收到的文字"}}]}]
        if ending:
            events.append({"choices": [{"delta": {}, "finish_reason": ending}]})
        return sse(*events)

    upstream(handler)
    stream = OpenAICompatibleClient(45).stream(site(), "demo", [])
    assert next(stream) == "已收到的文字"
    with pytest.raises(ServiceError, match="完整的流式回答"):
        list(stream)
    assert len(calls) == 1


def test_stream_accepts_gateway_json_fallback(upstream):
    upstream(
        lambda request: httpx.Response(
            200, json={"choices": [{"message": {"content": "兼容回复"}}]}
        )
    )
    assert list(OpenAICompatibleClient(45).stream(site(), "demo", [])) == ["兼容回复"]


@pytest.fixture
def upstream(monkeypatch):
    monkeypatch.setenv("TEST_LLM_KEY", "private-key-never-log")
    original = httpx.Client

    def install(handler):
        monkeypatch.setattr(
            "app.integrations.llm.httpx.Client",
            lambda **kwargs: original(transport=httpx.MockTransport(handler), **kwargs),
        )

    return install


def site(base_url="https://example.test/v1"):
    return Provider(id="p1", name="test", base_url=base_url, api_key_env="TEST_LLM_KEY")


def response_output(status="completed"):
    return {
        "status": status,
        "output": [
            {"type": "reasoning", "content": [{"type": "output_text", "text": "hidden"}]},
            {
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [
                    {"type": "output_text", "text": "你好"},
                    {"type": "output_text", "text": "呀"},
                ],
            },
        ],
    }


@pytest.mark.parametrize(
    "base_url,expected_path",
    [
        ("https://example.test", "/v1/responses"),
        ("https://example.test/v1", "/v1/responses"),
        ("https://example.test/gateway/v1/", "/gateway/v1/responses"),
    ],
)
def test_explicit_protocol_switch_and_cache(upstream, base_url, expected_path):
    calls = []
    messages = [
        {"role": "system", "content": "你是菜菜"},
        {"role": "user", "content": "上一个问题"},
        {"role": "assistant", "content": "上一个回答"},
        {"role": "user", "content": "你好"},
    ]

    def handler(request):
        calls.append(request.url.path)
        if request.url.path.endswith("/chat/completions"):
            return httpx.Response(
                400,
                json={
                    "error": {
                        "message": "This account requires the Responses protocol. "
                        "Switch your client to POST /v1/responses; "
                        "both streaming and non-streaming requests are supported.",
                    }
                },
            )
        assert request.url.path == expected_path
        body = json.loads(request.content)
        assert body["model"] == "gpt-6.1-sol"
        assert body["instructions"] == "你是菜菜"
        assert body["input"] == messages[1:]
        assert body["store"] is False
        assert body["stream"] is False
        assert "messages" not in body
        return httpx.Response(200, json=response_output())

    upstream(handler)
    client = OpenAICompatibleClient(45)
    assert client.complete(site(base_url), "gpt-6.1-sol", messages) == "你好呀"
    assert client.complete(site(base_url), "gpt-6.1-sol", messages) == "你好呀"
    assert len(calls) == 3
    assert calls[-2:] == [expected_path, expected_path]


@pytest.mark.parametrize(
    "status,code",
    [
        (400, "llm_request_rejected"),
        (401, "llm_auth_error"),
        (403, "llm_auth_error"),
        (402, "llm_quota_error"),
        (404, "llm_not_found"),
        (429, "llm_rate_limited"),
        (503, "llm_upstream_error"),
        (307, "llm_redirect"),
    ],
)
def test_http_errors_are_specific_safe_and_never_retried(upstream, caplog, status, code):
    calls = []

    def handler(request):
        calls.append(request)
        return httpx.Response(status, json={"error": {"message": "private-key-never-log"}})

    upstream(handler)
    with pytest.raises(ServiceError) as exc:
        OpenAICompatibleClient(45).complete(site(), "demo", [{"role": "user", "content": "hi"}])
    assert exc.value.code == code
    assert str(status) in exc.value.message
    assert "private-key-never-log" not in str(exc.value)
    assert "private-key-never-log" not in caplog.text
    assert len(calls) == 1


@pytest.mark.parametrize(
    "error,code",
    [
        (httpx.ReadTimeout("private-key-never-log"), "llm_timeout"),
        (httpx.ConnectError("private-key-never-log"), "llm_connection_error"),
    ],
)
def test_transport_errors_do_not_leak_or_retry(upstream, caplog, error, code):
    calls = []

    def handler(request):
        calls.append(request)
        raise error

    upstream(handler)
    with pytest.raises(ServiceError) as exc:
        OpenAICompatibleClient(45).list_models(site())
    assert exc.value.code == code
    assert "private-key-never-log" not in str(exc.value) + caplog.text
    assert len(calls) == 1


def test_web_page_instead_of_json(upstream):
    upstream(lambda request: httpx.Response(200, text="<html>website</html>"))
    with pytest.raises(ServiceError) as exc:
        OpenAICompatibleClient(45).list_models(site())
    assert exc.value.code == "llm_invalid_response"


@pytest.mark.parametrize(
    "payload",
    [
        response_output("incomplete"),
        {"status": "completed", "output": []},
        {"status": "failed", "error": {"message": "secret"}},
    ],
)
def test_incomplete_or_empty_response_not_marked_success(upstream, payload):
    def handler(request):
        if request.url.path.endswith("/chat/completions"):
            return httpx.Response(
                400,
                json={
                    "error": {
                        "message": "This account requires the Responses protocol.",
                    }
                },
            )
        return httpx.Response(200, json=payload)

    upstream(handler)
    with pytest.raises(ServiceError) as exc:
        OpenAICompatibleClient(45).complete(site(), "demo", [{"role": "user", "content": "hi"}])
    assert exc.value.code == "invalid_responses_response"
