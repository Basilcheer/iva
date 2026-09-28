import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { dataDirSetting, resolveDataDir } from "./lib/data-dir.ts";
import { recoverInterruptedSessionState } from "./lib/wf-store.ts";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dataDir = resolveDataDir(
  root,
  dataDirSetting(process.env.ASSISTANT_DATA_DIR),
);
const recovered = recoverInterruptedSessionState(root, dataDir);
if (recovered.interrupted > 0) {
  console.log(
    `retired workflow state after ${recovered.interrupted} interrupted turn(s)`,
  );
}
