#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.12"
# dependencies = ["fastapi", "uvicorn", "httpx"]
# ///
"""One host's real Surface store (dotfiles bin/es_dashboard_surfaces.py behind the real attention guard and operator
bootstrap), for the requested-deliverable Done tests. Env: DOTFILES_BIN (required), HOME (a temp dir: the store and
the published report live under it). Prints the listening port on its first line.

POST /__fixture/publish {id, title, summary} publishes (or republishes) a deliverable through the real publish(); only
the producer grant is stubbed, since lane ownership is not what these tests exercise. The same fields again are an
exact retry; a changed summary is a new revision."""
import os
import socket
import sys
from pathlib import Path

sys.path.insert(0, os.environ["DOTFILES_BIN"])
os.environ.setdefault("ES_ATTENTION_AUTH_FILE", str(Path.home() / "auth" / "key"))
os.environ.setdefault("EDITSPACES_ROOT", str(Path.home() / "es"))

import uvicorn  # noqa: E402
from fastapi import FastAPI, Request  # noqa: E402

import es_dashboard_attention as attention  # noqa: E402
import es_dashboard_surfaces as surfaces  # noqa: E402

surfaces.grant = lambda claims: {"key": "ses_fixture", "label": "Fixture lead", "lineage": ["ses_fixture"], "named": True}
PRODUCER = {"role": "producer", "session": "ses_fixture", "es": "opencode"}

sock = socket.socket()
sock.bind(("127.0.0.1", 0))
port = sock.getsockname()[1]
# Listen before printing the port, so an early connection queues instead of being reset while uvicorn starts.
sock.listen(128)
app = FastAPI()
guard, actor = attention.install_attention_routes(app, lambda: [], f"http://127.0.0.1:{port}")
surfaces.install_surface_routes(app, guard, actor, opencode_url="http://127.0.0.1:1", dashboard_url=f"http://127.0.0.1:{port}")


@app.post("/__fixture/publish")
async def publish(request: Request):
    payload = await request.json()
    root = Path(os.environ["EDITSPACES_ROOT"]) / "opencode" / payload["id"]
    root.mkdir(parents=True, exist_ok=True)
    (root / "index.html").write_text(f"<!doctype html><title>{payload['title']}</title><p id=marker>{payload['id']}</p>")
    record = surfaces.publish({"id": payload["id"], "title": payload["title"], "summary": payload["summary"], "path": str(root), "deliverable": True,
                               "requested_in": {"session": "ses_0asked0000000000000000", "directory": "/r", "title": "Asked here"}}, PRODUCER, set())
    return {"revision": record["revision"]}


print(port, flush=True)
uvicorn.Server(uvicorn.Config(app, log_level="warning")).run(sockets=[sock])
