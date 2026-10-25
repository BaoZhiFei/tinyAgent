import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

test("binds the deployment VPC to the ACR private endpoint", () => {
  const source = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  assert.match(source, /new alicloud\.cr\.VpcEndpointLinkedVpc\(/);
  assert.match(source, /tinyagent-acr-vpc-endpoint/);
  assert.match(source, /tinyagent-registry-vpc\.cn-shanghai\.cr\.aliyuncs\.com/);
});

test("forces the ACR ConfigMap patch through ACK.RC field ownership", () => {
  const source = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");
  const patchStart = source.indexOf("new k8s.core.v1.ConfigMapPatch(");
  const patchEnd = source.indexOf("\n);", patchStart);
  const configMapPatch = source.slice(patchStart, patchEnd);

  assert.match(configMapPatch, /"pulumi\.com\/patchForce": "true"/);
});

test("installs the ACR helper before patching its configuration", () => {
  const source = fs.readFileSync(new URL("./index.ts", import.meta.url), "utf8");

  assert.match(source, /new alicloud\.cs\.KubernetesAddon\(\s*"tinyagent-acr-credential-helper"/s);
  assert.match(source, /tokenMode: "managedRole"/);
  assert.match(source, /dependsOn: \[cluster, acrVpcEndpoint, acrCredentialHelperAddon\]/);
});
