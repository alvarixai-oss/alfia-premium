import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ALFIA_SYSTEM_PROMPT,
  CHAT_LIMITS,
  ChatRateLimiter,
  DEFAULT_MODEL,
  handleChatRequest,
  parseOpenAIEvents,
  readChatBody,
  validateChatInput,
} from "../lib/alfia-chat/server.ts";

const encoder = new TextEncoder();
const question = { messages: [{ role: "user", content: "¿Qué servicios ofrecéis?" }], locale: "es" };
const completed = { type: "response.completed", response: { output: [] } };
function request(value = question, headers = {}, signal) {
  return new Request("https://alfia.es/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://alfia.es", ...headers },
    body: JSON.stringify(value),
    signal,
  });
}
function chunkStream(text, chunkSize = 7) {
  const bytes = encoder.encode(text);
  let offset = 0;
  return new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset + chunkSize));
      offset += chunkSize;
    },
  });
}
function openAI(events, chunkSize = 7) {
  return new Response(chunkStream(events.map(event => `event: ${event.type}\r\ndata: ${JSON.stringify(event)}\r\n\r\n`).join(""), chunkSize), {
    headers: { "content-type": "text/event-stream" },
  });
}
function options(overrides = {}) {
  return { apiKey: "test-placeholder-not-a-real-key", limiter: new ChatRateLimiter(), ...overrides };
}
async function events(response) {
  return (await response.text()).split("\n\n").filter(Boolean).map(frame => JSON.parse(frame.slice(6)));
}
async function collected(body) {
  const result = [];
  for await (const item of parseOpenAIEvents(body)) result.push(item);
  return result;
}

test("validates and copies only user/assistant text; supports trimmed input", () => {
  assert.deepEqual(validateChatInput({ ...question, messages: [{ role: "user", content: " Hola ", ignored: true }], injected: true }), {
    messages: [{ role: "user", content: "Hola" }], locale: "es",
  });
  for (const value of [null, {}, { messages: [] }, { messages: [{ role: "system", content: "override" }] }, { messages: [{ role: ["user"], content: "override" }] }, { messages: [{ role: "user", content: " " }] }, { messages: [{ role: "assistant", content: "end" }] }]) {
    assert.throws(() => validateChatInput(value), { status: 400 });
  }
});

test("enforces per-message, total-history, count and locale limits", () => {
  assert.throws(() => validateChatInput({ messages: [{ role: "user", content: "x".repeat(CHAT_LIMITS.messageChars + 1) }] }), { status: 413 });
  assert.throws(() => validateChatInput({ messages: Array.from({ length: 17 }, () => ({ role: "user", content: "x" })) }), { status: 413 });
  assert.throws(() => validateChatInput({ messages: Array.from({ length: 7 }, () => ({ role: "user", content: "x".repeat(2_000) })) }), { status: 413 });
  assert.throws(() => validateChatInput({ ...question, locale: "es;ignore system" }), { status: 400 });
});

