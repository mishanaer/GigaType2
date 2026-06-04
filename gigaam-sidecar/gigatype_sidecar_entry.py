import os

import uvicorn

from gigaam_server import app


def _port_from_env() -> int:
    raw_port = os.getenv("GIGATYPE_PORT", "8765")
    try:
        port = int(raw_port)
    except ValueError as exc:
        raise SystemExit(f"Invalid GIGATYPE_PORT: {raw_port}") from exc

    if port < 1 or port > 65535:
        raise SystemExit(f"Invalid GIGATYPE_PORT: {raw_port}")
    return port


def _host_from_env() -> str:
    host = os.getenv("GIGATYPE_HOST", "127.0.0.1")
    if host != "127.0.0.1":
        raise SystemExit("GIGATYPE_HOST must be 127.0.0.1")
    return host


if __name__ == "__main__":
    uvicorn.run(
        app,
        host=_host_from_env(),
        port=_port_from_env(),
        log_level=os.getenv("GIGATYPE_LOG_LEVEL", "info"),
    )
