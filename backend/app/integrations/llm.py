import json
import logging
import os
from urllib.parse import urlsplit

import httpx

from app.core.errors import ServiceError
from app.core.network import safe_api_url
from app.core.secrets import SecretVault
from app.models import Provider

logger = logging.getLogger(__name__)


class _ResponsesProtocolRequired(Exception):
    """Only an explicit protocol rejection permits switching the request format."""


def requires_responses(response: httpx.Response) -> bool:
    try:
        error = response.json().get("error", {})
        message = error.get("message", "") if isinstance(error, dict) else ""
        if not isinstance(message, str):
            return False
        message = message.casefold()
        return any(
            hint in message
            for hint in (
                "requires the responses protocol",
                "requires responses protocol",
                "only supports the responses api",
                "only supports responses api",
            )
        )
    except (ValueError, AttributeError):
        return False


def upstream_http_error(status: int) -> ServiceError:
    if status in (401, 403):
        return ServiceError(
            "llm_auth_error",
            f"模型服务拒绝访问（HTTP {status}），请检查 API Key、模型权限和站点访问限制",
            502,
        )
    if status == 402:
        return ServiceError("llm_quota_error", "模型服务额度不足（HTTP 402），请检查站点余额", 502)
    if status == 404:
        return ServiceError(
            "llm_not_found",
            "模型接口或模型不存在（HTTP 404），请检查站点 Base URL、版本前缀和模型 ID",
            502,
        )
    if status == 429:
        return ServiceError(
            "llm_rate_limited",
            "模型服务限流或配额已用尽（HTTP 429），请稍后重试并检查站点额度",
            502,
        )
    if status in (400, 405, 413, 422):
        return ServiceError(
            "llm_request_rejected",
            f"模型服务不接受当前请求（HTTP {status}），请检查模型 ID、上下文长度和接口兼容性",
            502,
        )
    if 300 <= status < 400:
        return ServiceError(
            "llm_redirect",
            f"模型接口要求重定向（HTTP {status}），请填写最终 API 地址；为保护密钥不自动跳转",
            502,
        )
    return ServiceError(
        "llm_upstream_error",
        f"模型站点返回错误（HTTP {status}），请稍后重试或联系站点确认服务状态",
        502,
    )


