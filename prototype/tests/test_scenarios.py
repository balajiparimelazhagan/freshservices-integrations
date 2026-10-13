import unittest

from fastapi.testclient import TestClient

from app import create_app
from config import Config, Tenant
from tests.fake_freshservice import FakeTenant, transport_for

YORA_HOST = "yora.test.freshservice.com"
FWD_HOST = "fwd.test.freshservice.com"
YORA = {"X-Bridge-Secret": "yora-secret"}
FWD = {"X-Bridge-Secret": "fwd-secret"}


class BridgeScenarios(unittest.TestCase):
    def setUp(self) -> None:
        self.yora = FakeTenant(first_id=100)
        self.fwd = FakeTenant(first_id=500)
        config = Config(
            source=Tenant("yora", YORA_HOST, "yora-key", "yora-secret"),
            target=Tenant("fwddeploy", FWD_HOST, "fwd-key", "fwd-secret"),
            target_requester_email="bridge@example.com",
            db_path=":memory:",
        )
        app = create_app(config, transport_for({YORA_HOST: self.yora, FWD_HOST: self.fwd}), max_retry_wait=0)
        self.client = TestClient(app)

    def escalate_urgent(self) -> int:
        ticket = self.yora.seed(subject="VPN down for Chennai office", priority=4, description="<p>All users</p>")
        response = self.client.post("/webhook/yora", json={"ticket_id": f"INC-{ticket['id']}"}, headers=YORA)
        self.assertEqual(response.status_code, 200, response.text)
        return response.json()["target_id"]

    def test_urgent_ticket_is_escalated_with_back_reference(self) -> None:
        target_id = self.escalate_urgent()

        created = self.fwd.tickets[target_id]
        self.assertEqual(created["subject"], "[yora #100] VPN down for Chennai office")
        self.assertEqual(created["priority"], 4)
        self.assertEqual(created["email"], "bridge@example.com")
        self.assertIn("https://yora.test.freshservice.com/a/tickets/100", created["description"])
        self.assertIn("<p>All users</p>", created["description"])
        [note] = self.yora.notes[100]
        self.assertTrue(note["private"])
        self.assertIn(f"/a/tickets/{target_id}", note["body"])

    def test_urgency_and_impact_are_carried_for_priority_matrix_accounts(self) -> None:
        ticket = self.yora.seed(subject="Matrix", priority=4, urgency=3, impact=3)
        target_id = self.client.post("/webhook/yora", json={"ticket_id": ticket["id"]}, headers=YORA).json()["target_id"]
        self.assertEqual((self.fwd.tickets[target_id]["urgency"], self.fwd.tickets[target_id]["impact"]), (3, 3))

    def test_configured_group_and_custom_fields_are_sent(self) -> None:
        config = Config(
            source=Tenant("yora", YORA_HOST, "yora-key", "yora-secret"),
            target=Tenant("fwddeploy", FWD_HOST, "fwd-key", "fwd-secret"),
            target_requester_email="bridge@example.com",
            target_group_id=42,
            target_custom_fields={"msf_multi_agent_groups": [42]},
            db_path=":memory:",
        )
        client = TestClient(create_app(config, transport_for({YORA_HOST: self.yora, FWD_HOST: self.fwd})))
        ticket = self.yora.seed(subject="Needs team", priority=4)

        target_id = client.post("/webhook/yora", json={"ticket_id": ticket["id"]}, headers=YORA).json()["target_id"]

        self.assertEqual(self.fwd.tickets[target_id]["group_id"], 42)
        self.assertEqual(self.fwd.tickets[target_id]["custom_fields"], {"msf_multi_agent_groups": [42]})

    def test_escalate_tag_also_triggers(self) -> None:
        ticket = self.yora.seed(subject="Needs vendor", priority=2, tags=["escalate"])
        response = self.client.post("/webhook/yora", json={"ticket_id": ticket["id"]}, headers=YORA)
        self.assertEqual(response.json()["action"], "escalated")

    def test_non_urgent_ticket_is_ignored(self) -> None:
        ticket = self.yora.seed(subject="Printer toner", priority=2)
        response = self.client.post("/webhook/yora", json={"ticket_id": ticket["id"]}, headers=YORA)
        self.assertEqual(response.json()["action"], "ignored")
        self.assertEqual(self.fwd.tickets, {})

    def test_duplicate_webhook_does_not_create_second_ticket(self) -> None:
        target_id = self.escalate_urgent()
        again = self.client.post("/webhook/yora", json={"ticket_id": 100}, headers=YORA).json()
        self.assertEqual(again, {"action": "ignored", "reason": "already escalated", "target_id": target_id})
        self.assertEqual(len(self.fwd.tickets), 1)

    def test_status_change_in_target_syncs_back(self) -> None:
        target_id = self.escalate_urgent()
        self.fwd.tickets[target_id].update(status=4, resolution_notes="VPN restored")

        response = self.client.post("/webhook/fwddeploy", json={"ticket_id": target_id}, headers=FWD).json()

        self.assertEqual(response["action"], "synced")
        self.assertEqual(self.yora.tickets[100]["status"], 4)
        self.assertEqual(self.yora.tickets[100]["resolution_notes"], "VPN restored")
        self.assertIn(f"fwddeploy #{target_id} is now Resolved.", self.yora.notes[100][-1]["body"])

    def test_echo_webhooks_from_bridge_writes_are_no_ops(self) -> None:
        target_id = self.escalate_urgent()
        # fwddeploy fires "ticket created" for the ticket the bridge itself just made.
        created_echo = self.client.post("/webhook/fwddeploy", json={"ticket_id": target_id}, headers=FWD).json()
        self.assertEqual(created_echo["reason"], "status unchanged")

        self.fwd.tickets[target_id]["status"] = 4
        self.client.post("/webhook/fwddeploy", json={"ticket_id": target_id}, headers=FWD)
        notes_after_sync = len(self.yora.notes[100])
        # yora fires "ticket updated" for the status the bridge just wrote, and fwddeploy re-fires too.
        self.client.post("/webhook/yora", json={"ticket_id": 100}, headers=YORA)
        self.client.post("/webhook/fwddeploy", json={"ticket_id": target_id}, headers=FWD)

        self.assertEqual(len(self.fwd.tickets), 1)
        self.assertEqual(len(self.yora.notes[100]), notes_after_sync)

    def test_unbridged_target_ticket_is_ignored(self) -> None:
        own = self.fwd.seed(subject="Internal fwddeploy ticket", status=4)
        response = self.client.post("/webhook/fwddeploy", json={"ticket_id": own["id"]}, headers=FWD).json()
        self.assertEqual(response["reason"], "not a bridged ticket")

    def test_bad_secret_is_rejected(self) -> None:
        response = self.client.post("/webhook/yora", json={"ticket_id": 1}, headers=FWD)
        self.assertEqual(response.status_code, 401)
        self.assertEqual(self.yora.calls, [])

    def test_unknown_tenant_is_404(self) -> None:
        self.assertEqual(self.client.post("/webhook/acme", json={"ticket_id": 1}, headers=YORA).status_code, 404)

    def test_unparseable_ticket_id_is_422(self) -> None:
        response = self.client.post("/webhook/yora", json={"ticket_id": "{{ticket.id}}"}, headers=YORA)
        self.assertEqual(response.status_code, 422)

    def test_target_validation_error_surfaces_as_502_without_linking(self) -> None:
        self.yora.seed(subject="Urgent", priority=4)
        self.fwd.fail_next(400)

        response = self.client.post("/webhook/yora", json={"ticket_id": 100}, headers=YORA)

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["tenant"], "fwddeploy")
        self.assertEqual(response.json()["status"], 400)
        retry = self.client.post("/webhook/yora", json={"ticket_id": 100}, headers=YORA).json()
        self.assertEqual(retry["action"], "escalated")

    def test_rate_limit_is_retried_once(self) -> None:
        self.yora.seed(subject="Urgent", priority=4)
        self.yora.fail_next(429, {"Retry-After": "0"})

        response = self.client.post("/webhook/yora", json={"ticket_id": 100}, headers=YORA)

        self.assertEqual(response.json()["action"], "escalated")
        self.assertEqual(self.yora.calls[:2], [("GET", "/tickets/100"), ("GET", "/tickets/100")])

    def test_missing_ticket_is_502_not_500(self) -> None:
        response = self.client.post("/webhook/yora", json={"ticket_id": 999}, headers=YORA)
        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["status"], 404)


if __name__ == "__main__":
    unittest.main()
