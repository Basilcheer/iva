globalThis.fetch = (input): Promise<Response> => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url;
  if (url.includes("opencode.ai/zen/go/v1/models")) {
    return Promise.resolve(
      Response.json({ data: [{ id: "deepseek-v4-pro" }] }),
    );
  }
  if (url.includes("api.deepgram.com/v1/projects")) {
    return Promise.resolve(Response.json({}));
  }
  if (url.includes("api.telegram.org/") && url.endsWith("/getMe")) {
    return Promise.resolve(
      Response.json({ ok: true, result: { username: "ivabot" } }),
    );
  }
  throw new Error(`unexpected setup wizard request: ${url}`);
};
