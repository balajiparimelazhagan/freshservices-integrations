import hmac
import html
import logging
import re
import threading
from typing import Any, Dict, Optional, Union

import httpx
from fastapi import FastAPI, Header, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel

from config import Config, load_config
from fs_client import FreshserviceClient, FreshserviceError
from store import LinkStore

log = logging.getLogger("bridge")

STATUS_NAMES = {2: "Open", 3: "Pending", 4: "Resolved", 5: "Closed"}
# Workflow Automator placeholders render ids like "INC-12" or "#SR-12"; the numeric part is the API id.
TRAILING_DIGITS = re.compile(r"(\d+)\s*$")


class WebhookPayload(BaseModel):
    ticket_id: Union[int, str]


def parse_ticket_id(raw: Union[int, str]) -> int:
    match = TRAILING_DIGITS.search(str(raw))
    if not match:
        raise HTTPException(status_code=422, detail=f"Unparseable ticket_id: {raw!r}")
    return int(match.group(1))


def create_app(
    config: Config,
    transport: Optional[httpx.BaseTransport] = None,
    max_retry_wait: float = 30.0,
) -> FastAPI:
    source = FreshserviceClient(
        config.source.name, config.source.domain, config.source.api_key, transport, max_retry_wait
    )
    target = FreshserviceClient(
        config.target.name, config.target.domain, config.target.api_key, transport, max_retry_wait
    )
    store = LinkStore(config.db_path)
    # Serialises webhook handling so two near-simultaneous events for one ticket can't both escalate it.
    handling = threading.Lock()

    def should_escalate(ticket: Dict[str, Any]) -> bool:
        return ticket.get("priority", 0) >= config.escalate_priority or config.escalate_tag in (
            ticket.get("tags") or []
        )

    def escalate(source_id: int) -> Dict[str, Any]:
        existing = store.by_source(source_id)
        if existing:
            return {"action": "ignored", "reason": "already escalated", "target_id": existing.target_id}

        ticket = source.get_ticket(source_id)
        if not should_escalate(ticket):
            return {"action": "ignored", "reason": "does not match escalation rule"}

        fields: Dict[str, Any] = {
            "subject": f"[{source.name} #{source_id}] {ticket['subject']}",
            "description": (
                f'<p>Escalated from <a href="{source.ticket_url(source_id)}">{source.name} #{source_id}</a>.</p>'
                f"{ticket.get('description') or html.escape(ticket.get('description_text') or '')}"
            ),
            "email": config.target_requester_email,
            "priority": ticket["priority"],
            "status": 2,
            "tags": ["bridge", f"from-{source.name}"],
        }
        # Accounts with a priority matrix derive priority from urgency x impact and ignore `priority`.
        for field in ("urgency", "impact"):
            if ticket.get(field):
                fields[field] = ticket[field]
        if config.target_group_id is not None:
            fields["group_id"] = config.target_group_id
        if config.target_workspace_id is not None:
            fields["workspace_id"] = config.target_workspace_id
        if config.target_custom_fields:
            fields["custom_fields"] = dict(config.target_custom_fields)

        created = target.create_ticket(fields)
        # Link before the back-reference note so a failed note can't cause a duplicate escalation on retry.
        store.link(source_id, created["id"], created["status"])
        source.add_note(
            source_id,
            f'Escalated to {target.name} ticket <a href="{target.ticket_url(created["id"])}">#{created["id"]}</a>.',
        )
        log.info("escalated %s#%s -> %s#%s", source.name, source_id, target.name, created["id"])
        return {"action": "escalated", "source_id": source_id, "target_id": created["id"]}

    def sync_back(target_id: int) -> Dict[str, Any]:
        link = store.by_target(target_id)
        if not link:
            return {"action": "ignored", "reason": "not a bridged ticket"}

        ticket = target.get_ticket(target_id)
        status = ticket["status"]
        # Also the loop guard: our own writes echo back as webhooks with an unchanged status.
        if status == link.last_status:
            return {"action": "ignored", "reason": "status unchanged"}

        update: Dict[str, Any] = {"status": status}
        # Both accounts have a business rule rejecting Resolved/Closed without a resolution note.
        if status in (4, 5):
            update["resolution_notes"] = (
                ticket.get("resolution_notes") or f"Resolved in {target.name} ticket #{target_id}."
            )
        source.update_ticket(link.source_id, update)
        store.set_status(link.source_id, status)
        source.add_note(
            link.source_id,
            f"{target.name} #{target_id} is now {STATUS_NAMES.get(status, f'status {status}')}.",
        )
        log.info("synced %s#%s status %s -> %s#%s", target.name, target_id, status, source.name, link.source_id)
        return {"action": "synced", "source_id": link.source_id, "target_id": target_id, "status": status}

    handlers = {
        config.source.name: (config.source.webhook_secret, escalate),
        config.target.name: (config.target.webhook_secret, sync_back),
    }

    app = FastAPI(title="Freshservice bridge")

    @app.exception_handler(FreshserviceError)
    def upstream_error(_: Request, exc: FreshserviceError) -> JSONResponse:
        log.warning("upstream error: %s", exc)
        return JSONResponse(
            status_code=502,
            content={"error": "upstream", "tenant": exc.tenant, "status": exc.status, "detail": exc.detail},
        )

    @app.get("/health")
    def health() -> Dict[str, str]:
        return {"status": "ok"}

    @app.post("/webhook/{tenant}")
    def webhook(
        tenant: str,
        payload: WebhookPayload,
        x_bridge_secret: Optional[str] = Header(default=None),
    ) -> Dict[str, Any]:
        if tenant not in handlers:
            raise HTTPException(status_code=404, detail=f"Unknown tenant {tenant!r}")
        secret, handler = handlers[tenant]
        if not x_bridge_secret or not hmac.compare_digest(x_bridge_secret, secret):
            raise HTTPException(status_code=401, detail="Bad or missing X-Bridge-Secret")
        ticket_id = parse_ticket_id(payload.ticket_id)
        with handling:
            return handler(ticket_id)

    return app


def main() -> FastAPI:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
    return create_app(load_config())
