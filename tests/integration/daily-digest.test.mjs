import test from "node:test";
import assert from "node:assert/strict";

import { formatDigest } from "../../convex/calendar/formatDigest.ts";

test("formatDigest groups events into a readable agenda", () => {
  const text = formatDigest(
    [
      { summary: "Dentist", start: "2026-03-11T14:00:00-05:00", location: "Downtown" },
      { summary: "Dinner", start: "2026-03-11T19:00:00-05:00" },
    ],
    { locale: "en", timeZone: "America/Bogota" }
  );

  assert.match(text, /Next 7 days/);
  assert.match(text, /Dentist/);
  assert.match(text, /Dinner/);
});
