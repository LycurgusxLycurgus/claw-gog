export function decideAction(message: string) {
  const text = message.trim().toLowerCase();

  if (text.startsWith("/agenda") || text.startsWith("/today") || text.startsWith("/tomorrow") || text.startsWith("/week")) {
    return { mode: "read", needsConfirmation: false } as const;
  }

  if (text.includes("create ") || text.includes("move ") || text.includes("delete ")) {
    return { mode: "mutate", needsConfirmation: true } as const;
  }

  return { mode: "chat", needsConfirmation: false } as const;
}
