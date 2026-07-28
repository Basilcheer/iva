export async function publishTelegramTurnStarted({
  chatKey,
  continuationToken,
  sessionId,
  turnId,
  setStatusImpl,
  setStatusIfImpl,
  sendWorkingStatusImpl,
  removeWorkingStatusImpl = async () => {},
  onWorkingStatusError = () => {},
}) {
  setStatusImpl(chatKey, {
    status: "running",
    continuationToken,
    sessionId,
    turnId,
    statusMessageId: null,
    wasCancelled: null,
  });

  let statusMessageId;
  try {
    statusMessageId = await sendWorkingStatusImpl();
  } catch (error) {
    onWorkingStatusError(error);
    return;
  }
  if (statusMessageId === null || statusMessageId === undefined) return;

  const attached = setStatusIfImpl(
    chatKey,
    { status: "running", sessionId, turnId },
    { statusMessageId },
  );
  if (!attached) {
    try {
      await removeWorkingStatusImpl(statusMessageId);
    } catch (error) {
      onWorkingStatusError(error);
    }
  }
}
