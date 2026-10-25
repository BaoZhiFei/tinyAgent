import { expect, it } from "vitest";
import { normalizeMessage } from "./message";

// 后端历史消息和浏览器临时消息字段形状不同，边界函数要把两种都统一起来。
it("normalizes stored and in-progress message fields", () => {
  expect(normalizeMessage({ Role: "user", Text: "hello" })).toMatchObject({
    role: "user",
    text: "hello",
  });
  expect(normalizeMessage({ role: "assistant", text: "hi" })).toMatchObject({
    role: "assistant",
    text: "hi",
  });
});
