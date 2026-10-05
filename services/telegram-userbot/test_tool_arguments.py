import inspect
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from mcp.server.fastmcp import FastMCP
from mcp.server.fastmcp.exceptions import ToolError
from pydantic import BaseModel

from tool_contracts import install_tool_contracts


class Nested(BaseModel):
    required: str
    nullable: str | None


class ToolContractsTest(unittest.IsolatedAsyncioTestCase):
    async def test_source_semantics_do_not_infer_nullability_from_schema_default(self):
        mcp = FastMCP("test")

        @mcp.tool()
        def source(required: str, nested: Nested, nullable: str | None,
                   value: str = None, count: int = None, flag: bool = None,
                   rights: dict = None, values: list[str] | None = None,
                   with_about: bool = False) -> str:
            return repr((required, nested, nullable, value, count, flag, rights, values, with_about))

        @mcp.tool()
        def unrelated(value: str = None) -> str:
            return "unrelated"

        before = {tool.name: tool for tool in await mcp.list_tools()}
        changed = await install_tool_contracts(mcp, {"source": source}, lambda _: None)
        after = {tool.name: tool for tool in await mcp.list_tools()}
        self.assertEqual(changed["nullable"], {"source": ["value", "count", "flag", "rights"]})
        self.assertEqual(before["unrelated"], after["unrelated"])
        expected = before["source"].model_dump()
        for name in changed["nullable"]["source"]:
            expected["inputSchema"]["properties"][name] = after["source"].inputSchema["properties"][name]
        self.assertEqual(expected, after["source"].model_dump())
        self.assertIs(inspect.signature(source).parameters["value"].annotation, str)
        accepted = {"required": "yes", "nested": {"required": "yes", "nullable": None}, "nullable": None}
        await mcp.call_tool("source", {**accepted, "value": None, "count": None, "flag": None, "rights": None})
        for invalid in ({**accepted, "required": None}, {**accepted, "nested": {"required": None, "nullable": None}}, {**accepted, "value": 9}):
            with self.assertRaises(ToolError):
                await mcp.call_tool("source", invalid)

    async def test_known_account_preflight_keeps_omission_and_fanout(self):
        mcp = FastMCP("test")
        calls = []
        lookups = []

        def lookup(account):
            lookups.append(account)
            if account.lower() not in ("first", "second"):
                raise ValueError(f"Unknown account '{account}'. Available accounts: first, second")

        @mcp.tool()
        async def source(account: str = None) -> str:
            calls.append(account)
            return "fanout" if account is None else account

        await install_tool_contracts(mcp, {"source": source}, lookup)
        await mcp.call_tool("source", {})
        await mcp.call_tool("source", {"account": None})
        await mcp.call_tool("source", {"account": "SECOND"})
        with self.assertRaisesRegex(ToolError, "Unknown account 'main'. Available accounts: first, second"):
            await mcp.call_tool("source", {"account": "main"})
        self.assertEqual(calls, [None, None, "SECOND"])
        self.assertEqual(lookups, ["SECOND", "main"])

    async def test_pinned_upstream_contract_metadata_pruning_and_account_error(self):
        # No real Telegram network, login or owner session. The upstream module
        # constructs its one client against a fresh temporary SQLite session.
        old_cwd = Path.cwd()
        with tempfile.TemporaryDirectory() as temporary:
            os.chdir(temporary)
            try:
                with patch.dict(os.environ, {
                    "TELEGRAM_API_ID": "12345", "TELEGRAM_API_HASH": "0" * 32,
                    "TELEGRAM_SESSION_NAME": str(Path(temporary) / "session"),
                    "TELEGRAM_EXPOSED_TOOLS": "read-only",
                }):
                    import telegram_mcp.runtime as runtime
                    import telegram_mcp.tools as source
                    before = {tool.name: tool for tool in await runtime.mcp.list_tools()}
                    self.assertEqual(len(before), 116)
                    self.assertEqual(before["list_messages"].inputSchema["properties"]["account"]["type"], "string")
                    removed = runtime._apply_exposed_tools_mode(runtime.mcp)
                    exposed = {tool.name: tool for tool in await runtime.mcp.list_tools()}
                    with patch.dict(runtime.clients, {"default": object()}, clear=True):
                        masked = await runtime.mcp.call_tool("list_messages", {"chat_id": "@example", "account": "main"})
                    self.assertIn("GEN-ERR-", str(masked))
                    self.assertNotIn("Unknown account", str(masked))
                    started = time.perf_counter()
                    changed = await install_tool_contracts(runtime.mcp, vars(source), runtime.get_client)
                    duration = time.perf_counter() - started
                    after = {tool.name: tool for tool in await runtime.mcp.list_tools()}
                    self.assertEqual(set(exposed), set(after))
                    self.assertTrue(set(removed).isdisjoint(after))
                    for name, descriptor in exposed.items():
                        expected = descriptor.model_dump()
                        for field in changed["nullable"].get(name, []):
                            expected["inputSchema"]["properties"][field] = after[name].inputSchema["properties"][field]
                        self.assertEqual(expected, after[name].model_dump(), name)
                    for field in ("account", "from_date", "to_date", "search_query"):
                        self.assertIn({"type": "null"}, after["list_messages"].inputSchema["properties"][field]["anyOf"])
                    with patch.dict(runtime.clients, {"default": object()}, clear=True):
                        with self.assertRaisesRegex(ToolError, "Unknown account 'main'. Available accounts: default"):
                            await runtime.mcp.call_tool("list_messages", {"chat_id": "@example", "account": "main"})
                    print(f"read-only source adapter: {len(changed['nullable'])} nullable tools, {len(changed['accounts'])} account preflights, {duration * 1000:.1f} ms")
            finally:
                os.chdir(old_cwd)


if __name__ == "__main__":
    unittest.main()
