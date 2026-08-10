// Deterministic inbound and outbound security gates shared by the agent runtime
// and bare-Node operational scripts.

const INVISIBLE_RE = /[\p{Cf}\p{Cc}\u034F]/gu;
const KEEP_CONTROL = new Set(["\n", "\r", "\t"]);
const WALLET_DRAIN_RE =
  /[ༀ-࿿ꀀ-꓏⠀-⣿]|[\u{1D400}-\u{1D7FF}\u{10000}-\u{1034F}]/gu;

export interface SanitizeResult {
  text: string;
  blocked: boolean;
  reason: string;
  flags: string[];
  truncatedChars: number;
}

export interface OutboundFinding {
  type: string;
  name: string;
  preview: string;
}

export interface OutboundResult {
  clean: boolean;
  text: string;
  findings: OutboundFinding[];
}

type Pattern = readonly [name: string, expression: RegExp];

const LOOKALIKES: Record<string, string> = {
  А: "A",
  В: "B",
  С: "C",
  Е: "E",
  Н: "H",
  К: "K",
  М: "M",
  О: "O",
  Р: "P",
  Т: "T",
  Х: "X",
  а: "a",
  с: "c",
  е: "e",
  о: "o",
  р: "p",
  х: "x",
  у: "y",
  Α: "A",
  Β: "B",
  Ε: "E",
  Ζ: "Z",
  Η: "H",
  Ι: "I",
  Κ: "K",
  Μ: "M",
  Ν: "N",
  Ο: "O",
  Ρ: "P",
  Τ: "T",
  Υ: "Y",
  Χ: "X",
  ο: "o",
  ν: "v",
};

const ROLE_MARKER_RE =
  /(?:^|\n)\s*(?:system|assistant|user|human|AI|claude|instruction|admin|root)\s*[:-]\s/gim;

const OVERRIDE_PATTERNS = [
  /ignore\s+(?:all\s+)?previous\s+instructions?/i,
  /forget\s+(?:all\s+)?(?:your\s+)?(?:previous\s+)?instructions?/i,
  /you\s+are\s+now\s+(?:in\s+)?(?:\w+\s+)?mode/i,
  /new\s+(?:system\s+)?instructions?\s*:/i,
  /override\s+(?:all\s+)?(?:safety|security|rules|guidelines)/i,
  /act\s+as\s+(?:if\s+)?(?:you\s+are\s+)?(?:a\s+)?(?:different|new|unrestricted)/i,
  /(?:DAN|STAN|DUDE|KEVIN)\s+mode/i,
  /jailbreak|do\s+anything\s+now/i,
  /pretend\s+(?:you\s+)?(?:are|have)\s+no\s+(?:rules|restrictions|limits)/i,
  /(?:reveal|show|display|print|output)\s+(?:your\s+)?(?:system\s+)?(?:prompt|instructions)/i,
  /(?:send|forward|email|post)\s+(?:all\s+)?(?:data|files|secrets|keys|tokens)/i,
];

const INBOUND_ATTACK_FLAG_NAMES = new Set(["role-markers", "overrides"]);

export function hasInboundAttackSignal(
  result: Pick<SanitizeResult, "blocked" | "flags">,
): boolean {
  if (result.blocked) return true;
  return result.flags.some((flag) => {
    const separator = flag.indexOf("=");
    const name = separator === -1 ? flag : flag.slice(0, separator);
    return INBOUND_ATTACK_FLAG_NAMES.has(name);
  });
}

