import { deleteEvent } from "../calendar/deleteEvent";
import { insertEvent } from "../calendar/insertEvent";
import { updateEvent } from "../calendar/updateEvent";

export async function applyPendingAction(accessToken: string, pendingAction: {
  actionType: "create_event" | "move_event" | "delete_event";
  calendarId: string;
  targetEventId?: string;
  draftPayload: Record<string, unknown>;
}) {
  if (pendingAction.actionType === "create_event") {
    return insertEvent(accessToken, pendingAction.draftPayload, pendingAction.calendarId);
  }
  if (pendingAction.actionType === "move_event" && pendingAction.targetEventId) {
    return updateEvent(accessToken, pendingAction.targetEventId, pendingAction.draftPayload, pendingAction.calendarId);
  }
  if (pendingAction.actionType === "delete_event" && pendingAction.targetEventId) {
    return deleteEvent(accessToken, pendingAction.targetEventId, pendingAction.calendarId);
  }
  throw new Error("Invalid pending action payload");
}
