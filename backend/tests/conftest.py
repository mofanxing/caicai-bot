import pytest
from cryptography.fernet import Fernet
from fastapi.testclient import TestClient

from app.core.config import Settings
from app.main import create_app

TOKEN = "test-admin-token-at-least-32-characters"


@pytest.fixture
def client(tmp_path):
    settings = Settings(
        _env_file=None,
        app_env="test",
        admin_token=TOKEN,
        database_url=f"sqlite:///{tmp_path / 'test.db'}",
        mock_llm_enabled=True,
        wechat_bridge_url="http://bridge.test",
        wechat_inbound_token="test-inbound",
        wechat_outbound_token="test-outbound",
        provider_encryption_key=Fernet.generate_key().decode(),
    )
    with TestClient(create_app(settings)) as test_client:
        yield test_client
