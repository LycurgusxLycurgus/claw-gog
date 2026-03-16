export function decideAction(message: string) {
  const text = message.trim().toLowerCase();

  if (
    text === "/confirm" ||
    text === "/cancel" ||
    text.includes("set up ") ||
    text.includes("setup ") ||
    text.includes("schedule ") ||
    text.includes("book ") ||
    text.includes("add ") ||
    text.includes("create ") ||
    text.includes("meeting") ||
    text.includes("call with") ||
    text.includes("invite ")
  ) {
    return { mode: "mutate", needsConfirmation: true } as const;
  }

  if (
    text.startsWith("/agenda") ||
    text.startsWith("/calendar") ||
    text.startsWith("/today") ||
    text.startsWith("/tomorrow") ||
    text.startsWith("/week") ||
    text.includes("week") ||
    text.includes("schedule") ||
    text.includes("what do i have") ||
    text.includes("what events") ||
    text.includes("my schedule") ||
    text.includes("calendar") ||
    text.includes("agenda") ||
    text.includes("tomorrow") ||
    text.includes("today")
  ) {
    return { mode: "read", needsConfirmation: false } as const;
  }

  if (text.includes("move ") || text.includes("delete ")) {
    return { mode: "mutate", needsConfirmation: true } as const;
  }

  return { mode: "chat", needsConfirmation: false } as const;
}
