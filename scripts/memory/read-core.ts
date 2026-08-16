import { lstatSync, readFileSync } from "node:fs";

export type CoreReadState =
  | { readonly state: "missing" }
  | { readonly state: "valid"; readonly text: string }
  | { readonly state: "unreadable"; readonly error: unknown };

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

/** A missing CORE is an empty first-run state; every other read failure stays explicit. */
export function readCore(path: string): CoreReadState {
  try {
    return { state: "valid", text: readFileSync(path, "utf8") };
  } catch (error) {
    if (errorCode(error) !== "ENOENT") return { state: "unreadable", error };
    try {
      lstatSync(path);
      return { state: "unreadable", error };
    } catch (entryError) {
      return errorCode(entryError) === "ENOENT"
        ? { state: "missing" }
        : { state: "unreadable", error: entryError };
    }
  }
}
