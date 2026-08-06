// Хук резолвинга для тестов, импортирующих исходники agent/**/*.ts напрямую.
// Node 24 стрипает типы сам, но НЕ переписывает NodeNext-специфкаторы "./x.js" на "./x.ts"
// (в проде это делает eve build). Импортируй этот модуль ПЕРВЫМ в тесте — и `await import()`
// TS-тула заработает без отдельной сборки.

import { registerHooks } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (
      specifier.startsWith(".") &&
      specifier.endsWith(".js") &&
      context.parentURL
    ) {
      try {
        const url = new URL(specifier, context.parentURL);
        if (url.protocol === "file:") {
          const asJs = fileURLToPath(url);
          const asTs = asJs.replace(/\.js$/, ".ts");
          if (!existsSync(asJs) && existsSync(asTs)) {
            return nextResolve(pathToFileURL(asTs).href, context);
          }
        }
      } catch {
        /* нерезолвимый URL — отдаём как есть */
      }
    }
    return nextResolve(specifier, context);
  },
});
