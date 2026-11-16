from typing import Protocol

import httpx

from app.core.config import Settings
from app.core.errors import ServiceError


class ChatChannel(Protocol):
    def send_text(self, account_id: str, peer_id: str, text: str, idempotency_key: str) -> None: ...


class PersonalWechatBridge:
    """自定义 HTTP 桥接契约；不是现成的微信登录或协议实现。"""

    def __init__(self, settings: Settings):
        self.settings = settings

    def send_text(self, account_id: str, peer_id: str, text: str, idempotency_key: str):
        token = self.settings.wechat_outbound_token.get_secret_value()
        if not self.settings.wechat_bridge_url or not token:
            raise ServiceError("wechat_not_configured", "个人微信桥接服务未配置", 503)
        try:
            with httpx.Client(timeout=20, follow_redirects=False) as client:
                response = client.post(
                    f"{self.settings.wechat_bridge_url.rstrip('/')}/messages/text",
                    headers={
                        "Authorization": f"Bearer {token}",
                        "Idempotency-Key": idempotency_key,
                    },
                    json={"account_id": account_id, "peer_id": peer_id, "text": text},
                )
                response.raise_for_status()
        except httpx.HTTPError as exc:
            raise ServiceError("wechat_send_failed", "微信桥接发送失败", 502) from exc
