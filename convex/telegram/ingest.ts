import { action, internalMutation } from "../_generated/server";
import { internal } from "../_generated/api.js";
import { v } from "convex/values";
import { decideAction } from "../assistant/decide";
import { composePrompt } from "../assistant/composePrompt";
import { askGemini } from "../ai/gemini";
import { getEnv } from "../app/env";
import { sendTelegramMessage } from "./sendMessage";

export const storeTelegramTurn = internalMutation({
  args: {
    ownerKey: v.string(),
    chatId: v.string(),
    userId: v.string(),
    username: v.optional(v.string()),
    inboundText: v.string(),
    outboundText: v.string(),
    correlationId: v.string(),
  },
  handler: async (ctx, args) => {
    const now = Date.now();

    const existingConversation = await ctx.db
      .query("conversations")
      .withIndex("by_session", (query) => query.eq("sessionKey", `telegram:${args.chatId}`))
      .unique();

    const conversationId =
      existingConversation?._id ??
      (await ctx.db.insert("conversations", {
        ownerKey: args.ownerKey,
        channel: "telegram",
        externalChatId: args.chatId,
        sessionKey: `telegram:${args.chatId}`,
        status: "active",
        lastMessageAt: now,
        updatedAt: now,
      }));

    if (existingConversation) {
      await ctx.db.patch(existingConversation._id, {
        lastMessageAt: now,
        updatedAt: now,
      });
    }

    const existingAccount = await ctx.db
      .query("telegramAccounts")
      .withIndex("by_chat", (query) => query.eq("chatId", args.chatId))
      .unique();

    if (existingAccount) {
      await ctx.db.patch(existingAccount._id, {
        telegramUserId: args.userId,
        username: args.username,
        allowed: true,
        updatedAt: now,
      });
    } else {
      await ctx.db.insert("telegramAccounts", {
        ownerKey: args.ownerKey,
        telegramUserId: args.userId,
        chatId: args.chatId,
        username: args.username,
        allowed: true,
        updatedAt: now,
      });
    }

    await ctx.db.insert("messages", {
      conversationId,
      role: "user",
      text: args.inboundText,
      correlationId: args.correlationId,
      createdAt: now,
    });

    await ctx.db.insert("messages", {
      conversationId,
      role: "assistant",
      text: args.outboundText,
      correlationId: args.correlationId,
      createdAt: now,
    });

    await ctx.db.insert("runLogs", {
      ownerKey: args.ownerKey,
      correlationId: args.correlationId,
      phase: "telegram.ingest",
      status: "completed",
      summary: "Inbound Telegram message processed and reply sent",
      details: {
        chatId: args.chatId,
        userId: args.userId,
      },
      createdAt: now,
    });

    return { conversationId };
  },
});

export const ingestTelegramMessage = action({
  args: {
    chatId: v.string(),
    correlationId: v.string(),
    text: v.string(),
    userId: v.string(),
    username: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const env = getEnv();
    const decision = decideAction(args.text);
    let outboundText = "";

    if (decision.mode === "chat") {
      const prompt = composePrompt({
        nowIso: new Date().toISOString(),
        timezone: env.DEFAULT_TIMEZONE,
        transcript: [],
        message: args.text,
      });
      outboundText = await askGemini(prompt);
    }
    if (decision.mode === "read") {
      outboundText = "Agenda read is wired at the webhook. Calendar-backed answers are the next slice.";
    }
    if (decision.mode === "mutate") {
      outboundText = "Mutation drafting is wired. Confirmation-gated calendar writes are the next slice.";
    }

    await sendTelegramMessage(args.chatId, outboundText);
    await ctx.runMutation(internal.telegram.ingest.storeTelegramTurn, {
      ownerKey: env.APP_OWNER_KEY,
      chatId: args.chatId,
      userId: args.userId,
      username: args.username,
      inboundText: args.text,
      outboundText,
      correlationId: args.correlationId,
    });

    return { mode: decision.mode, text: outboundText };
  },
});
