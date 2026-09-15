function textOnlyContent(content, acceptedTypes) {
  if (!Array.isArray(content) || content.length === 0) return undefined;
  if (!content.every((part) => (
    part &&
    typeof part === "object" &&
    !Array.isArray(part) &&
    acceptedTypes.has(part.type) &&
    typeof part.text === "string" &&
    Object.keys(part).every((key) => key === "type" || key === "text")
  ))) return undefined;
  return content.map((part) => part.text).join("");
}

// OpenCode Go's Qwen3.8 Flash Messages endpoint currently 500s on an
// Anthropic message whose content is a text-only block array, even though the
// equivalent string form succeeds. LiteLLM creates that array when a caller
// uses structured Responses input, so normalize the lossless text-only content
// before that conversion as well as an already-converted Messages payload.
// Mixed text/tool/image content and every other model stay untouched.
export function normalizeQwenFlashMessagesText(payload, provider, model) {
  if (
    provider?.id !== "opencode-go-messages" ||
    model?.upstreamModel !== "qwen3.8-flash"
  ) return false;

  let changed = false;
  if (Array.isArray(payload?.input)) {
    let inputChanged = false;
    const input = payload.input.map((item) => {
      const text = textOnlyContent(
        item?.content,
        new Set(["input_text", "output_text", "text"]),
      );
      if (text === undefined) return item;
      changed = inputChanged = true;
      return { ...item, content: text };
    });
    if (inputChanged) payload.input = input;
  }
  if (Array.isArray(payload?.messages)) {
    let messagesChanged = false;
    const messages = payload.messages.map((message) => {
      const text = textOnlyContent(message?.content, new Set(["text"]));
      if (text === undefined) return message;
      changed = messagesChanged = true;
      return { ...message, content: text };
    });
    if (messagesChanged) payload.messages = messages;
  }
  return changed;
}