export function sanitizeInbound(
  input: string,
  maxChars = 50000,
): SanitizeResult {
  if (!Number.isSafeInteger(maxChars) || maxChars < 0) {
    throw new RangeError("maxChars must be a non-negative safe integer");
  }
  const originalLen = input.length;
  const flags: string[] = [];

  let invisibleRemoved = 0;
  let text = input.replace(INVISIBLE_RE, (c) => {
    if (KEEP_CONTROL.has(c)) return c;
    invisibleRemoved++;
    return "";
  });
  if (originalLen > 100 && invisibleRemoved > originalLen * 0.05) {
    return {
      text: "",
      blocked: true,
      reason: `Excessive invisible characters: ${invisibleRemoved} (${Math.floor((invisibleRemoved * 100) / originalLen)}%)`,
      flags: ["invisible-flood"],
      truncatedChars: 0,
    };
  }
  if (invisibleRemoved) flags.push(`invisible=${invisibleRemoved}`);

  let walletRemoved = 0;
  text = text.replace(WALLET_DRAIN_RE, () => {
    walletRemoved++;
    return "";
  });
  if (walletRemoved > 50) {
    return {
      text: "",
      blocked: true,
      reason: `Wallet drain attempt: ${walletRemoved} expensive Unicode chars`,
      flags: ["wallet-drain"],
      truncatedChars: 0,
    };
  }

  let normalized = 0;
  const probe = Array.from(text)
    .map((c) => {
      if (LOOKALIKES[c]) {
        normalized++;
        return LOOKALIKES[c];
      }
      return c;
    })
    .join("");
  if (normalized) flags.push(`lookalikes=${normalized}`);

  const roleMarkers = (probe.match(ROLE_MARKER_RE) || []).length;
  const overrides = OVERRIDE_PATTERNS.filter((re) => re.test(probe)).length;
  if (roleMarkers) flags.push(`role-markers=${roleMarkers}`);
  if (overrides) flags.push(`overrides=${overrides}`);

  let codePoints = 0;
  let keptCodeUnits = text.length;
  for (let offset = 0; offset < text.length;) {
    if (codePoints === maxChars) keptCodeUnits = offset;
    const point = text.codePointAt(offset);
    offset += point !== undefined && point > 0xffff ? 2 : 1;
    codePoints += 1;
  }
  const truncatedChars = Math.max(0, codePoints - maxChars);
  if (truncatedChars > 0) text = text.slice(0, keptCodeUnits);

  if ((roleMarkers >= 2 && overrides >= 1) || overrides >= 3) {
    return {
      text,
      blocked: true,
      reason: `Prompt injection: ${roleMarkers} role markers, ${overrides} override attempts`,
      flags,
      truncatedChars,
    };
  }
  return { text, blocked: false, reason: "clean", flags, truncatedChars };
}

