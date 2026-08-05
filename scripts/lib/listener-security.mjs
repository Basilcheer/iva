/** Classify listeners for one TCP port from `ss -H -ltn` output. */
export function classifyAgentListeners(output, port) {
  const suffix = `:${port}`;
  const addresses = String(output)
    .split("\n")
    .map((line) => line.trim().split(/\s+/)[3] || "")
    .filter((address) => address.endsWith(suffix));

  if (addresses.length === 0) return "absent";
  const loopback = addresses.every((address) => {
    const host = address.slice(0, -suffix.length);
    return (
      host === "localhost" ||
      host === "[::1]" ||
      /^127(?:\.\d{1,3}){3}$/.test(host)
    );
  });
  return loopback ? "loopback" : "exposed";
}
