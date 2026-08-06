interface UserbotSyncOptions {
  readonly pythonPath: string;
  readonly requirementsFile: string;
  readonly requirementsText: string;
  readonly requireHashes?: boolean;
}

export function userbotSyncArgs({
  pythonPath,
  requirementsFile,
  requirementsText,
  requireHashes = true,
}: UserbotSyncOptions): string[] {
  const hasHashes = requirementsText.includes("--hash=sha256:");
  if (requireHashes && !hasHashes)
    throw new Error(
      "userbot: requirements.lock не содержит hashes — переустанови актуальную версию Iva",
    );

  return [
    "pip",
    "sync",
    "--python",
    pythonPath,
    ...(requireHashes ? ["--require-hashes", "--strict"] : []),
    requirementsFile,
  ];
}