// The shapes the providers of this installation actually issue - agent/provider.ts
// (ollama, opencode, openrouter, codex/OpenAI) and agent/lib/embeddings.ts (jina,
// deepinfra) - plus the neighbours that share the same .env. A key body carries
// hyphens and underscores (sk-proj-…, sk-or-v1-…, sk-ant-api03-…_…), so a class that
// stops at the first hyphen lets a live key through whole: that is the leak these
// patterns close. The lookbehind keeps ordinary prose out ("risk-adjusted-return-…"
// must not become a finding), and each family keeps its own name so the log says
// which key leaked.
// Ollama Cloud, DeepInfra and Deepgram issue keys with no telltale prefix. They are
// caught by the name beside them - generic_key (any *_API_KEY=… or "api key": …),
// bearer_token, dot_env_content. A bare high-entropy blob with no name next to it is
// deliberately not matched: no rule tells it from ordinary text, and redacting the
// model's own answers costs more than that miss.
const API_KEY_PATTERNS: readonly Pattern[] = [
  ["openai", /(?<![A-Za-z0-9])sk-(?!ant-|or-)[A-Za-z0-9_-]{20,}/g],
  ["openrouter", /(?<![A-Za-z0-9])sk-or-(?:v\d+-)?[A-Za-z0-9_-]{20,}/g],
  ["anthropic", /(?<![A-Za-z0-9])sk-ant-[A-Za-z0-9_-]{20,}/g],
  ["groq", /(?<![A-Za-z0-9])gsk_[A-Za-z0-9]{20,}/g],
  ["jina", /(?<![A-Za-z0-9])jina_[A-Za-z0-9_-]{20,}/g],
  // OAuth access token of the ChatGPT subscription (codex) and DeepInfra's scoped
  // token: a three-segment JWT, base64url, always starting from the `{"` header.
  ["jwt", /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
  ["google_api", /AIza[A-Za-z0-9\-_]{35}/g],
  ["github_pat", /ghp_[A-Za-z0-9]{36}/g],
  ["github_fine", /github_pat_[A-Za-z0-9_]{82}/g],
  ["slack_bot", /xoxb-[0-9]{10,}-[A-Za-z0-9]+/g],
  ["slack_user", /xoxp-[0-9]{10,}-[A-Za-z0-9]+/g],
  ["telegram_bot", /\d{8,10}:[A-Za-z0-9_-]{35}/g],
  ["aws_access", /AKIA[A-Z0-9]{16}/g],
  ["stripe", /sk_(?:live|test)_[A-Za-z0-9]{20,}/g],
  ["sendgrid", /SG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}/g],
  ["vercel", /vercel_[A-Za-z0-9_]{20,}/g],
  ["supabase", /sbp_[A-Za-z0-9]{40,}/g],
  ["fal_key", /fal_[A-Za-z0-9_]{20,}/g],
  ["bearer_token", /Bearer\s+[A-Za-z0-9\-._~+/]+=*/gi],
  // The name a prefixless key travels with, in every form a notice shows it: an env
  // line (OLLAMA_API_KEY=…), a config dump ("DEEPINFRA_API_KEY": "…"), a sentence
  // from the provider itself ("api key: …").
  [
    "generic_key",
    /(?:api[\s_-]?key|apikey|api[\s_-]?token)["']?\s*[=:]\s*["']?[A-Za-z0-9\-._]{20,}/gi,
  ],
  [
    "generic_secret",
    /(?:secret|password|passwd|pwd)\s*[=:]\s*["']?[^\s"']{8,}/gi,
  ],
  // A credential that travels as part of an address rather than beside a name -
  // how MEMORY_EMBED_URL carries the DeepInfra key, and a proxy, a Postgres or a
  // Redis URL its own. The shape of the userinfo is the provider's business, so
  // the position is the whole rule: right after `://` and right before the `@` of
  // a host. Both halves go, because either can be the secret; the host stays, or
  // a notice about a failed call stops saying which call failed. The colon is what
  // keeps ordinary text out: `git@github.com:…` has no `://`, `https://user@host`
  // has no password, and an address in prose has neither.
  // The user half may be empty (`redis://:password@host`); the secret half may not.
  ["url_userinfo", /(?<=:\/\/)[^\s/?#@:]*:[^\s/?#@]+(?=@[^\s/?#]+)/g],
];

const INTERNAL_PATH_PATTERNS: readonly Pattern[] = [
  [
    "home_dotfiles",
    /(?:\/home\/\w+|~)\/\.(?:ssh|config|env|gnupg|aws|docker|kube)/g,
  ],
  ["etc_sensitive", /\/etc\/(?:shadow|passwd|sudoers|ssh)/g],
  ["run_secrets", /\/run\/secrets\/\w+/g],
  ["proc_environ", /\/proc\/\w+\/environ/g],
  ["dot_env_content", /^\w+_(?:KEY|TOKEN|SECRET|PASSWORD)\s*=\s*.+$/gm],
];

const EXFIL_PATTERNS: readonly Pattern[] = [
  [
    "markdown_image_exfil",
    /!\[.*?\]\(https?:\/\/[^)]*(?:token|key|secret|api|auth|password|env|data=)[^)]*\)/gi,
  ],
  [
    "html_img_exfil",
    /<img[^>]+src\s*=\s*["']https?:\/\/[^"']*(?:token|key|secret|api|auth)[^"']*["']/gi,
  ],
  [
    "url_with_secret_param",
    /https?:\/\/[^\s]*[?&](?:token|key|secret|api_key|password|auth)=[^\s&]{8,}/gi,
  ],
];

const INJECTION_ARTIFACTS: readonly Pattern[] = [
  [
    "special_tokens",
    /<\|(?:im_start|im_end|system|user|assistant|endoftext)\|>/g,
  ],
];

const REDACTED = "[REDACTED]";

export function scanOutbound(input: string, redact = true): OutboundResult {
  let text = input;
  const findings: OutboundFinding[] = [];
  const groups: ReadonlyArray<
    readonly [type: string, patterns: readonly Pattern[]]
  > = [
    ["api_key", API_KEY_PATTERNS],
    ["internal_path", INTERNAL_PATH_PATTERNS],
    ["data_exfil", EXFIL_PATTERNS],
  ];
  for (const [type, patterns] of groups) {
    for (const [name, re] of patterns) {
      const matches = input.match(re);
      if (!matches) continue;
      for (const match of matches) {
        findings.push({ type, name, preview: match.slice(0, 12) + "…" });
        if (redact) text = text.split(match).join(REDACTED);
      }
    }
  }
  for (const [name, re] of INJECTION_ARTIFACTS) {
    const matches = input.match(re);
    if (matches) {
      for (const match of matches) {
        findings.push({
          type: "injection_artifact",
          name,
          preview: match.slice(0, 20),
        });
      }
    }
  }
  const clean = findings.every(
    (finding) => finding.type === "injection_artifact",
  );
  return { clean, text, findings };
}
