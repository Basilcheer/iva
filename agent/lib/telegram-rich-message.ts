/**
 * Pure deterministic AST parser for Telegram rich editor blocks (`raw.rich_message.blocks`).
 * Implements ADR-0002 Zero Data Loss and structural Markdown link boundary security.
 *
 * Two projections share the same iterative walker:
 * - `"archive"` — lossless Daily Vault text (raw URL destinations).
 * - `"safe-model"` — sanitized Markdown for LLM turn context (allowlisted schemes, escaped labels).
 *
 * Photo blocks are never mixed into text extraction; {@link extractRichMessagePhotos}
 * isolates them independently.
 */

import type { TelegramRawMedia } from "./telegram-parts.ts";

/**
 * Hard cap on AST nodes visited in a single {@link extractRichMessageIterative} call.
 *
 * Shared across every block in `rich_message.blocks`. Exceeding this budget
 * fail-closes the entire extraction with `null` so a cyclic or hostile tree
 * cannot produce a partial prefix or hang the event loop (AST DoS defense).
 */
export const MAX_RICH_MESSAGE_NODES = 50_000 as const;

/**
 * URL protocols permitted in `"safe-model"` destinations after `new URL` parsing.
 * Archive mode does not consult this set and preserves raw `url` tokens as-is.
 */
const ALLOWED_RICH_MESSAGE_PROTOCOLS = new Set<string>([
  "http:",
  "https:",
  "tg:",
]);

/**
 * Projection mode for rich-message text extraction.
 *
 * - `"archive"` — lossless raw representation for ADR-0002 Daily Vault storage.
 *   URL tokens emit `[label](rawUrl)` without scheme allowlisting or label escaping.
 * - `"safe-model"` — sanitized projection for LLM turn context. Destinations must
 *   pass {@link isValidUrlScheme}; completed labels are escaped in a single pass
 *   after nested tokens render; disallowed destinations drop the link wrapper
 *   while still rendering inner tokens.
 */
export type RichMessageRenderMode = "archive" | "safe-model";

// --- Type Contracts ---

/**
 * Inline URL token: a hyperlink whose destination lives in `url` and whose
 * visible label is nested `text` (string, token array, or omitted).
 */
export interface RichMessageUrlToken {
  readonly type: "url";
  readonly text: RichMessageText;
  readonly url: string;
}

/**
 * Inline italic token. Nested `text` is wrapped with `*` delimiters during render.
 */
export interface RichMessageItalicToken {
  readonly type: "italic";
  readonly text: RichMessageText;
}

/**
 * Inline bold token. Nested `text` is wrapped with `**` delimiters during render.
 */
export interface RichMessageBoldToken {
  readonly type: "bold";
  readonly text: RichMessageText;
}

/**
 * Inline mention token. A non-empty `username` renders as `@user`; otherwise
 * nested `text` is visited if present.
 */
export interface RichMessageMentionToken {
  readonly type: "mention";
  readonly text?: RichMessageText;
  readonly username?: string;
}

/**
 * Catch-all inline token for unknown `type` values. Capability-based walkers
 * still descend into `text` when it is defined so ADR-0002 does not drop payload.
 */
export interface RichMessageUnknownToken {
  readonly type: string;
  readonly text?: RichMessageText;
  readonly [key: string]: unknown;
}

/**
 * Discriminated union of known inline tokens plus an open unknown variant.
 */
export type RichMessageToken =
  | RichMessageUrlToken
  | RichMessageItalicToken
  | RichMessageBoldToken
  | RichMessageMentionToken
  | RichMessageUnknownToken;

/**
 * A single inline leaf: a plain string or a structured {@link RichMessageToken}.
 */
export type RichMessageInline = string | RichMessageToken;

/**
 * Recursive text payload: a string leaf or a readonly array of inline nodes.
 */
export type RichMessageText = string | readonly RichMessageInline[];

/**
 * Paragraph-shaped block. Extraction keys off `text !== undefined`, not `type`.
 */
export interface RichMessageParagraph {
  readonly type: "paragraph";
  readonly text: RichMessageText;
}

/**
 * One Telegram photo size variant (`file_id` plus optional dimensions and ids).
 * {@link selectLargestPhoto} ranks variants by pixel area, then `file_size`.
 */
