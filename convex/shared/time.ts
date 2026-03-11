export function addDays(date: Date, days: number) {
  const value = new Date(date);
  value.setUTCDate(value.getUTCDate() + days);
  return value;
}

export function formatInZone(dateLike: string, timeZone: string, locale = "en") {
  return new Intl.DateTimeFormat(locale, {
    timeZone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(dateLike));
}

export function dateKeyInZone(dateLike: string | Date, timeZone: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(dateLike instanceof Date ? dateLike : new Date(dateLike));
}

export function formatDurationFromNow(targetDateLike: string | Date, now = new Date()) {
  const diffMs = (targetDateLike instanceof Date ? targetDateLike : new Date(targetDateLike)).getTime() - now.getTime();
  if (diffMs <= 0) {
    return "now";
  }

  const totalMinutes = Math.floor(diffMs / 60000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  if (hours <= 0) {
    return `${minutes}m`;
  }
  if (minutes === 0) {
    return `${hours}h`;
  }
  return `${hours}h ${minutes}m`;
}
