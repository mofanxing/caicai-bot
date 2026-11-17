from datetime import datetime
from typing import Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    HttpUrl,
    SecretStr,
    field_validator,
    model_validator,
)

from app.core.network import safe_api_url


class ProviderKeyUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    api_key: SecretStr = Field(min_length=1, max_length=4096, exclude=True, repr=False)

    @field_validator("api_key")
    @classmethod
    def valid_api_key(cls, value: SecretStr):
        key = value.get_secret_value().strip()
        if not key or any(not (33 <= ord(character) <= 126) for character in key):
            raise ValueError("API Key 必须为非空的可打印 ASCII 字符，不能包含空白或换行")
        return SecretStr(key)


class ProviderCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=1, max_length=100)
    base_url: HttpUrl
    api_key_env: str | None = Field(default=None, pattern=r"^[A-Z][A-Z0-9_]{0,99}$")
    api_key: SecretStr | None = Field(
        default=None, min_length=1, max_length=4096, exclude=True, repr=False
    )

    @field_validator("api_key")
    @classmethod
    def valid_api_key(cls, value: SecretStr | None):
        if value is None:
            return None
        return ProviderKeyUpdate(api_key=value).api_key

    @model_validator(mode="after")
    def no_credentials_in_url(self):
        if (
            self.base_url.username
            or self.base_url.password
            or self.base_url.query
            or self.base_url.fragment
        ):
            raise ValueError("base_url must not contain credentials or query parameters")
        if bool(self.api_key) == bool(self.api_key_env):
            raise ValueError("请提供 API Key 或环境变量名，二者只能选择一种")
        if not safe_api_url(str(self.base_url)):
            raise ValueError("外部模型站点必须使用 HTTPS，仅本机测试可使用 HTTP")
        return self


class ProviderRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    base_url: str
    api_key_env: str
    has_api_key: bool
    key_source: Literal["encrypted", "environment", "missing"]


class ConversationCreate(BaseModel):
    channel: Literal["debug", "wechat_personal"] = "debug"
    account_id: str = Field(default="local", min_length=1, max_length=200)
    peer_id: str = Field(min_length=1, max_length=200)


class ConversationSettings(BaseModel):
    provider_id: str | None = None
    model_id: str | None = Field(default=None, max_length=200)
    reply_mode: Literal["text", "voice", "both"] = "text"
    voice_id: str | None = Field(default=None, max_length=200)
    voice_prompt: str = Field(default="", max_length=500)
    system_prompt: str = Field(default="你是菜菜，一个友善自然的聊天助手。", max_length=16000)

    @model_validator(mode="after")
    def check_provider_model_pair(self):
        if bool(self.provider_id) != bool(self.model_id):
            raise ValueError("provider_id and model_id must be configured together")
        if self.reply_mode != "text" and not self.voice_id:
            raise ValueError("语音回复需要先选择音色")
        return self


class ConversationRead(ConversationSettings):
    model_config = ConfigDict(from_attributes=True)
    id: str
    channel: str
    account_id: str
    peer_id: str


class IncomingMessage(BaseModel):
    external_id: str = Field(min_length=1, max_length=200)
    text: str = Field(min_length=1, max_length=16000)


class WechatIncoming(IncomingMessage):
    account_id: str = Field(min_length=1, max_length=200)
    peer_id: str = Field(min_length=1, max_length=200)


class MessageRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    external_id: str
    user_text: str
    assistant_text: str | None
    status: str
    speech_job_id: str | None = None
    speech_job_ids: list[str] = Field(default_factory=list)


class VoiceRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    name: str
    reference_text: str
    style_prompt: str
    duration_seconds: float
    created_at: datetime


class SpeechPreview(BaseModel):
    model_config = ConfigDict(extra="forbid")
    text: str = Field(min_length=1, max_length=600)
    style_prompt: str | None = Field(default=None, max_length=500)

    @field_validator("text")
    @classmethod
    def nonempty_text(cls, value):
        if not value.strip():
            raise ValueError("请填写要合成的文字")
        return value.strip()


class SpeechJobRead(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: str
    voice_id: str
    message_id: str | None
    text: str
    style_prompt: str
    status: str
    error: str | None
    duration_seconds: float | None
    generation_seconds: float | None
    created_at: datetime