export interface RichMessagePhotoSize {
  readonly file_id: string;
  readonly file_unique_id?: string;
  readonly file_size?: number;
  readonly width?: number;
  readonly height?: number;
}

/**
 * Photo block in `rich_message.blocks`. Text extractors skip it (no `text`);
 * {@link extractRichMessagePhotos} consumes it independently.
 */
export interface RichMessagePhotoBlock {
  readonly type: "photo";
  readonly photo: readonly RichMessagePhotoSize[];
}

/**
 * A rich-message block: paragraph, photo, or an unknown typed record.
 * Text extraction is capability-based (`block.text !== undefined`).
 */
export type RichMessageBlock =
  | RichMessageParagraph
  | RichMessagePhotoBlock
  | { readonly type: string; readonly [key: string]: unknown };

// --- Helper Guards & Escaping ---

/**
 * Narrows `unknown` to a non-null, non-array object record.
 *
 * @param value - Candidate value from untrusted Telegram JSON.
 * @returns `true` when `value` is a plain object (`typeof === "object"`, not `null`, not an array).
 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Escapes Markdown link-label delimiters so nested `[` / `]` cannot close the
 * surrounding `[label](url)` boundary early.
 *
 * Backslashes are doubled first, then brackets, so a literal `\[` stays escaped.
 *
 * @param label - Raw label text assembled from nested AST tokens.
 * @returns Label safe to splice into `[…](url)` without breaking CommonMark link syntax.
 */
export function escapeMarkdownLabel(label: string): string {
  return label
    .replaceAll("\\", "\\\\")
    .replaceAll("[", "\\[")
    .replaceAll("]", "\\]");
}

/**
 * Escapes a Markdown link destination for CommonMark `[label](url)` wrapping.
 *
 * - Backslashes are doubled, then `(` / `)` are backslash-escaped so parentheses
 *   cannot terminate the destination.
 * - C0 controls (`U+0000`–`U+001F`), DEL (`U+007F`), whitespace, and angle
 *   brackets are URI percent-encoded (`encodeURIComponent`) so they cannot
 *   inject newlines or HTML into the destination.
 *
 * @param url - Raw destination string (already scheme-validated in safe-model).
 * @returns Destination safe to place inside Markdown parentheses.
 */
export function escapeMarkdownUrl(url: string): string {
  return (
    url
      .replaceAll("\\", "\\\\")
      .replaceAll("(", "\\(")
      .replaceAll(")", "\\)")
      // eslint-disable-next-line no-control-regex -- control characters must be percent-encoded in link destinations
      .replaceAll(/[\s<>\u0000-\u001F\u007F]/g, (match) =>
        encodeURIComponent(match),
      )
  );
}

/**
 * Returns whether `value` parses as an absolute URL whose protocol is in
 * {@link ALLOWED_RICH_MESSAGE_PROTOCOLS} (`http:`, `https:`, `tg:`).
 *
 * Invalid URL strings fail closed (`false`); comparison is case-insensitive.
 *
 * @param value - Candidate absolute URL string.
 * @returns `true` when `new URL(value)` succeeds and the protocol is allowlisted.
 */
