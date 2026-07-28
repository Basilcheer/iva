import asyncio
import unittest

from serve import _health_payload


class FakeClient:
    def __init__(self, authorized):
        self.authorized = authorized
        self.calls = 0

    async def is_user_authorized(self):
        self.calls += 1
        return self.authorized


class HealthPayloadTest(unittest.TestCase):
    def test_uses_the_existing_client_for_unauthorized_health(self):
        client = FakeClient(False)

        payload = asyncio.run(_health_payload(client))

        self.assertEqual(payload, {"state": "unauthorized"})
        self.assertEqual(client.calls, 1)

    def test_uses_the_existing_client_for_ready_health(self):
        client = FakeClient(True)

        payload = asyncio.run(_health_payload(client))

        self.assertEqual(payload, {"state": "ready"})
        self.assertEqual(client.calls, 1)


if __name__ == "__main__":
    unittest.main()
