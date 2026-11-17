from functools import lru_cache
from pathlib import Path
from typing import Literal

from pydantic import Field, SecretStr, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    app_env: Literal["development", "test", "production"] = "development"
    admin_token: SecretStr = Field(min_length=6)
    database_url: str = "sqlite:///./data/caicai.db"
    mock_llm_enabled: bool = False
    llm_timeout_seconds: float = Field(default=45, gt=0, le=180)
    provider_encryption_key: SecretStr = SecretStr("")
    provider_encryption_key_file: str = "./data/keys/provider.key"
    wechat_bridge_url: str = ""
    wechat_inbound_token: SecretStr = SecretStr("")
    wechat_outbound_token: SecretStr = SecretStr("")
    speech_data_dir: str = "./data/tts"
    local_tts_python: str = str(Path(__file__).resolve().parents[2] / ".tts-venv/bin/python")
    local_tts_model_dir: str = str(
        Path(__file__).resolve().parents[2] / "data/tts/models/VoxCPM2-4bit"
    )
    local_tts_timeout_seconds: float = Field(default=600, ge=10, le=1800)

    @model_validator(mode="after")
    def validate_runtime(self):
        if self.app_env == "production" and len(self.admin_token.get_secret_value()) < 32:
            raise ValueError("ADMIN_TOKEN must be at least 32 characters in production")
        if self.app_env == "production" and self.mock_llm_enabled:
            raise ValueError("MOCK_LLM_ENABLED must be false in production")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
