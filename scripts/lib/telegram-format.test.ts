import assert from "node:assert/strict";
import test from "node:test";
import {
  chunkMarkdown,
  escHtml,
  htmlToPlain,
  mdToTelegramHtml,
  needsRichMessage,
  sanitizeTelegramHtml,
  toTelegramHtmlChunks,
} from "./telegram-format.mjs";

await test("escaping and plain fallback preserve the existing entity order", () => {
  assert.equal(escHtml("<&>"), "&lt;&amp;&gt;");
  assert.equal(
    htmlToPlain("<b>a &amp;lt; &quot;quoted&quot;</b>"),
    'a &lt; "quoted"',
  );
});

await test("sanitizer repairs crossings and neutralizes unsupported markup", () => {
  assert.equal(
    sanitizeTelegramHtml("<b><i>x</b>y</i><script>x</script>&"),
    "<b><i>x</i></b><i>y</i>&lt;script&gt;x&lt;/script&gt;&amp;",
  );
  assert.equal(
    sanitizeTelegramHtml("<pre><b>x</b></pre>"),
    "<pre>&lt;b&gt;x&lt;/b&gt;</pre>",
  );
});

await test("markdown conversion retains current Telegram HTML fixtures", () => {
  const markdown =
    "# Title\n\n**bold** [link](https://x.test/?a=1&b=2)\n\n```js\nx < y\n```";

  assert.equal(
    mdToTelegramHtml(markdown),
    '<b>Title</b>\n\n<b>bold</b> <a href="https://x.test/?a=1&amp;b=2">link</a>\n\n<pre><code class="language-js">x &lt; y</code></pre>',
  );
});

await test("chunking and rich routing keep their current boundaries", () => {
  assert.deepEqual(chunkMarkdown("a\n\nb\n\nc", 3), ["a", "b", "c"]);
  assert.deepEqual(toTelegramHtmlChunks("", 10), [""]);

  const chunks = toTelegramHtmlChunks(`**${"x".repeat(200)}**`, 40);
  assert.ok(chunks.length > 1);
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 40);
    assert.equal(sanitizeTelegramHtml(chunk), chunk);
  }

  assert.equal(needsRichMessage("- [ ] todo"), true);
  assert.equal(needsRichMessage("**bold** and `code`"), false);
});
