import os
import sys

# When packaged as a windowed (console=False) Windows binary, Python attaches no
# console. If the process is also launched without piped stdio (e.g. the user
# double-clicks the .exe, or it is spawned detached), sys.stdout/sys.stderr are
# None. uvicorn's logging setup calls sys.stderr.isatty() during startup and
# crashes with "NoneType has no attribute 'isatty'". Give it real streams; when
# the Electron app spawns us with pipes these are already set and untouched.
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w")  # noqa: SIM115
if sys.stderr is None:
    sys.stderr = open(os.devnull, "w")  # noqa: SIM115

import uvicorn  # noqa: E402

from gigaam_server import app  # noqa: E402


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
