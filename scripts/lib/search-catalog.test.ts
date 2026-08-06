import test from "node:test";
import assert from "node:assert/strict";
import { SEARCH_CATALOG, checkSearchKey } from "./search-catalog.ts";

// checkSearchKey читает глобальный fetch в рантайме (без DI), поэтому пробу перехватываем
// подменой globalThis.fetch на время одного вызова; оригинал возвращаем в finally.
type FetchProbe = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<{
  status: number;
  body?: { cancel: () => Promise<void> } | null;
}>;

async function withFetch<T>(
  impl: FetchProbe,
  fn: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = impl as unknown as typeof fetch;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

void test("каталог перечисляет все 4 провайдера с label/keyVar/url", () => {
  assert.deepEqual(Object.keys(SEARCH_CATALOG), [
    "tavily",
    "brave",
    "exa",
    "parallel",
  ]);
  for (const spec of Object.values(SEARCH_CATALOG)) {
    assert.ok(spec.label && spec.keyVar && spec.url);
  }
});

void test("401 → причина отказа", async () => {
  await withFetch(
    () => Promise.resolve({ status: 401 }),
    async () => {
      const reason = await checkSearchKey("tavily", "secret-key");
      assert.equal(typeof reason, "string");
      assert.ok(reason);
      assert.match(reason, /401/);
    },
  );
});

void test("403 → причина отказа", async () => {
  await withFetch(
    () => Promise.resolve({ status: 403 }),
    async () => {
      const reason = await checkSearchKey("brave", "secret-key");
      assert.ok(reason);
      assert.match(reason, /403/);
    },
  );
});

void test("сетевой сбой → null (мягкая политика: ключ принят)", async () => {
  await withFetch(
    () => Promise.reject(new Error("ECONNREFUSED")),
    async () => {
      assert.equal(await checkSearchKey("exa", "secret-key"), null);
    },
  );
});

void test("200 → null (ключ рабочий)", async () => {
  await withFetch(
    () => Promise.resolve({ status: 200 }),
    async () => {
      assert.equal(await checkSearchKey("parallel", "secret-key"), null);
    },
  );
});

void test("неизвестный провайдер → null без сетевого вызова", async () => {
  let called = false;
  await withFetch(
    () => {
      called = true;
      return Promise.resolve({ status: 401 });
    },
    async () => {
      assert.equal(await checkSearchKey("bogus", "secret-key"), null);
    },
  );
  assert.equal(called, false);
});

void test("проба несёт ключ в запросе, но причина отказа его не разглашает", async () => {
  let seen:
    { url: string | URL | Request; opts: RequestInit | undefined } | undefined;
  await withFetch(
    (url, opts) => {
      seen = { url, opts };
      return Promise.resolve({ status: 401 });
    },
    async () => {
      const reason = await checkSearchKey("exa", "top-secret-value");
      assert.ok(seen);
      assert.equal(
        new Headers(seen.opts?.headers).get("x-api-key"),
        "top-secret-value",
      ); // ключ ушёл в заголовок
      assert.ok(reason);
      assert.doesNotMatch(reason, /top-secret-value/); // но не в текст причины
    },
  );
});

void test("credential probes reject redirects and release response bodies", async () => {
  for (const status of [200, 401, 403]) {
    let seen: RequestInit | undefined;
    let cancelCalls = 0;
    await withFetch(
      (_url, options) => {
        seen = options;
        return Promise.resolve({
          status,
          body: {
            cancel: () => {
              cancelCalls += 1;
              return Promise.resolve();
            },
          },
        });
      },
      async () => {
        const result = await checkSearchKey("brave", "secret-key");
        assert.equal(seen?.redirect, "error");
        assert.equal(result === null, status === 200);
      },
    );
    assert.equal(cancelCalls, 1);
  }
});
