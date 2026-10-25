import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import { pinImageToRelease } from "./image-release.mjs";

test("pins a registry image to the release tag", () => {
  assert.equal(
    pinImageToRelease(
      "tinyagent-registry.cn-shanghai.cr.aliyuncs.com/baozhifei/tinyagent-api:demo",
      "9faf009",
    ),
    "tinyagent-registry.cn-shanghai.cr.aliyuncs.com/baozhifei/tinyagent-api:9faf009",
  );
});

test("publishes both the compatibility tag and the commit tag", () => {
  const workflow = fs.readFileSync(
    new URL("../.github/workflows/publish-images.yml", import.meta.url),
    "utf8",
  );

  assert.match(workflow, /tinyagent-api:demo/);
  assert.match(workflow, /tinyagent-api:\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /tinyagent-web:\$\{\{ github\.sha \}\}/);
  assert.match(workflow, /tinyagent-agent:\$\{\{ github\.sha \}\}/);
});
