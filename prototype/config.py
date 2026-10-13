import json
import os
from dataclasses import dataclass, field
from typing import Any, Dict, Optional


@dataclass(frozen=True)
class Tenant:
    name: str
    domain: str
    api_key: str
    webhook_secret: str


@dataclass(frozen=True)
class Config:
    source: Tenant
    target: Tenant
    # Tickets are raised in the target as this requester, so the target's
    # notifications go to the integration mailbox rather than to yora's end users.
    target_requester_email: str
    escalate_priority: int = 4
    escalate_tag: str = "escalate"
    target_group_id: Optional[int] = None
    target_workspace_id: Optional[int] = None
    # Account-specific required fields for created tickets, e.g. fwddeploy's msf_multi_agent_groups.
    target_custom_fields: Dict[str, Any] = field(default_factory=dict)
    db_path: str = "bridge.db"


def _require(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required environment variable {name}")
    return value


def _optional_int(name: str) -> Optional[int]:
    value = os.environ.get(name, "").strip()
    return int(value) if value else None


def load_config() -> Config:
    return Config(
        source=Tenant(
            name="yora",
            domain=os.environ.get("FS_YORA_DOMAIN", "yora.freshservice.com"),
            api_key=_require("FS_YORA_KEY"),
            webhook_secret=_require("BRIDGE_SECRET_YORA"),
        ),
        target=Tenant(
            name="fwddeploy",
            domain=os.environ.get("FS_FWD_DOMAIN", "fwddeployhelpdesk.freshservice.com"),
            api_key=_require("FS_FWD_KEY"),
            webhook_secret=_require("BRIDGE_SECRET_FWD"),
        ),
        target_requester_email=_require("BRIDGE_REQUESTER_EMAIL"),
        escalate_priority=int(os.environ.get("BRIDGE_ESCALATE_PRIORITY", "4")),
        escalate_tag=os.environ.get("BRIDGE_ESCALATE_TAG", "escalate"),
        target_group_id=_optional_int("BRIDGE_TARGET_GROUP_ID"),
        target_workspace_id=_optional_int("BRIDGE_TARGET_WORKSPACE_ID"),
        target_custom_fields=json.loads(os.environ.get("BRIDGE_TARGET_CUSTOM_FIELDS") or "{}"),
        db_path=os.environ.get("BRIDGE_DB_PATH", "bridge.db"),
    )
