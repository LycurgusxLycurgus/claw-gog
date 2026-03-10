import test from "node:test";
import assert from "node:assert/strict";

import { decideAction } from "../../convex/assistant/decide.ts";
import { normalizeUpdate } from "../../convex/telegram/normalizeUpdate.ts";

test("decideAction marks mutation text as confirmation-gated", () => {
  assert.deepEqual(decideAction("move my 3pm call to 4pm"), {
    mode: "mutate",
    needsConfirmation: true,
  });
});

test("normalizeUpdate extracts the telegram fields BridgeClaw needs", () => {
  const normalized = normalizeUpdate({
    message: {
      message_id: 10,
      text: "/agenda",
      chat: { id: 20 },
      from: { id: 30, username: "operator" },
    },
  });

  assert.deepEqual(normalized, {
    chatId: "20",
    messageId: "10",
    text: "/agenda",
    userId: "30",
    username: "operator",
  });
});