class OpenAICompatibleClient:
    def __init__(self, timeout: float, vault: SecretVault | None = None):
        self.timeout = timeout
        self.vault = vault
        self._responses_models: set[tuple[str, str, str]] = set()

    def forget_provider(self, provider_id: str):
        self._responses_models = {key for key in self._responses_models if key[0] != provider_id}

    def _credentials(self, provider: Provider):
        if not safe_api_url(provider.base_url):
            raise ServiceError("unsafe_provider_url", "为保护密钥，外部模型站点必须使用 HTTPS", 409)
        if provider.api_key_encrypted:
            if self.vault is None:
                raise ServiceError("encryption_not_configured", "加密密钥服务未配置", 503)
            key = self.vault.decrypt(provider.api_key_encrypted)
        else:
            key = os.environ.get(provider.api_key_env or "", "")
        if not key:
            raise ServiceError("provider_key_missing", "中转站 API Key 未配置", 409)
        return {"Authorization": f"Bearer {key}"}

    def _request(self, provider: Provider, method: str, path: str, **kwargs):
        headers = self._credentials(provider)
        try:
            with httpx.Client(timeout=self.timeout, follow_redirects=False) as client:
                response = client.request(
                    method,
                    f"{provider.base_url.rstrip('/')}/{path}",
                    headers=headers,
                    **kwargs,
                )
                response.raise_for_status()
                return response.json()
        except httpx.HTTPStatusError as exc:
            if (
                path == "chat/completions"
                and exc.response.status_code in (400, 422)
                and requires_responses(exc.response)
            ):
                logger.info("Model explicitly requires Responses protocol; switching adapter")
                raise _ResponsesProtocolRequired() from exc
            logger.warning(
                "LLM upstream HTTP failure: status=%s operation=%s", exc.response.status_code, path
            )
            raise upstream_http_error(exc.response.status_code) from exc
        except httpx.TimeoutException as exc:
            logger.warning("LLM upstream timeout: operation=%s kind=%s", path, type(exc).__name__)
            raise ServiceError(
                "llm_timeout",
                f"模型服务等待超时（单次网络等待上限 {self.timeout:g} 秒），请稍后重试或切换模型",
                504,
            ) from exc
        except httpx.RequestError as exc:
            logger.warning(
                "LLM upstream connection failure: operation=%s kind=%s", path, type(exc).__name__
            )
            raise ServiceError(
                "llm_connection_error",
                "无法连接模型服务，请检查站点地址、DNS、代理或 TLS 证书连接",
                502,
            ) from exc
        except ValueError as exc:
            raise ServiceError(
                "llm_invalid_response",
                "模型接口未返回有效 JSON，可能填写成网页地址，请检查 Base URL 和接口版本前缀",
                502,
            ) from exc

    def list_models(self, provider: Provider) -> list[str]:
        payload = self._request(provider, "GET", "models")
        try:
            return sorted({item["id"] for item in payload["data"] if isinstance(item["id"], str)})
        except (KeyError, TypeError) as exc:
            raise ServiceError("invalid_models_response", "模型列表响应格式不兼容", 502) from exc

    def stream(self, provider: Provider, model: str, messages: list[dict]):
        cache_key = (provider.id, provider.base_url, model)
        responses = cache_key in self._responses_models
        try:
            yield from self._stream(provider, model, messages, responses)
        except _ResponsesProtocolRequired:
            self._responses_models.add(cache_key)
            yield from self._stream(provider, model, messages, True)

    def _stream(self, provider, model, messages, responses):
        headers = self._credentials(provider)
        path = "chat/completions"
        body = {"model": model, "messages": messages, "stream": True}
        if responses:
            path = "responses" if urlsplit(provider.base_url).path.strip("/") else "v1/responses"
            body = {
                "model": model,
                "stream": True,
                "store": False,
                "input": [m for m in messages if m["role"] != "system"],
            }
            instructions = "\n".join(m["content"] for m in messages if m["role"] == "system")
            if instructions:
                body["instructions"] = instructions
        received, finished = False, False
        try:
            with httpx.Client(timeout=self.timeout, follow_redirects=False) as client:
                with client.stream(
                    "POST",
                    f"{provider.base_url.rstrip('/')}/{path}",
                    headers=headers,
                    json=body,
                ) as response:
                    if not response.is_success:
                        response.read()
                        if (
                            not responses
                            and response.status_code in (400, 422)
                            and requires_responses(response)
                        ):
                            raise _ResponsesProtocolRequired()
                        raise upstream_http_error(response.status_code)
                    # Some compatible gateways return ordinary JSON even for stream=True.
                    if "application/json" in response.headers.get("content-type", ""):
                        payload = json.loads(response.read())
                        if responses:
                            if payload.get("status") not in (None, "completed"):
                                raise ValueError("Incomplete response")
                            content = "".join(
                                part.get("text", "")
                                for item in payload.get("output", [])
                                if item.get("type") == "message"
                                for part in item.get("content", [])
                                if part.get("type") == "output_text"
                            )
                        else:
                            content = payload["choices"][0]["message"]["content"]
                        if not isinstance(content, str) or not content.strip():
                            raise ValueError("Empty response")
                        yield content
                        return
                    data = []
                    for line in response.iter_lines():
                        if line.startswith("data:"):
                            data.append(line[5:].lstrip())
                            continue
                        if line or not data:
                            continue
                        raw, data = "\n".join(data), []
                        if raw == "[DONE]":
                            finished = True
                            break
                        payload = json.loads(raw)
                        if payload.get("error") or payload.get("type") in (
                            "error",
                            "response.failed",
                            "response.incomplete",
                        ):
                            raise ValueError("Upstream stream failed")
                        content = None
                        if responses:
                            if payload.get("type") == "response.output_text.delta":
                                content = payload.get("delta")
                            if payload.get("type") == "response.completed":
                                finished = True
                        else:
                            for choice in payload.get("choices", []):
                                if choice.get("index", 0) != 0:
                                    continue
                                content = choice.get("delta", {}).get("content")
                                reason = choice.get("finish_reason")
                                if reason is not None:
                                    if reason != "stop":
                                        raise ValueError("Incomplete chat completion")
                                    finished = True
                        if isinstance(content, str) and content:
                            received = True
                            yield content
                    if not received or not finished:
                        raise ValueError("Interrupted or empty stream")
        except httpx.TimeoutException as exc:
            raise ServiceError("llm_timeout", "模型流式回复超时，已保留收到的文字", 504) from exc
        except httpx.RequestError as exc:
            raise ServiceError(
                "llm_connection_error", "模型连接中断，请检查网络或站点状态", 502
            ) from exc
        except (ValueError, KeyError, IndexError, TypeError, AttributeError) as exc:
            raise ServiceError(
                "llm_invalid_stream", "模型未返回完整的流式回答，请检查记录后重试", 502
            ) from exc

    def complete(self, provider: Provider, model: str, messages: list[dict]) -> str:
        cache_key = (provider.id, provider.base_url, model)
        if cache_key in self._responses_models:
            return self._complete_responses(provider, model, messages)
        try:
            payload = self._request(
                provider,
                "POST",
                "chat/completions",
                json={"model": model, "messages": messages, "stream": False},
            )
        except _ResponsesProtocolRequired:
            text = self._complete_responses(provider, model, messages)
            self._responses_models.add(cache_key)
            return text
        try:
            content = payload["choices"][0]["message"]["content"]
            if not isinstance(content, str) or not content.strip():
                raise ValueError("Expected non-empty text")
            return content
        except (KeyError, IndexError, TypeError, ValueError) as exc:
            raise ServiceError("invalid_chat_response", "模型未返回有效的文字回答", 502) from exc

    def _complete_responses(self, provider: Provider, model: str, messages: list[dict]) -> str:
        # Respect custom API prefixes. For a bare origin use the standard /v1/responses path.
        path = "responses" if urlsplit(provider.base_url).path.strip("/") else "v1/responses"
        body = {
            "model": model,
            "input": [message for message in messages if message["role"] != "system"],
            "stream": False,
            "store": False,
        }
        instructions = chr(10).join(
            message["content"] for message in messages if message["role"] == "system"
        )
        if instructions:
            body["instructions"] = instructions
        payload = self._request(provider, "POST", path, json=body)
        try:
            if payload.get("status") not in (None, "completed") or payload.get("error"):
                raise ValueError("Response did not complete")
            parts = []
            for item in payload["output"]:
                if item.get("type") != "message" or item.get("role") != "assistant":
                    continue
                if item.get("status") not in (None, "completed"):
                    raise ValueError("Assistant message did not complete")
                for content in item.get("content", []):
                    if content.get("type") == "output_text" and isinstance(
                        content.get("text"), str
                    ):
                        parts.append(content["text"])
            text = "".join(parts)
            if not text.strip():
                raise ValueError("Expected non-empty output text")
            return text
        except (KeyError, TypeError, ValueError, AttributeError) as exc:
            raise ServiceError(
                "invalid_responses_response",
                "Responses 接口未返回完整的文字回答，请检查模型是否完成生成",
                502,
            ) from exc