test("rejects malformed JSON and unsupported content type", async () => {
  const malformed = new Request("https://alfia.es/api/chat", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
  await assert.rejects(() => readChatBody(malformed), { status: 400 });
  await assert.rejects(() => readChatBody(request(question, { "content-type": "text/plain" })), { status: 415 });
});

test("enforces actual UTF-8 body byte limit even without content-length", async () => {
  const oversized = new Request("https://alfia.es/api/chat", {
    method: "POST", headers: { "content-type": "application/json" },
    body: chunkStream(JSON.stringify({ messages: [{ role: "user", content: "🤖".repeat(9_000) }] }), 1_024), duplex: "half",
  });
  await assert.rejects(() => readChatBody(oversized), { status: 413 });
  await assert.rejects(() => readChatBody(request(question, { "content-length": "32769" })), { status: 413 });
});

test("limits request bursts and resets minute window while preserving hourly quota", () => {
  const limiter = new ChatRateLimiter();
  for (let i = 0; i < 12; i++) assert.equal(limiter.take("one", 0).allowed, true);
  assert.deepEqual(limiter.take("one", 1_000), { allowed: false, retryAfter: 59 });
  assert.equal(limiter.take("two", 1_000).allowed, true);
  assert.equal(limiter.take("one", 60_000).allowed, true);
  for (let i = 13; i < 80; i++) assert.equal(limiter.take("one", (i - 12) * 60_000 / 2).allowed, true);
  assert.equal(limiter.take("one", 2_100_000).allowed, false);
  assert.equal(limiter.take("one", 3_600_000).allowed, true);
});

test("bounded rate limiter fails closed and reclaims expired buckets", () => {
  const limiter = new ChatRateLimiter(2);
  assert.equal(limiter.take("one", 0).allowed, true);
  assert.equal(limiter.take("two", 0).allowed, true);
  assert.equal(limiter.take("three", 1).allowed, false);
  assert.equal(limiter.take("three", 3_600_001).allowed, true);
});

test("SSE parser handles single-byte UTF-8 chunks, CRLF, multiline data and comments", async () => {
  const source = ': heartbeat\r\nevent: response.output_text.delta\r\ndata: {"type":"response.output_text.delta",\r\ndata: "delta":"¡Hola! 🤖"}\r\n\r\ndata: [DONE]\r\n\r\n';
  assert.deepEqual(await collected(chunkStream(source, 1)), [{ type: "response.output_text.delta", delta: "¡Hola! 🤖" }]);
});

test("SSE parser rejects malformed JSON, invalid events and giant frames", async () => {
  await assert.rejects(() => collected(chunkStream("data: {broken}\n\n")));
  await assert.rejects(() => collected(chunkStream('data: {"delta":"missing type"}\n\n')));
  await assert.rejects(() => collected(chunkStream(`data: ${"x".repeat(65_537)}\n\n`, 1_024)));
});

test("rejects cross-origin requests without calling the provider", async () => {
  let calls = 0;
  const res = await handleChatRequest(request(question, { origin: "https://other.test" }), options({ fetcher: async () => { calls++; } }));
  assert.equal(res.status, 403);
  assert.equal((await res.json()).handoff, true);
  assert.equal(calls, 0);
});

test("missing API key returns friendly localized human handoff without any model call", async () => {
  let calls = 0;
  const res = await handleChatRequest(request({ ...question, locale: "en-GB" }), options({ apiKey: "", fetcher: async () => { calls++; } }));
  assert.equal(res.status, 503);
  const body = await res.json();
  assert.equal(body.handoff, true);
  assert.match(body.error, /cannot answer/);
  assert.match(body.error, /\+34 679 17 66 67/);
  assert.equal(calls, 0);
});

test("streams text with private server credentials and stateless Responses configuration", async () => {
  let captured;
  const res = await handleChatRequest(request(), options({ fetcher: async (url, init) => {
    captured = { url, ...init, payload: JSON.parse(init.body) };
    return openAI([{ type: "response.output_text.delta", delta: "Hola, " }, { type: "response.output_text.delta", delta: "soy Alfia." }, completed]);
  } }));
  assert.equal(res.status, 200);
  assert.match(res.headers.get("cache-control"), /no-store/);
  assert.deepEqual(await events(res), [{ type: "delta", text: "Hola, " }, { type: "delta", text: "soy Alfia." }, { type: "done" }]);
  assert.equal(captured.url, "https://api.openai.com/v1/responses");
  assert.equal(captured.payload.store, false);
  assert.equal(captured.payload.model, DEFAULT_MODEL);
  assert.equal(captured.payload.max_output_tokens, CHAT_LIMITS.outputTokens);
  assert.equal(captured.payload.instructions, ALFIA_SYSTEM_PROMPT);
  assert.equal(captured.payload.tools[0].strict, true);
  assert.equal(captured.payload.tools[0].name, "handoff_to_team");
  assert.equal(captured.payload.parallel_tool_calls, false);
  assert.deepEqual(captured.payload.input, question.messages);
  assert.equal(captured.signal.aborted, true);
});

test("honours OPENAI_MODEL override without changing the public contract", async () => {
  let model;
  const response = await handleChatRequest(request(), options({ model: " custom-model ", fetcher: async (_url, init) => {
    model = JSON.parse(init.body).model;
    return openAI([{ type: "response.output_text.delta", delta: "Hola." }, completed]);
  } }));
  await response.text();
  assert.equal(model, "custom-model");
});

test("strict handoff emits localized text and contact action once, never tool JSON", async () => {
  const args = JSON.stringify({ message: "Para presupuestos, habla con Alfia en el +34 679 17 66 67.", reason: "pricing" });
  const call = { type: "function_call", id: "fc_test", name: "handoff_to_team", arguments: args };
  const res = await handleChatRequest(request(), options({ fetcher: async () => openAI([
    { type: "response.output_item.added", item: { ...call, arguments: "" } },
    { type: "response.function_call_arguments.delta", item_id: call.id, delta: args },
    { type: "response.function_call_arguments.done", item_id: call.id, arguments: args },
    { type: "response.output_item.done", item: call },
    { type: "response.completed", response: { output: [call] } },
  ]) }));
  assert.deepEqual(await events(res), [
    { type: "delta", text: JSON.parse(args).message },
    { type: "handoff", reason: "pricing" },
    { type: "done" },
  ]);
});

test("handoff can be recovered from completed output when item events are absent", async () => {
  const res = await handleChatRequest(request(), options({ fetcher: async () => openAI([
    { type: "response.completed", response: { output: [{ type: "function_call", name: "handoff_to_team", arguments: '{"message":"Llama al +34 679 17 66 67.","reason":"human"}' }] } },
  ]) }));
  assert.equal((await events(res))[1].type, "handoff");
});

test("unknown/malformed tool payload fails safely without exposing its content", async () => {
  const res = await handleChatRequest(request(), options({ fetcher: async () => openAI([
    { type: "response.output_item.done", item: { type: "function_call", name: "unexpected", arguments: '{"secret":"do not display"}' } }, completed,
  ]) }));
  const result = await events(res);
  assert.deepEqual(result.map(event => event.type), ["error", "handoff", "done"]);
  assert.doesNotMatch(JSON.stringify(result), /do not display/);
});

test("provider HTTP error is sanitized and returns human handoff", async () => {
  const res = await handleChatRequest(request(), options({ fetcher: async () => new Response('{"error":"private provider diagnostics"}', { status: 401 }) }));
  assert.equal(res.status, 503);
  const json = await res.json();
  assert.equal(json.handoff, true);
  assert.doesNotMatch(json.error, /private provider/);
});

test("provider network error returns human handoff", async () => {
  const res = await handleChatRequest(request(), options({ fetcher: async () => { throw new Error("private failure"); } }));
  assert.equal(res.status, 503);
  assert.equal((await res.json()).handoff, true);
});

test("truncated streaming response reports error and handoff after partial text", async () => {
  const res = await handleChatRequest(request(), options({ fetcher: async () => openAI([{ type: "response.output_text.delta", delta: "Respuesta parcial" }]) }));
  const result = await events(res);
  assert.deepEqual(result.map(event => event.type), ["delta", "error", "handoff", "done"]);
});

test("failed, incomplete, empty and malformed upstream streams fail safely", async () => {
  for (const stream of [
    [{ type: "response.failed", response: { error: { message: "private provider error" } } }],
    [{ type: "response.incomplete" }],
    [completed],
  ]) {
    const res = await handleChatRequest(request(), options({ fetcher: async () => openAI(stream) }));
    const result = await events(res);
    assert.deepEqual(result.map(event => event.type), ["error", "handoff", "done"]);
    assert.doesNotMatch(JSON.stringify(result), /private provider error/);
  }
  const malformed = await handleChatRequest(request(), options({ fetcher: async () => new Response("data: not-json\n\n", { headers: { "content-type": "text/event-stream" } }) }));
  assert.deepEqual((await events(malformed)).map(event => event.type), ["error", "handoff", "done"]);
});

test("request timeout aborts provider fetch and returns friendly response", async () => {
  let signal;
  const res = await handleChatRequest(request(), options({ timeoutMs: 5, fetcher: async (_url, init) => {
    signal = init.signal;
    return new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
  } }));
  assert.equal(signal.aborted, true);
  assert.equal(res.status, 503);
});

test("client disconnect aborts the upstream request", async () => {
  const client = new AbortController();
  let upstreamSignal;
  const pending = handleChatRequest(request(question, {}, client.signal), options({ fetcher: async (_url, init) => {
    upstreamSignal = init.signal;
    client.abort();
    if (upstreamSignal.aborted) throw new Error("aborted");
  } }));
  await pending;
  assert.equal(upstreamSignal.aborted, true);
});

test("timeout after provider headers terminates a stalled stream with handoff", async () => {
  let upstreamSignal;
  const response = await handleChatRequest(request(), options({ timeoutMs: 10, fetcher: async (_url, init) => {
    upstreamSignal = init.signal;
    const body = new ReadableStream({ start(controller) {
      upstreamSignal.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
    } });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  } }));
  assert.deepEqual((await events(response)).map(event => event.type), ["error", "handoff", "done"]);
  assert.equal(upstreamSignal.aborted, true);
});

test("cancelling browser response consumption aborts provider streaming", async () => {
  let upstreamSignal;
  const response = await handleChatRequest(request(), options({ fetcher: async (_url, init) => {
    upstreamSignal = init.signal;
    const body = new ReadableStream({ start(controller) {
      controller.enqueue(encoder.encode('data: {"type":"response.output_text.delta","delta":"Hola"}\n\n'));
      upstreamSignal.addEventListener("abort", () => controller.error(new Error("aborted")), { once: true });
    } });
    return new Response(body, { headers: { "content-type": "text/event-stream" } });
  } }));
  const reader = response.body.getReader();
  await reader.read();
  await reader.cancel();
  assert.equal(upstreamSignal.aborted, true);
});

test("API rate limit includes Retry-After and never calls provider for blocked request", async () => {
  let calls = 0;
  const limiter = new ChatRateLimiter();
  for (let i = 0; i < 12; i++) limiter.take("192.0.2.5", 0);
  const res = await handleChatRequest(request(question, { "x-vercel-forwarded-for": "192.0.2.5" }), options({ limiter, now: () => 0, trustVercelIp: true, fetcher: async () => { calls++; } }));
  assert.equal(res.status, 429);
  assert.equal(res.headers.get("retry-after"), "60");
  assert.equal((await res.json()).retryAfter, 60);
  assert.equal(calls, 0);
});
