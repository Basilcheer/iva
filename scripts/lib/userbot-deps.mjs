export function userbotSyncArgs({
  pythonPath,
  requirementsFile,
  requirementsText,
  requireHashes = true,
}) {
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