export function isValidUrlScheme(value: string): boolean {
  try {
    const parsed = new URL(value);
    return ALLOWED_RICH_MESSAGE_PROTOCOLS.has(parsed.protocol.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * Escape-aware preformatted link parser.
 *
 * Accepts either a CommonMark `[label](url)` string (bracket-depth and
 * backslash-escape aware so `\]` cannot close the label early) or a bare URL.
 * The destination is sanitized with {@link isValidUrlScheme}; a disallowed
 * scheme yields `href: null` while preserving a non-empty label (ADR-0002).
 *
 * @param raw - Token `url` field: a preformatted `[label](href)` string or a bare URL.
 * @param innerText - Nested AST label to prefer over the parsed label part.
 * @returns `{ label, href }` where `href` is an allowlisted destination or `null`.
 */
function parsePreformattedLink(
  raw: string,
  innerText: string,
): { readonly label: string; readonly href: string | null } {
  const trimmed = raw.trim();
  if (trimmed.startsWith("[") && trimmed.endsWith(")")) {
    let splitIdx = -1;
    let escaped = false;
    let bracketDepth = 0;

    for (let i = 1; i < trimmed.length - 1; i++) {
      const char = trimmed[i];
      if (escaped) {
        escaped = false;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        continue;
      }
      if (char === "[" && splitIdx === -1) {
        bracketDepth++;
      } else if (char === "]" && splitIdx === -1) {
        if (bracketDepth > 0) {
          bracketDepth--;
        } else if (trimmed[i + 1] === "(") {
          splitIdx = i;
          break;
        }
      }
    }

    if (splitIdx > 0 && bracketDepth === 0) {
      const labelPart = trimmed.slice(1, splitIdx).trim();
      const targetPart = trimmed.slice(splitIdx + 2, -1).trim();
      if (isValidUrlScheme(targetPart)) {
        return {
          label: innerText || labelPart || targetPart,
          href: targetPart,
        };
      }
      return {
        label: innerText || labelPart || targetPart,
        href: null,
      };
    }
  }

  if (isValidUrlScheme(trimmed)) {
    return { label: innerText || trimmed, href: trimmed };
  }

  return { label: innerText || trimmed, href: null };
}

/**
 * Coerces `value` to a positive finite number, otherwise `0`.
 *
 * Used when ranking photo sizes so missing/`NaN`/`Infinity` dimensions do not
 * dominate {@link comparePhotoSizes}.
 *
 * @param value - Candidate numeric field (`width`, `height`, or `file_size`).
 * @returns `value` when it is a finite number greater than zero; otherwise `0`.
 */
function positiveFinite(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/**
 * Orders two photo-size records: larger pixel area first, then larger `file_size`.
 *
 * @param a - Left photo-size record.
 * @param b - Right photo-size record.
 * @returns Negative when `a` is smaller, positive when `a` is larger, `0` when equal.
 */
function comparePhotoSizes(
  a: Record<string, unknown>,
  b: Record<string, unknown>,
): number {
  const areaA = positiveFinite(a.width) * positiveFinite(a.height);
  const areaB = positiveFinite(b.width) * positiveFinite(b.height);
  if (areaA !== areaB) return areaA - areaB;
  return positiveFinite(a.file_size) - positiveFinite(b.file_size);
}

/**
 * Picks the largest well-formed photo variant from a photo block.
 *
 * Skips non-records and empty `file_id`. Ranking is {@link comparePhotoSizes}.
 *
 * @param block - Rich-message block expected to hold a `photo` array.
 * @returns `TelegramRawMedia` with `tag: "photo"` for the largest variant, or `null`.
 */
function selectLargestPhoto(
  block: Record<string, unknown>,
): TelegramRawMedia | null {
  if (!Array.isArray(block.photo) || block.photo.length === 0) {
    return null;
  }

  let bestItem: Record<string, unknown> | null = null;

  for (const item of block.photo) {
    if (
      !isRecord(item) ||
      typeof item.file_id !== "string" ||
      !item.file_id.trim()
    ) {
      continue;
    }
    if (bestItem === null || comparePhotoSizes(item, bestItem) > 0) {
      bestItem = item;
    }
  }

  if (!bestItem || typeof bestItem.file_id !== "string") return null;

  return {
    fileId: bestItem.file_id,
    fileUniqueId:
      typeof bestItem.file_unique_id === "string"
        ? bestItem.file_unique_id
        : undefined,
    tag: "photo",
    transcribe: false,
  };
}

// --- Structural Iterative AST Traversal Engine ---

/**
 * Explicit work-stack frames for the non-recursive AST walker.
 *
 * - `"node"` — pending AST value (string, array, or token record) to visit.
 * - `"suffix"` — trailing Markdown delimiter flushed after nested children
 *   (`**`, `*`, or archive-mode `](rawUrl)`).
 * - `"fallback"` — if nothing was emitted after `mark`, splice in `defaultText`
 *   so a rejected/empty URL still leaves a non-empty carrier (ADR-0002).
 * - `"label-boundary"` — closes an active safe-model link: escape the completed
 *   label in one pass via {@link escapeMarkdownLabel}, then write `](escapedUrl)`.
 */
type IterativeStackItem =
  | { readonly kind: "node"; readonly node: unknown }
  | { readonly kind: "suffix"; readonly value: string }
  | {
      readonly kind: "fallback";
      readonly mark: number;
      readonly defaultText: string;
    }
  | {
      readonly kind: "label-boundary";
      readonly mark: number;
      readonly safeHref: string;
    };

/**
 * Structural iterative AST extractor: `"archive"` is lossless for the Daily
 * Vault; `"safe-model"` keeps allowlisted URLs, escapes completed labels after
 * nested tokens render, and drops disallowed destinations while still rendering
 * nested inner tokens. Empty-label rejected URLs emit a non-empty plain fallback
 * so the carrier stays present (ADR-0002). Traversal is bounded by
 * `MAX_RICH_MESSAGE_NODES`; budget exhaustion or an unclosed label fails
 * closed with `null` and never returns a partial prefix.
 *
 * Walk is iterative (explicit {@link IterativeStackItem} stack), not recursive,
 * so hostile depth cannot overflow the call stack. Blocks are selected by
 * capability (`block.text !== undefined`), not by `type === "paragraph"`, so
 * unknown text-bearing types still extract. Photo blocks lack `text` and are
 * skipped here; use {@link extractRichMessagePhotos}. Label escaping is a
 * single pass at `"label-boundary"` after nested tokens have already rendered.
 *
 * @param richMessage - Untrusted `raw.rich_message` value; must be a record with a `blocks` array.
 * @param mode - `"archive"` for lossless Daily Vault text; `"safe-model"` for sanitized LLM Markdown.
 * @returns Joined block text (paragraphs separated by `\n\n`), or `null` on
 *   malformed input, empty reconstruction, traversal-budget exhaustion,
 *   an unclosed active label, or any thrown exception.
 */
export function extractRichMessageIterative(
  richMessage: unknown,
  mode: RichMessageRenderMode,
): string | null {
  try {
    if (!isRecord(richMessage) || !Array.isArray(richMessage.blocks)) {
      return null;
    }

    const lines: string[] = [];
    let totalIterations = 0;

    for (const block of richMessage.blocks) {
      if (!isRecord(block)) continue;
      const blockText = block.text;
      if (blockText === undefined) continue;

      const stack: IterativeStackItem[] = [{ kind: "node", node: blockText }];
      const output: string[] = [];
      let inActiveLabel = false;
      let exhausted = false;

      while (stack.length > 0) {
        if (++totalIterations > MAX_RICH_MESSAGE_NODES) {
          exhausted = true;
          break;
        }
        const current = stack.pop();
        if (!current) continue;

        if (current.kind === "suffix") {
          output.push(current.value);
          continue;
        }

        if (current.kind === "fallback") {
          const emitted = output.slice(current.mark).join("").trim();
          if (emitted.length === 0) {
            output.splice(
              current.mark,
              output.length - current.mark,
              current.defaultText,
            );
          }
          continue;
        }

        if (current.kind === "label-boundary") {
          inActiveLabel = false;
          const rawLabel = output.slice(current.mark).join("");
          const safeLabel = escapeMarkdownLabel(rawLabel);
          const safeUrl = escapeMarkdownUrl(current.safeHref);
          output.splice(
            current.mark,
            output.length - current.mark,
            safeLabel + `](${safeUrl})`,
          );
          continue;
        }

        const node = current.node;

        if (typeof node === "string") {
          output.push(node);
        } else if (Array.isArray(node)) {
          for (let i = node.length - 1; i >= 0; i--) {
            stack.push({ kind: "node", node: node[i] });
          }
        } else if (isRecord(node)) {
          const type = typeof node.type === "string" ? node.type : "";

          if (type === "bold") {
            output.push("**");
            stack.push({ kind: "suffix", value: "**" });
            stack.push({ kind: "node", node: node.text });
          } else if (type === "italic") {
            output.push("*");
            stack.push({ kind: "suffix", value: "*" });
            stack.push({ kind: "node", node: node.text });
          } else if (type === "mention") {
            const user =
              typeof node.username === "string" ? node.username.trim() : "";
            if (user) {
              output.push(user.startsWith("@") ? user : `@${user}`);
            } else if (node.text !== undefined) {
              stack.push({ kind: "node", node: node.text });
            }
          } else if (type === "url") {
            if (mode === "archive") {
              const rawUrl = typeof node.url === "string" ? node.url : "";
              if (rawUrl) {
                output.push("[");
                stack.push({ kind: "suffix", value: `](${rawUrl})` });
                stack.push({
                  kind: "node",
                  node: node.text !== undefined ? node.text : rawUrl,
                });
              } else if (node.text !== undefined) {
                stack.push({ kind: "node", node: node.text });
              }
            } else {
              const rawUrl = typeof node.url === "string" ? node.url : "";
              const parsed = parsePreformattedLink(rawUrl, "");
              const defaultLabel = parsed.label || rawUrl.trim();

              if (
                parsed.href &&
                isValidUrlScheme(parsed.href) &&
                !inActiveLabel
              ) {
                inActiveLabel = true;
                output.push("[");
                const mark = output.length;
                stack.push({
                  kind: "label-boundary",
                  mark,
                  safeHref: parsed.href,
                });
                stack.push({
                  kind: "fallback",
                  mark,
                  defaultText: defaultLabel,
                });
                stack.push({
                  kind: "node",
                  node:
                    node.text !== undefined && node.text !== ""
                      ? node.text
                      : defaultLabel,
                });
              } else {
                // Disallowed scheme OR nested URL inside an active label
                const mark = output.length;
                const fallbackText = inActiveLabel
                  ? defaultLabel
                  : escapeMarkdownLabel(defaultLabel);

                stack.push({
                  kind: "fallback",
                  mark,
                  defaultText: fallbackText,
                });
                stack.push({
                  kind: "node",
                  node:
                    node.text !== undefined && node.text !== ""
                      ? node.text
                      : fallbackText,
                });
              }
            }
          } else if (node.text !== undefined) {
            stack.push({ kind: "node", node: node.text });
          }
        }
      }

      if (exhausted || inActiveLabel) {
        return null;
      }

      lines.push(output.join(""));
    }

    if (lines.length === 0) return null;
    const reconstructed = lines.join("\n\n");
    return reconstructed.trim().length > 0 ? reconstructed : null;
  } catch {
    return null;
  }
}

/**
 * Projection helper for ADR-0002 lossless Daily Vault preservation.
 *
 * Equivalent to {@link extractRichMessageIterative} with `mode: "archive"`:
 * URL destinations are emitted raw (no scheme allowlist, no label escaping).
 *
 * @param richMessage - Untrusted `raw.rich_message` value.
 * @returns Lossless reconstructed text, or `null` when extraction fail-closes.
 */
export function extractRichMessageArchivalText(
  richMessage: unknown,
): string | null {
  return extractRichMessageIterative(richMessage, "archive");
}

/**
 * Projection helper for sanitized Markdown intended for LLM turn context.
 *
 * Equivalent to {@link extractRichMessageIterative} with `mode: "safe-model"`:
 * allowlisted destinations, single-pass label escaping, disallowed URLs
 * rendered as plain inner text.
 *
 * @param richMessage - Untrusted `raw.rich_message` value.
 * @returns Sanitized Markdown text, or `null` when extraction fail-closes.
 */
export function extractRichMessageSafeModelText(
  richMessage: unknown,
): string | null {
  return extractRichMessageIterative(richMessage, "safe-model");
}

/**
 * Extracts all inline photo blocks from rich_message in sequential order.
 * Returns an empty array if no photo blocks are present or on malformed input.
 *
 * Independent of text extraction: walks `blocks` for `type === "photo"` only
 * and does not share {@link MAX_RICH_MESSAGE_NODES}. Each block yields at most
 * one {@link TelegramRawMedia} via {@link selectLargestPhoto} (`file_id`,
 * optional `file_unique_id`, pixel area / `file_size` ranking).
 *
 * @param richMessage - Untrusted `raw.rich_message` value.
 * @returns Sequential photo media records; empty on malformed input, missing
 *   photos, or any thrown exception (fail-closed, never throws).
 */
export function extractRichMessagePhotos(
  richMessage: unknown,
): readonly TelegramRawMedia[] {
  try {
    if (!isRecord(richMessage) || !Array.isArray(richMessage.blocks)) {
      return [];
    }

    const photos: TelegramRawMedia[] = [];

    for (const block of richMessage.blocks) {
      if (!isRecord(block) || block.type !== "photo") continue;
      const media = selectLargestPhoto(block);
      if (media) {
        photos.push(media);
      }
    }

    return photos;
  } catch {
    return [];
  }
}
