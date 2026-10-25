import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// 本地代理必须保留浏览器实际访问的 Host 和端口，否则 WebSocket 会连错地址。
describe("local Nginx ACP proxy", () => {
  it("preserves the browser Host including its port for same-origin WebSockets", () => {
    const configuration = readFileSync(
      resolve(process.cwd(), "nginx.local.conf"),
      "utf8",
    );

    expect(configuration).toContain("proxy_set_header Host $http_host;");
  });
});
