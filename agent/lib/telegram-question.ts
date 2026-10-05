import {
  renderTelegramInputRequest,
  registerTelegramFreeformPrompt,
  splitTelegramMessageText,
  telegramContinuationToken,
  type TelegramEventContext,
  type TelegramChannelState,
  type TelegramHandle,
} from "eve/channels/telegram";
import { redactNotice } from "./outbox.ts";
import { escHtml, mdToTelegramHtml } from "./telegram-format.ts";
import { tr } from "./i18n.ts";

type Request = Parameters<typeof renderTelegramInputRequest>[0];
type Resolution = {
  requestId: string;
  outcome: "answered" | "approved" | "denied" | "ignored" | "invalid";
  response?: { optionId?: string; text?: string };
};
type QuestionPreview = {
  messageId: string | number;
  prompt: string;
  labels: Record<string, string>;
  rich: boolean;
  settledStatus?: string;
};
export type QuestionState = TelegramChannelState & {
  questionPreviews?: Record<string, QuestionPreview>;
};
type Handle = Pick<TelegramHandle, "request" | "chatId" | "post"> &
  Partial<Pick<TelegramHandle, "messageThreadId">>;

const QUESTION_EDIT_TIMEOUT_MS = 5000;
class QuestionPostRejected extends Error {}
class QuestionMessageUnavailable extends Error {}
class QuestionStatusTooLong extends Error {}

