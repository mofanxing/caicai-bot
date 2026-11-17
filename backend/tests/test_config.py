import pytest
from pydantic import ValidationError

from app.core.config import Settings


@pytest.mark.parametrize("app_env", ["development", "test"])
def test_local_settings_accept_six_character_admin_token(app_env):
    settings = Settings(_env_file=None, app_env=app_env, admin_token="123456")
    assert settings.admin_token.get_secret_value() == "123456"


@pytest.mark.parametrize("app_env", ["development", "test", "production"])
@pytest.mark.parametrize("token", ["", "12345"])
def test_settings_reject_admin_tokens_shorter_than_six_characters(app_env, token):
    with pytest.raises(ValidationError):
        Settings(_env_file=None, app_env=app_env, admin_token=token)


@pytest.mark.parametrize("length", [6, 31])
def test_production_settings_reject_short_admin_token(length):
    with pytest.raises(ValidationError, match="at least 32 characters in production"):
        Settings(
            _env_file=None, app_env="production", admin_token="x" * length,
            mock_llm_enabled=False,
        )


def test_production_settings_accept_32_character_admin_token():
    settings = Settings(
        _env_file=None, app_env="production", admin_token="x" * 32,
        mock_llm_enabled=False,
    )
    assert len(settings.admin_token.get_secret_value()) == 32
