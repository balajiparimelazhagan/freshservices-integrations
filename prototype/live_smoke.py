"""End-to-end run against the real yora and fwddeploy accounts.

Creates one real urgent ticket in yora, escalates it through the bridge (in-process, no tunnel
needed), resolves the copy in fwddeploy and checks the status syncs back. The tickets are left
resolved and tagged `bridge`. Usage: set -a && source ../.freshservice.env && set +a && python3 live_smoke.py
"""
import os
import secrets
import sys
import tempfile

from fastapi.testclient import TestClient

from app import create_app
from config import load_config
from fs_client import FreshserviceClient

os.environ.setdefault("BRIDGE_SECRET_YORA", secrets.token_hex(16))
os.environ.setdefault("BRIDGE_SECRET_FWD", secrets.token_hex(16))
os.environ["BRIDGE_DB_PATH"] = os.path.join(tempfile.mkdtemp(), "smoke.db")

config = load_config()
client = TestClient(create_app(config))
yora_api = FreshserviceClient(config.source.name, config.source.domain, config.source.api_key)
fwd_api = FreshserviceClient(config.target.name, config.target.domain, config.target.api_key)
yora_headers = {"X-Bridge-Secret": config.source.webhook_secret}
fwd_headers = {"X-Bridge-Secret": config.target.webhook_secret}


def step(label: str, response_json: dict, expected_action: str) -> dict:
    ok = response_json.get("action") == expected_action
    print(f"{'PASS' if ok else 'FAIL'}  {label}: {response_json}")
    if not ok:
        sys.exit(1)
    return response_json


def webhook(tenant: str, ticket_id: int) -> dict:
    headers = yora_headers if tenant == config.source.name else fwd_headers
    response = client.post(f"/webhook/{tenant}", json={"ticket_id": ticket_id}, headers=headers)
    if response.status_code != 200:
        print(f"FAIL  webhook/{tenant} HTTP {response.status_code}: {response.text}")
        sys.exit(1)
    return response.json()


source_ticket = yora_api.create_ticket(
    {
        "subject": "[bridge-test] Urgent: VPN down",
        "description": "<p>Automated bridge smoke test. Safe to ignore.</p>",
        "email": config.target_requester_email,
        "priority": 4,
        # yora uses a priority matrix, so Urgent comes from High urgency x High impact.
        "urgency": 3,
        "impact": 3,
        "status": 2,
        "tags": ["bridge-test"],
    }
)
source_id = source_ticket["id"]
print(f"      created yora ticket {yora_api.ticket_url(source_id)}")

target_id = step("escalate yora -> fwddeploy", webhook("yora", source_id), "escalated")["target_id"]
print(f"      fwddeploy copy {fwd_api.ticket_url(target_id)}")
step("duplicate yora webhook", webhook("yora", source_id), "ignored")
step("fwddeploy 'created' echo", webhook("fwddeploy", target_id), "ignored")

fwd_api.update_ticket(target_id, {"status": 4, "resolution_notes": "Bridge smoke test: VPN restored."})
step("fwddeploy resolved -> yora", webhook("fwddeploy", target_id), "synced")
step("yora 'updated' echo", webhook("yora", source_id), "ignored")

final_status = yora_api.get_ticket(source_id)["status"]
print(f"{'PASS' if final_status == 4 else 'FAIL'}  yora ticket status is now {final_status} (expected 4 Resolved)")
sys.exit(0 if final_status == 4 else 1)
