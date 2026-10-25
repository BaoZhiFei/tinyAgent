import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("does not patch the addon-managed sandbox manager ingress", () => {
  const source = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  assert.doesNotMatch(source, /new k8s\.networking\.v1\.IngressPatch\(/);
});
