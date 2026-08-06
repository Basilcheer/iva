#!/usr/bin/env node
// Telegram long-polling bridge → local eve webhook route.
//
//   node --env-file=.env scripts/telegram-poll.mjs
//
// The eve Telegram channel works ONLY via webhook (POST /eve/v1/telegram, validating
// the X-Telegram-Bot-Api-Secret-Token header). On a bare VPS there is no public HTTPS,
// so we fetch updates from Telegram ourselves (getUpdates, long-poll) and POST them to
// the local eve route with the same secret — Telegram sees an ordinary bot, no proxy needed.
// The channel/agent are unchanged. Webhook and polling are mutually exclusive → deleteWebhook on start.
//
// Thin compat shim: the implementation lives in scripts/poller/*.mjs (see there for the
// module breakdown). This file only re-exports the public surface and keeps the
// direct-execution guard so `node scripts/telegram-poll.mjs` still works unchanged.
import { fileURLToPath } from "node:url";
import { readCappedStream } from "./poller/transport.ts";
import {
  loadQueue,
  writeQueueAtomic,
  completeScopedResetState,
  persistPrivateResetIntent,
  loadPrivateResetIntents,
  clearPrivateResetIntent,
  releaseScopedContinuation,
  performScopedReset,
  reconcileScopedResetIntents,
  reapStaleRuns,
} from "./poller/queue.mjs";
import { routeMessageUpdate, drainReadyQueueHeads } from "./poller/routing.mjs";
import {
  handleUpdateCheck,
  handleUpdateCallback,
} from "./poller/update-flow.mjs";
import {
  runWizardRequest,
  isStaleWizard,
  wizardActionAllowed,
  selectWizardModel,
  selectWizardEffort,
  selectableWizardOptions,
  resolveThinkCatalogLoad,
  validateAndSaveWizard,
  resetMessageCopy,
} from "./poller/wizards.mjs";
import { handleAwaitNonText } from "./poller/control.mjs";
import { main } from "./poller/main.mjs";

export {
  readCappedStream,
  loadQueue,
  writeQueueAtomic,
  completeScopedResetState,
  persistPrivateResetIntent,
  loadPrivateResetIntents,
  clearPrivateResetIntent,
  releaseScopedContinuation,
  performScopedReset,
  reconcileScopedResetIntents,
  reapStaleRuns,
  routeMessageUpdate,
  drainReadyQueueHeads,
  handleUpdateCheck,
  handleUpdateCallback,
  runWizardRequest,
  isStaleWizard,
  wizardActionAllowed,
  selectWizardModel,
  selectWizardEffort,
  selectableWizardOptions,
  resolveThinkCatalogLoad,
  validateAndSaveWizard,
  resetMessageCopy,
  handleAwaitNonText,
};

if (fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => {
    console.error("telegram-poll fatal:", e);
    process.exit(1);
  });
}
