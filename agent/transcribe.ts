// Deepgram: транскрипция голоса/видео (nova-3, language=multi). Пара с vision.ts —
// вторая половина «понять присланный файл», которую канал приносит в inbound-пайплайн.
// Тело запроса — сырые байты, ответ → results.channels[0].alternatives[0].transcript.
export async function transcribe(audio: ArrayBuffer): Promise<string> {
  const language = process.env.DEEPGRAM_LANGUAGE || "multi";
  const url =
    `https://api.deepgram.com/v1/listen?model=nova-3&language=${language}` +
    `&punctuate=true&smart_format=true`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY ?? ""}`,
      "Content-Type": "application/octet-stream",
    },
    body: audio,
  });
  if (!res.ok) throw new Error(`Deepgram HTTP ${res.status}`);
  const json = (await res.json()) as {
    results?: {
      channels?: Array<{ alternatives?: Array<{ transcript?: string }> }>;
    };
  };
  return json.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? "";
}
