import { formatInZone } from "../shared/time";

export type DigestEvent = {
  summary: string;
  start: string;
  end?: string;
  location?: string;
};

export function formatDigest(events: DigestEvent[], options: { locale: string; timeZone: string }) {
  if (events.length === 0) {
    return "No calendar events scheduled in the next 7 days.";
  }

  const lines = ["Next 7 days", ""];
  let lastDate = "";

  for (const event of events) {
    const dateLabel = new Intl.DateTimeFormat(options.locale, {
      timeZone: options.timeZone,
      dateStyle: "full",
    }).format(new Date(event.start));

    if (dateLabel !== lastDate) {
      if (lastDate) {
        lines.push("");
      }
      lines.push(dateLabel);
      lastDate = dateLabel;
    }

    const timeLabel = formatInZone(event.start, options.timeZone, options.locale);
    const locationLabel = event.location ? ` @ ${event.location}` : "";
    lines.push(`- ${timeLabel} | ${event.summary}${locationLabel}`);
  }

  return lines.join("\n");
}
