#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["fastapi", "uvicorn"]
# ///
"""One host's real pin store (dotfiles bin/es_pins.py behind the real attention guard and operator bootstrap), for
pins-sync tests. Env: DOTFILES_BIN (required), HOME (a temp dir: the store lives under it),
ES_DASHBOARD_PROFILE. Prints the listening port on its first line."""
import os
import socket
import sys
from pathlib import Path

sys.path.insert(0, os.environ["DOTFILES_BIN"])
os.environ.setdefault("ES_ATTENTION_AUTH_FILE", str(Path.home() / "auth" / "key"))
os.environ.setdefault("EDITSPACES_ROOT", str(Path.home() / "es"))

import uvicorn  # noqa: E402
from fastapi import FastAPI  # noqa: E402

import es_dashboard_attention as attention  # noqa: E402
import es_pins as pins  # noqa: E402

sock = socket.socket()
sock.bind(("127.0.0.1", 0))
port = sock.getsockname()[1]
app = FastAPI()
guard, actor = attention.install_attention_routes(app, lambda: [], f"http://127.0.0.1:{port}")
pins.install_pins_routes(app, guard, actor)
print(port, flush=True)
uvicorn.Server(uvicorn.Config(app, log_level="warning")).run(sockets=[sock])
