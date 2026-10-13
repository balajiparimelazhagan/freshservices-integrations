import time
from typing import Any, Dict, Optional

import httpx


class FreshserviceError(Exception):
    def __init__(self, tenant: str, status: int, detail: str):
        super().__init__(f"{tenant}: HTTP {status}: {detail}")
        self.tenant = tenant
        self.status = status
        self.detail = detail


class FreshserviceClient:
    def __init__(
        self,
        name: str,
        domain: str,
        api_key: str,
        transport: Optional[httpx.BaseTransport] = None,
        max_retry_wait: float = 30.0,
    ):
        self.name = name
        self.domain = domain
        self.max_retry_wait = max_retry_wait
        self._http = httpx.Client(
            base_url=f"https://{domain}/api/v2",
            auth=(api_key, "X"),
            timeout=15.0,
            transport=transport,
        )

    def ticket_url(self, ticket_id: int) -> str:
        return f"https://{self.domain}/a/tickets/{ticket_id}"

    def _request(self, method: str, path: str, json: Optional[Dict[str, Any]] = None) -> Dict[str, Any]:
        for attempt in range(2):
            try:
                response = self._http.request(method, path, json=json)
            except httpx.HTTPError as exc:
                raise FreshserviceError(self.name, 0, type(exc).__name__) from exc
            if response.status_code == 429 and attempt == 0:
                wait = float(response.headers.get("Retry-After", "1"))
                time.sleep(min(wait, self.max_retry_wait))
                continue
            break
        if response.status_code >= 400:
            raise FreshserviceError(self.name, response.status_code, response.text[:500])
        return response.json() if response.content else {}

    def get_ticket(self, ticket_id: int) -> Dict[str, Any]:
        return self._request("GET", f"/tickets/{ticket_id}?include=tags")["ticket"]

    def create_ticket(self, fields: Dict[str, Any]) -> Dict[str, Any]:
        return self._request("POST", "/tickets", fields)["ticket"]

    def update_ticket(self, ticket_id: int, fields: Dict[str, Any]) -> Dict[str, Any]:
        return self._request("PUT", f"/tickets/{ticket_id}", fields)["ticket"]

    def add_note(self, ticket_id: int, body: str, private: bool = True) -> None:
        self._request("POST", f"/tickets/{ticket_id}/notes", {"body": body, "private": private})