function messageUnavailable(response: {
  status: number;
  description?: string;
}): boolean {
  return (
    response.status === 400 &&
    /message (?:to edit not found|can['’]t be edited|cannot be edited)/iu.test(
      response.description ?? "",
    )
  );
}

function transport(
  tg: Handle,
  deadline = performance.now() + QUESTION_EDIT_TIMEOUT_MS,
) {
  return async (method: string, body: Record<string, unknown>) => {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw new Error("preview edit timeout");
    let timer: ReturnType<typeof setTimeout> | undefined;
    let response: Awaited<ReturnType<TelegramHandle["request"]>>;
    try {
      response = await Promise.race([
        tg.request(
          method,
          body as NonNullable<Parameters<TelegramHandle["request"]>[1]>,
        ),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("preview edit timeout")),
            remaining,
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
    const payload = (response.body ?? {}) as {
      ok?: boolean;
      result?: {
        message_id?: number;
        chat?: { type?: TelegramChannelState["chatType"] };
      };
      description?: string;
    };
    return {
      ...payload,
      ok: response.ok && payload.ok !== false,
      status: response.status,
    };
  };
}

/** Question delivery only: a failed edit never posts or repeats the accepted action. */
async function deliverQuestionMessage(
  tg: Handle,
  markdown: string,
  options: {
    messageId?: string | number;
    rich: boolean;
    deadline?: number;
    onPosted?: (
      messageId: number,
      chatType: TelegramChannelState["chatType"] | undefined,
    ) => void;
  },
): Promise<number | string> {
  const edit = options.messageId !== undefined;
  const base = {
    chat_id: tg.chatId,
    ...(!edit && tg.messageThreadId !== undefined
      ? { message_thread_id: tg.messageThreadId }
      : {}),
    ...(edit ? { message_id: options.messageId } : {}),
  };
  const response = await transport(tg, options.deadline)(
    edit ? "editMessageText" : "sendRichMessage",
    {
      ...base,
      ...(options.rich
        ? { rich_message: { markdown } }
        : {
            text: mdToTelegramHtml(markdown),
            parse_mode: "HTML",
            link_preview_options: { is_disabled: true },
          }),
      ...(edit ? { reply_markup: { inline_keyboard: [] } } : {}),
    },
  );
  if (
    edit &&
    (response.ok || response.description?.includes("message is not modified"))
  )
    return options.messageId!;
  if (response.ok && response.result?.message_id !== undefined) {
    options.onPosted?.(response.result.message_id, response.result.chat?.type);
    return response.result.message_id;
  }
  if (edit && messageUnavailable(response))
    throw new QuestionMessageUnavailable(
      "question message is no longer editable",
    );
  if (
    edit &&
    response.status === 400 &&
    /(?:message(?: text)?|text) is too long/iu.test(response.description ?? "")
  )
    throw new QuestionStatusTooLong("question status cannot fit");
  // Only a definite unsupported/invalid Bot API request permits native fallback.
  // A timeout, network failure or missing id may already have posted the rich question.
  if (!edit && response.status === 400)
    throw new QuestionPostRejected("rich question rejected");
  throw new Error("question delivery failed");
}

/** The channel persists the preview reference with Eve's compact callback mapping. */
export async function postTelegramQuestion(
  request: Request,
  state: QuestionState,
  tg: Handle,
  rich = false,
  continuation?: TelegramEventContext["continuation"],
): Promise<void> {
  const rendered = renderTelegramInputRequest(request, state);
  const prompt = redactNotice(rendered.text);
  const keyboard = (
    rendered.replyMarkup as
      | {
          inline_keyboard?: Array<
            Array<{ text: string; callback_data: string }>
          >;
        }
      | undefined
  )?.inline_keyboard;
  // Keep question text literal in both Telegram representations.
  let literal = prompt.replace(/[\\`*_{}[\]()#+.!|<>~=$-]/gu, "\\$&");
  const postNative = async () => {
    // Preserve Eve's literal text, ForceReply and long-message splitting behavior.
    const result = await tg.post({
      text: prompt,
      reply_markup: rendered.replyMarkup,
    });
    literal = splitTelegramMessageText(prompt)[0].replace(
      /[\\`*_{}[\]()#+.!|<>~=$-]/gu,
      "\\$&",
    );
    return result.id;
  };
  let sentRich = false;
  let messageId: number | string;
  // Without public continuation routing, use Eve post() so group callbacks stay anchored.
  if (
    rich &&
    keyboard &&
    (continuation !== undefined || state.chatType === "private")
  ) {
    const buttons = keyboard
      .map(
        (row) =>
          `<tg-button-row>${row
            .map(
              (button) =>
                `<tg-button type="callback_data" data="${button.callback_data}">${escHtml(button.text)}</tg-button>`,
            )
            .join("")}</tg-button-row>`,
      )
      .join("\n\n");
    try {
      messageId = await deliverQuestionMessage(tg, `${literal}\n\n${buttons}`, {
        rich: true,
        onPosted: (id, returnedChatType) => {
          // Eve post() normally performs this. Raw rich posting needs the same public
          // state/continuation update so a group callback reaches its awaiting session.
          const chatType = state.chatType ?? returnedChatType;
          if (state.chatType === null && chatType !== undefined)
            state.chatType = chatType;
          if (chatType !== "group" && chatType !== "supergroup") return;
          state.conversationId = String(id);
          continuation?.rekey(
            telegramContinuationToken({
              chatId: state.chatId ?? tg.chatId,
              conversationId: id,
              messageThreadId: state.messageThreadId ?? undefined,
            }),
          );
        },
      });
      sentRich = true;
    } catch (error) {
      if (!(error instanceof QuestionPostRejected)) throw error;
      messageId = await postNative();
    }
  } else {
    messageId = await postNative();
  }

  state.questionPreviews = {
    ...state.questionPreviews,
    [request.requestId]: {
      messageId,
      rich: sentRich,
      prompt: literal,
      labels: Object.fromEntries(
        (request.options ?? []).map(({ id }, index) => [
          id,
          keyboard?.flat()[index]?.text ?? "",
        ]),
      ),
    },
  };
  if (rendered.freeformRequestId !== undefined || request.allowFreeform)
    registerTelegramFreeformPrompt(state, {
      messageId: String(messageId),
      requestId: request.requestId,
    });
}

/** Only the authoritative input.resolved event may settle the preview. */
export async function settleTelegramQuestions(
  resolutions: readonly Resolution[],
  state: QuestionState,
  tg: Handle,
): Promise<void> {
  for (const resolution of resolutions) {
    const preview =
      state.questionPreviews &&
      Object.hasOwn(state.questionPreviews, resolution.requestId)
        ? state.questionPreviews[resolution.requestId]
        : undefined;
    if (!preview || preview.settledStatus) continue;
    for (const [id, response] of Object.entries(state.hitlCallbacks ?? {}))
      if (response.requestId === resolution.requestId)
        delete state.hitlCallbacks?.[id];
    for (const [id, requestId] of Object.entries(
      state.pendingFreeformReplies ?? {},
    ))
      if (requestId === resolution.requestId)
        delete state.pendingFreeformReplies?.[id];
    // Never render freeform input: it may contain a credential or personal data.
    const label =
      resolution.response?.optionId === undefined ||
      !Object.hasOwn(preview.labels, resolution.response.optionId)
        ? undefined
        : preview.labels[resolution.response.optionId];
    const text = ["ignored", "invalid"].includes(resolution.outcome)
      ? tr("Question closed", "Вопрос закрыт")
      : label !== undefined
        ? `${tr("Selected", "Выбрано")}: ${label}`
        : resolution.outcome === "denied"
          ? tr("Request declined", "Запрос отклонён")
          : tr("Answer received", "Ответ принят");
    preview.settledStatus = redactNotice(text).replace(
      /[\\`*_{}[\]()#+.!|<>~=$-]/gu,
      "\\$&",
    );
  }
  await flushSettledTelegramQuestions(state, tg);
}

/** Delivery recovery uses the accepted status, never the answer or business tool again. */
export async function flushSettledTelegramQuestions(
  state: QuestionState,
  tg: Handle,
): Promise<void> {
  const deadline = performance.now() + QUESTION_EDIT_TIMEOUT_MS;
  for (const [requestId, preview] of Object.entries(
    state.questionPreviews ?? {},
  )) {
    if (performance.now() >= deadline) break;
    if (!preview.settledStatus) continue;
    try {
      await deliverQuestionMessage(
        tg,
        `${preview.prompt}\n\n${preview.settledStatus}`,
        {
          messageId: preview.messageId,
          rich: preview.rich,
          deadline,
        },
      );
      if (state.questionPreviews?.[requestId] === preview)
        delete state.questionPreviews[requestId];
    } catch (error) {
      if (error instanceof QuestionMessageUnavailable) {
        if (state.questionPreviews?.[requestId] === preview)
          delete state.questionPreviews[requestId];
        continue;
      }
      console.error("[telegram] could not settle question preview");
      if (!preview.rich) {
        try {
          const removed = await transport(tg, deadline)(
            "editMessageReplyMarkup",
            {
              chat_id: tg.chatId,
              message_id: preview.messageId,
              reply_markup: { inline_keyboard: [] },
            },
          );
          // A definite text-cap rejection cannot recover by repeating the same edit.
          // Retire only after button removal is confirmed, or the message is unavailable.
          if (
            messageUnavailable(removed) ||
            (error instanceof QuestionStatusTooLong &&
              (removed.ok ||
                removed.description?.includes("message is not modified")))
          ) {
            if (state.questionPreviews?.[requestId] === preview)
              delete state.questionPreviews[requestId];
          }
        } catch {
          /* Retry only delivery when the turn completes or resumes. */
        }
      }
      if (state.questionPreviews?.[requestId] === preview) {
        // One failed delivery per lifecycle. Rotate the retained preview so another
        // accepted question gets the next pass, without another queue or state field.
        const pending = { ...state.questionPreviews };
        delete pending[requestId];
        state.questionPreviews = { ...pending, [requestId]: preview };
        break;
      }
    }
  }
}
