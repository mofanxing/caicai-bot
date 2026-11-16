import os
import stat
from pathlib import Path
from threading import Lock

from cryptography.fernet import Fernet, InvalidToken

from app.core.config import Settings
from app.core.errors import ServiceError


class SecretVault:
    """Authenticated encryption, with the master key outside the database."""

    def __init__(self, settings: Settings):
        self.settings = settings
        self._fernet: Fernet | None = None
        self._lock = Lock()

    def _cipher(self) -> Fernet:
        with self._lock:
            if self._fernet is not None:
                return self._fernet
            configured = self.settings.provider_encryption_key.get_secret_value()
            try:
                if configured:
                    key = configured.encode("ascii")
                else:
                    if self.settings.app_env == "production":
                        raise ServiceError(
                            "encryption_not_configured",
                            "生产环境需先配置 PROVIDER_ENCRYPTION_KEY，才能保存或使用页面密钥",
                            503,
                        )
                    path = Path(self.settings.provider_encryption_key_file)
                    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
                    try:
                        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
                    except FileExistsError:
                        pass
                    else:
                        with os.fdopen(descriptor, "wb") as handle:
                            handle.write(Fernet.generate_key())
                            handle.flush()
                            os.fsync(handle.fileno())
                    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)
                    with os.fdopen(os.open(path, flags), "rb") as handle:
                        metadata = os.fstat(handle.fileno())
                        if not stat.S_ISREG(metadata.st_mode):
                            raise ValueError("Master key must be a regular file")
                        if os.name == "posix" and (
                            metadata.st_uid != os.getuid() or stat.S_IMODE(metadata.st_mode) & 0o077
                        ):
                            raise ValueError("Unsafe master key file permissions")
                        key = handle.read(256).strip()
                self._fernet = Fernet(key)
                return self._fernet
            except (OSError, ValueError, UnicodeError) as exc:
                raise ServiceError(
                    "encryption_unavailable",
                    "无法读取安全的加密主密钥，请检查后端密钥配置及文件权限",
                    503,
                ) from exc

    def encrypt(self, plaintext: str) -> str:
        return self._cipher().encrypt(plaintext.encode("utf-8")).decode("ascii")

    def decrypt(self, ciphertext: str) -> str:
        try:
            return self._cipher().decrypt(ciphertext.encode("ascii")).decode("utf-8")
        except (InvalidToken, UnicodeError, ValueError) as exc:
            raise ServiceError(
                "secret_decryption_failed",
                "站点密钥无法解密，请恢复原加密主密钥或在页面重新配置 API Key",
                503,
            ) from exc
