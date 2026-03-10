import test from "node:test";
import assert from "node:assert/strict";

import { getEnv } from "../../convex/app/env.ts";

test("env validation fails loudly when required vars are missing", () => {
  assert.throws(() => getEnv({}), /Invalid environment/);
});
