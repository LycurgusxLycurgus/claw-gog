/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin_guards from "../admin/guards.js";
import type * as admin_sessions from "../admin/sessions.js";
import type * as ai_gemini from "../ai/gemini.js";
import type * as app_env from "../app/env.js";
import type * as assistant_applyPendingAction from "../assistant/applyPendingAction.js";
import type * as assistant_composePrompt from "../assistant/composePrompt.js";
import type * as assistant_decide from "../assistant/decide.js";
import type * as assistant_sendDailyDigest from "../assistant/sendDailyDigest.js";
import type * as assistant_sendHeartbeat from "../assistant/sendHeartbeat.js";
import type * as calendar_client from "../calendar/client.js";
import type * as calendar_deleteEvent from "../calendar/deleteEvent.js";
import type * as calendar_findEvent from "../calendar/findEvent.js";
import type * as calendar_formatDigest from "../calendar/formatDigest.js";
import type * as calendar_insertEvent from "../calendar/insertEvent.js";
import type * as calendar_listWeekAgenda from "../calendar/listWeekAgenda.js";
import type * as calendar_oauth from "../calendar/oauth.js";
import type * as calendar_updateEvent from "../calendar/updateEvent.js";
import type * as context_workspace from "../context/workspace.js";
import type * as crons from "../crons.js";
import type * as http from "../http.js";
import type * as shared_errors from "../shared/errors.js";
import type * as shared_log from "../shared/log.js";
import type * as shared_time from "../shared/time.js";
import type * as telegram_ingest from "../telegram/ingest.js";
import type * as telegram_normalizeUpdate from "../telegram/normalizeUpdate.js";
import type * as telegram_sendMessage from "../telegram/sendMessage.js";
import type * as telegram_verify from "../telegram/verify.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  "admin/guards": typeof admin_guards;
  "admin/sessions": typeof admin_sessions;
  "ai/gemini": typeof ai_gemini;
  "app/env": typeof app_env;
  "assistant/applyPendingAction": typeof assistant_applyPendingAction;
  "assistant/composePrompt": typeof assistant_composePrompt;
  "assistant/decide": typeof assistant_decide;
  "assistant/sendDailyDigest": typeof assistant_sendDailyDigest;
  "assistant/sendHeartbeat": typeof assistant_sendHeartbeat;
  "calendar/client": typeof calendar_client;
  "calendar/deleteEvent": typeof calendar_deleteEvent;
  "calendar/findEvent": typeof calendar_findEvent;
  "calendar/formatDigest": typeof calendar_formatDigest;
  "calendar/insertEvent": typeof calendar_insertEvent;
  "calendar/listWeekAgenda": typeof calendar_listWeekAgenda;
  "calendar/oauth": typeof calendar_oauth;
  "calendar/updateEvent": typeof calendar_updateEvent;
  "context/workspace": typeof context_workspace;
  crons: typeof crons;
  http: typeof http;
  "shared/errors": typeof shared_errors;
  "shared/log": typeof shared_log;
  "shared/time": typeof shared_time;
  "telegram/ingest": typeof telegram_ingest;
  "telegram/normalizeUpdate": typeof telegram_normalizeUpdate;
  "telegram/sendMessage": typeof telegram_sendMessage;
  "telegram/verify": typeof telegram_verify;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
