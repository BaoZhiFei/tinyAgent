import assert from "node:assert/strict";
import test from "node:test";

import { rdsServiceLinkedRoleWaitOptions } from "./rds-service-linked-role.mjs";

test("RDS service-linked role wait lasts long enough for propagation", () => {
  assert.deepEqual(rdsServiceLinkedRoleWaitOptions(), {
    createDuration: "60s",
    deleteDuration: "0s",
  });
});
