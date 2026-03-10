import { action } from "../_generated/server";
import { v } from "convex/values";
import { decideAction } from "../assistant/decide";
import { composePrompt } from "../assistant/composePrompt";
import { askGemini } from "../ai/gemini";

export const ingestTelegramMessage = action({
  args: {
    chatId: v.string(),
    text: v.string(),
  },
  handler: async (_ctx, args) => {
    const decision = decideAction(args.text);

    if (decision.mode === "chat") {
      const prompt = composePrompt({
        nowIso: new Date().toISOString(),
        timezone: "America/Bogota",
        transcript: [],
        message: args.text,
      });
      return { mode: decision.mode, text: await askGemini(prompt) };
    }

    if (decision.mode === "read") {
      return { mode: decision.mode, text: "Read flow wired. Calendar lookup is next." };
    }

    return { mode: decision.mode, text: "Draft flow wired. Mutation confirmation gate is next." };
  },
});
