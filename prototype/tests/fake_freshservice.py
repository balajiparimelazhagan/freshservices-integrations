import json
import re
from typing import Any, Dict, List, Optional, Tuple

import httpx

REQUIRED_ON_CREATE = ("subject", "description", "status", "priority")


class FakeTenant:
    """In-memory stand-in for one Freshservice account's /api/v2 ticket endpoints."""

    def __init__(self, first_id: int = 1):
        self.tickets: Dict[int, Dict[str, Any]] = {}
        self.notes: Dict[int, List[Dict[str, Any]]] = {}
        self.next_id = first_id
        self.queued_errors: List[Tuple[int, Dict[str, str]]] = []
        self.calls: List[Tuple[str, str]] = []

    def seed(self, **fields: Any) -> Dict[str, Any]:
        ticket = {"status": 2, "priority": 1, "tags": [], "description": "", **fields, "id": self.next_id}
        self.tickets[self.next_id] = ticket
        self.next_id += 1
        return ticket

    def fail_next(self, status: int, headers: Optional[Dict[str, str]] = None) -> None:
        self.queued_errors.append((status, headers or {}))

    def handle(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.replace("/api/v2", "", 1)
        self.calls.append((request.method, path))
        if "authorization" not in request.headers:
            return httpx.Response(401, json={"code": "access_denied"})
        if self.queued_errors:
            status, headers = self.queued_errors.pop(0)
            return httpx.Response(status, headers=headers, json={"code": "injected"})

        body = json.loads(request.content) if request.content else {}
        if request.method == "POST" and path == "/tickets":
            missing = [f for f in REQUIRED_ON_CREATE if f not in body]
            if "email" not in body and "requester_id" not in body:
                missing.append("email")
            if missing:
                return httpx.Response(
                    400,
                    json={
                        "description": "Validation failed",
                        "errors": [{"field": f, "message": "It should not be blank", "code": "missing_field"} for f in missing],
                    },
                )
            return httpx.Response(201, json={"ticket": self.seed(**body)})

        match = re.fullmatch(r"/tickets/(\d+)(/notes)?", path)
        if not match or int(match.group(1)) not in self.tickets:
            return httpx.Response(404, json={"code": "not_found"})
        ticket_id = int(match.group(1))

        if match.group(2) and request.method == "POST":
            self.notes.setdefault(ticket_id, []).append(body)
            return httpx.Response(201, json={"conversation": {"id": len(self.notes[ticket_id]), **body}})
        if request.method == "GET":
            ticket = dict(self.tickets[ticket_id])
            if "tags" not in request.url.params.get("include", ""):
                ticket.pop("tags", None)
            return httpx.Response(200, json={"ticket": ticket})
        if request.method == "PUT":
            if body.get("status") in (4, 5) and not body.get("resolution_notes"):
                return httpx.Response(
                    400,
                    json={
                        "description": "Validation failed",
                        "errors": [{"field": "business_rules", "message": "Business Rules Violated - Resolution Note is required", "code": "invalid_value"}],
                    },
                )
            self.tickets[ticket_id].update(body)
            return httpx.Response(200, json={"ticket": self.tickets[ticket_id]})
        return httpx.Response(405)


def transport_for(tenants: Dict[str, FakeTenant]) -> httpx.MockTransport:
    return httpx.MockTransport(lambda request: tenants[request.url.host].handle(request))
