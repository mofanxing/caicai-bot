import ipaddress
from urllib.parse import urlsplit


def safe_api_url(value: str) -> bool:
    try:
        parsed = urlsplit(value)
        if (
            not parsed.hostname
            or parsed.username
            or parsed.password
            or parsed.query
            or parsed.fragment
        ):
            return False
        if parsed.scheme == "https":
            return True
        if parsed.scheme != "http":
            return False
        if parsed.hostname == "localhost":
            return True
        return ipaddress.ip_address(parsed.hostname).is_loopback
    except ValueError:
        return False
