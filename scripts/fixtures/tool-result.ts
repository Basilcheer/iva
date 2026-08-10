// eve 0.30 lets a tool stream, so `execute` is typed `T | Promise<T> | AsyncIterable<T>`.
// Our tools all resolve to one value; tests read that value directly.

/** The value an `execute` call settles on, with the streaming arm dropped. */
export type Settled<T> = T extends AsyncIterable<infer TValue> ? TValue : T;

/** The single value a tool returned; throws if the tool streamed instead. */
export function settled<T>(result: T): Settled<T> {
  if (
    typeof result === "object" &&
    result !== null &&
    Symbol.asyncIterator in result
  )
    throw new Error(
      "the tool streamed its result; a single value was expected",
    );
  return result as Settled<T>;
}
