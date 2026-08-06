const FRAMES = ["◇", "◈", "◆", "◈"];

type ProgressStream = {
  isTTY?: boolean;
  write(chunk: string): unknown;
};

type ProgressEnv = Record<string, string | undefined>;

type ProgressOptions = {
  stream?: ProgressStream;
  env?: ProgressEnv;
  intervalMs?: number;
  verbose?: boolean;
};

export type TerminalProgress = {
  start(text: string): void;
  done(text: string): void;
  fail(text: string): void;
  info(text: string): void;
  dispose(): void;
};

export function animationEnabled(
  stream: ProgressStream = process.stdout,
  env: ProgressEnv = process.env,
): boolean {
  return Boolean(
    stream.isTTY && !env.IVA_NO_ANIM && !env.NO_COLOR && env.TERM !== "dumb",
  );
}

export function createTerminalProgress({
  stream = process.stdout,
  env = process.env,
  intervalMs = 90,
  verbose = false,
}: ProgressOptions = {}): TerminalProgress {
  const animate = animationEnabled(stream, env) && !verbose;
  let timer: ReturnType<typeof setInterval> | null = null;
  let frame = 0;
  let active: string | null = null;
  let cursorHidden = false;
  const signals = ["SIGINT", "SIGTERM"] as const;

  const hideCursor = () => {
    if (!animate || cursorHidden) return;
    stream.write("\x1b[?25l");
    cursorHidden = true;
  };
  const showCursor = () => {
    if (!cursorHidden) return;
    stream.write("\x1b[?25h");
    cursorHidden = false;
  };
  const draw = () => {
    if (!active) return;
    const text = `${FRAMES[frame++ % FRAMES.length]} ${active}`;
    stream.write(animate ? `\r\x1b[2K${text}` : `${text}\n`);
  };
  const stopTimer = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  const finishLine = (symbol: string, text: string) => {
    stopTimer();
    if (animate && active) stream.write("\r\x1b[2K");
    active = null;
    showCursor();
    stream.write(`${symbol} ${text}\n`);
  };

  const api: TerminalProgress = {
    start(text: string) {
      if (active) finishLine("✓", active);
      active = text;
      frame = 0;
      hideCursor();
      draw();
      if (animate) timer = setInterval(draw, intervalMs);
    },
    done(text: string) {
      finishLine("✓", text);
    },
    fail(text: string) {
      finishLine("⚠️", text);
    },
    info(text: string) {
      if (active && animate) stream.write("\r\x1b[2K");
      stream.write(`${text}\n`);
      if (active && animate) draw();
    },
    dispose() {
      stopTimer();
      if (animate && active) stream.write("\r\x1b[2K");
      active = null;
      showCursor();
      for (const signal of signals)
        process.removeListener(signal, signalHandlers[signal]);
    },
  };
  const signalHandlers = {} as Record<(typeof signals)[number], () => void>;
  for (const signal of signals) {
    signalHandlers[signal] = () => {
      api.dispose();
      process.kill(process.pid, signal);
    };
  }
  if (animate)
    for (const signal of signals) process.once(signal, signalHandlers[signal]);
  return api;
}

export { FRAMES as SPINNER_FRAMES };
