import assert from "node:assert/strict";
import test from "node:test";

import { normalizeQwenFlashMessagesText } from "../src/qwen-messages-compat.mjs";

const provider = { id: "opencode-go-messages" };
const model = { upstreamModel: "qwen3.8-flash" };

test("Qwen Flash collapses lossless text-only Messages blocks", () => {
  const payload = {
    messages: [
      { role: "user", content: [{ type: "text", text: "one" }, { type: "text", text: " two" }] },
      { role: "assistant", content: [{ type: "text", text: "three" }], name: "worker" },
    ],
  };
  assert.equal(normalizeQwenFlashMessagesText(payload, provider, model), true);
  assert.deepEqual(payload.messages, [
    { role: "user", content: "one two" },
    { role: "assistant", content: "three", name: "worker" },
  ]);
});

test("Qwen Flash collapses lossless structured Responses text before LiteLLM conversion", () => {
  const payload = {
    input: [
      { type: "message", role: "user", content: [{ type: "input_text", text: "read the fixture" }] },
      { type: "function_call", call_id: "call-1", name: "worker_read_file", arguments: "{}" },
      { type: "function_call_output", call_id: "call-1", output: "ok" },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "done" }] },
    ],
  };
  assert.equal(normalizeQwenFlashMessagesText(payload, provider, model), true);
  assert.deepEqual(payload.input, [
    { type: "message", role: "user", content: "read the fixture" },
    { type: "function_call", call_id: "call-1", name: "worker_read_file", arguments: "{}" },
    { type: "function_call_output", call_id: "call-1", output: "ok" },
    { type: "message", role: "assistant", content: "done" },
  ]);
});

test("Qwen Flash preserves mixed and annotated Anthropic blocks", () => {
  const messages = [
    { role: "assistant", content: [
      { type: "text", text: "calling" },
      { type: "tool_use", id: "call-1", name: "worker_read_file", input: { path: "README.txt" } },
    ] },
    { role: "user", content: [{ type: "tool_result", tool_use_id: "call-1", content: "ok" }] },
    { role: "user", content: [{ type: "text", text: "cached", cache_control: { type: "ephemeral" } }] },
  ];
  const payload = { messages };
  assert.equal(normalizeQwenFlashMessagesText(payload, provider, model), false);
  assert.equal(payload.messages, messages);
});

test("Qwen Flash preserves mixed and annotated Responses blocks", () => {
  const input = [
    { type: "message", role: "user", content: [
      { type: "input_text", text: "inspect" },
      { type: "input_image", image_url: "data:image/png;base64,AA==" },
    ] },
    { type: "message", role: "user", content: [
      { type: "input_text", text: "cached", cache_control: { type: "ephemeral" } },
    ] },
  ];
  const payload = { input };
  assert.equal(normalizeQwenFlashMessagesText(payload, provider, model), false);
  assert.equal(payload.input, input);
});

test("compatibility repair is scoped to the exact provider and model", () => {
  for (const [otherProvider, otherModel] of [
    [{ id: "opencode-go-messages" }, { upstreamModel: "qwen3.8-max" }],
    [{ id: "another-messages-provider" }, { upstreamModel: "qwen3.8-flash" }],
  ]) {
    const messages = [{ role: "user", content: [{ type: "text", text: "unchanged" }] }];
    const payload = { messages };
    assert.equal(normalizeQwenFlashMessagesText(payload, otherProvider, otherModel), false);
    assert.equal(payload.messages, messages);
  }
});
