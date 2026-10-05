"""Repair the pinned Telegram tool source contract through public registration APIs.

Remove the nullable-signature repair when telegram-mcp declares its optional None
defaults as nullable types. Remove account preflight when its handlers expose
Unknown account errors directly. The upstream boundary tests detect those changes.
No JSON Schema default is interpreted as permission to accept null.
"""
import inspect
from functools import wraps


async def install_tool_contracts(mcp, functions, account_lookup):
    """Keep the same server/client and re-register only exposed Telegram functions.

    The userbot formerly omitted every top-level null before FastMCP validation.
    Instead fix plain optional source annotations with a None default: calling the
    Python function with that None is identical to its default. Required fields,
    nested models, already-nullable annotations and return types are untouched.
    """
    nullable = {}
    accounts = []
    primitive_types = {str: "string", int: "integer", bool: "boolean", dict: "object"}
    for tool in await mcp.list_tools():
        fn = functions.get(tool.name)
        if not callable(fn):
            continue
        signature = inspect.signature(fn, eval_str=True)
        properties = tool.inputSchema.get("properties", {})
        required = tool.inputSchema.get("required", [])
        fields = [
            parameter.name
            for parameter in signature.parameters.values()
            if parameter.default is None
            and parameter.annotation in primitive_types
            and parameter.name not in required
            and properties.get(parameter.name, {}).get("type")
            == primitive_types[parameter.annotation]
        ]
        check_account = "account" in signature.parameters and "account" in properties
        if not fields and not check_account:
            continue
        repaired = signature.replace(parameters=[
            parameter.replace(annotation=parameter.annotation | None)
            if parameter.name in fields else parameter
            for parameter in signature.parameters.values()
        ])
        wrapped = _contract_function(fn, repaired, account_lookup, check_account)
        mcp.remove_tool(tool.name)
        mcp.add_tool(
            wrapped,
            name=tool.name,
            title=tool.title,
            description=tool.description,
            annotations=tool.annotations,
            icons=tool.icons,
            meta=tool.meta,
            structured_output=tool.outputSchema is not None,
        )
        if fields:
            nullable[tool.name] = fields
        if check_account:
            accounts.append(tool.name)
    return {"nullable": nullable, "accounts": accounts}


def _contract_function(fn, signature, account_lookup, check_account):
    """Preserve the function's guards, context injection and output conversion."""
    @wraps(fn)
    async def call(*args, **kwargs):
        if check_account and kwargs.get("account") is not None:
            # A supported lookup of the existing client, never another session.
            # Let FastMCP return its normal isError result before the handler masks
            # Unknown account as GEN-ERR. None preserves upstream read-only fanout.
            account_lookup(kwargs["account"])
        result = fn(*args, **kwargs)
        return await result if inspect.isawaitable(result) else result

    call.__signature__ = signature
    call.__annotations__ = {
        parameter.name: parameter.annotation
        for parameter in signature.parameters.values()
    }
    call.__annotations__["return"] = signature.return_annotation
    return call
