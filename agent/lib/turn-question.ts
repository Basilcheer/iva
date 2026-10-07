// Последнее принятое сообщение владельца в чате — для цитаты в сообщении об обрыве посреди
// ответа. Если оборвался первый запрос хода, eve не кладёт вопрос в историю сессии, и без
// цитаты нажатие «Повторить» пришло бы к модели без вопроса (решение лида 07.10.2026).
//
// Память процесса, как у заявок на уведомление о сбое (telegram-failure-notice.ts): приём
// сообщения и событие сбоя живут в одном модуле канала. После перезапуска цитаты нет —
// сообщение уходит без неё. В режиме «по очереди» мост держит следующее сообщение до конца
// хода, поэтому последнее принятое и есть вопрос хода; в режиме «сразу» это последнее
// сообщение владельца, и цитата называет его.

const QUESTIONS_KEPT = 256;
const questions = new Map<string, string>();

/** Подписи кнопки «Повторить»: нажатие несёт старую цитату, новым вопросом оно не станет. */
const RETRY_LABELS = new Set(["Повторить", "Try again"]);

function isRetryTap(text: string): boolean {
  return RETRY_LABELS.has(text.split("\n", 1)[0]?.trim() ?? "");
}

export function rememberTurnQuestion(chatKey: string, text: string): void {
  const question = text.trim();
  if (question === "") return;
  if (isRetryTap(question) && questions.has(chatKey)) return;
  questions.delete(chatKey);
  questions.set(chatKey, question);
  while (questions.size > QUESTIONS_KEPT) {
    const oldest = questions.keys().next().value;
    if (oldest === undefined) break;
    questions.delete(oldest);
  }
}

export function turnQuestion(chatKey: string): string | undefined {
  return questions.get(chatKey);
}
