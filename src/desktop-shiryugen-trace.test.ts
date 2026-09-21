import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createShiryuGenTraceProvider } from "./desktop-shiryugen-trace.js";

function ns(iso: string): string {
  return String(BigInt(Date.parse(iso)) * 1_000_000n);
}

function record(input: {
  traceId: string;
  stage: string;
  startedAt: string;
  action?: "generate" | "regenerate" | "edit";
  details?: Record<string, unknown>;
  durationMs?: number;
}): string {
  const durationMs = input.durationMs ?? 5;
  return JSON.stringify({
    type: "effect-span",
    name: `shiryugen.generation.${input.stage}`,
    traceId: `effect-${input.traceId}-${input.stage}`,
    spanId: `span-${input.stage}`,
    sampled: true,
    kind: "internal",
    startTimeUnixNano: ns(input.startedAt),
    endTimeUnixNano: String(BigInt(ns(input.startedAt)) + BigInt(durationMs) * 1_000_000n),
    durationMs,
    attributes: {
      "shiryugen.generation.trace_id": input.traceId,
      "shiryugen.generation.action": input.action ?? "generate",
      "shiryugen.generation.stage": input.stage,
      ...(input.details ?? {}),
    },
    events: [],
    links: [],
    exit: { _tag: "Success" },
  });
}

test("ShiryuGen trace reader correlates stages across rotation and redacts prompt text", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-shiryugen-trace-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const logs = join(root, "logs");
  await mkdir(logs);
  const base = join(logs, "server.trace.ndjson");
  const traceId = "shiryugen-generate-fixture-001";

  await writeFile(`${base}.1`, [
    record({
      traceId,
      stage: "request.received",
      startedAt: "2026-09-20T12:00:00.000Z",
      details: {
        "shiryugen.detail.prompt": "secret source prompt",
        "shiryugen.detail.requestText": "secret request",
        "shiryugen.detail.character": "Kashiro",
      },
    }),
    record({
      traceId,
      stage: "prompt.compiled",
      startedAt: "2026-09-20T12:00:00.100Z",
      details: {
        "shiryugen.detail.rendererPrompt": "secret renderer prompt",
        "shiryugen.detail.negativePrompt": "secret negative prompt",
        "shiryugen.detail.modelProfile": "nova-anime-illustrious",
        "shiryugen.detail.policyVersion": "shiryugen-policy-v2",
      },
    }),
  ].join("\n") + "\n");

  await writeFile(base, [
    record({
      traceId,
      stage: "comfyui.queued",
      startedAt: "2026-09-20T12:00:01.000Z",
      details: { "shiryugen.detail.promptId": "prompt-abc" },
    }),
    record({
      traceId,
      stage: "comfyui.progress",
      startedAt: "2026-09-20T12:00:02.000Z",
      details: {
        "shiryugen.detail.promptId": "prompt-abc",
        "shiryugen.detail.pollAttempt": 20,
        "shiryugen.detail.state": "running",
      },
    }),
    record({
      traceId,
      stage: "renderer.completed",
      startedAt: "2026-09-20T12:00:05.000Z",
      details: {
        "shiryugen.detail.outputPath": "/tmp/generated_images/kashiro.png",
        "shiryugen.detail.seed": 1234,
        "shiryugen.detail.width": 768,
        "shiryugen.detail.height": 1024,
        "shiryugen.detail.engine": "comfyui",
      },
    }),
    record({
      traceId,
      stage: "attachment.persisted",
      startedAt: "2026-09-20T12:00:05.200Z",
      details: {
        "shiryugen.detail.attachmentId": "generated-image-1",
        "shiryugen.detail.durablePath": "/tmp/attachments/generated-image-1.png",
        "shiryugen.detail.generatorOutputPath": "/tmp/generated_images/kashiro.png",
        "shiryugen.detail.sizeBytes": 1000,
      },
    }),
  ].join("\n") + "\n");

  const provider = createShiryuGenTraceProvider({ allowedRoots: [root], basePaths: [base] });
  const trace = await provider(traceId);

  assert.equal(trace.found, true);
  assert.equal(trace.state, "completed");
  assert.equal(trace.action, "generate");
  assert.equal(trace.promptId, "prompt-abc");
  assert.equal(trace.outputPath, "/tmp/generated_images/kashiro.png");
  assert.equal(trace.durablePath, "/tmp/attachments/generated-image-1.png");
  assert.equal(trace.attachmentId, "generated-image-1");
  assert.deepEqual(trace.stages.map((stage) => stage.stage), [
    "request.received",
    "prompt.compiled",
    "comfyui.queued",
    "comfyui.progress",
    "renderer.completed",
    "attachment.persisted",
  ]);
  assert.deepEqual(trace.sourceFiles, [base, `${base}.1`]);
  assert.equal(trace.stages[0]?.details.character, "Kashiro");
  assert.equal(trace.stages[1]?.details.modelProfile, "nova-anime-illustrious");
  const serialized = JSON.stringify(trace);
  assert.equal(serialized.includes("secret source prompt"), false);
  assert.equal(serialized.includes("secret request"), false);
  assert.equal(serialized.includes("secret renderer prompt"), false);
  assert.equal(serialized.includes("secret negative prompt"), false);
});

test("ShiryuGen trace reader resolves the newest retained generation when traceId is omitted", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-shiryugen-latest-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, "server.trace.ndjson");
  await writeFile(base, [
    record({ traceId: "shiryugen-generate-old", stage: "request.received", startedAt: "2026-09-20T10:00:00.000Z" }),
    record({ traceId: "shiryugen-edit-new", stage: "request.received", action: "edit", startedAt: "2026-09-20T11:00:00.000Z" }),
    record({ traceId: "shiryugen-edit-new", stage: "renderer.failed", action: "edit", startedAt: "2026-09-20T11:00:01.000Z", details: { "shiryugen.detail.reason": "fixture failure" } }),
  ].join("\n") + "\n");

  const provider = createShiryuGenTraceProvider({ allowedRoots: [root], basePaths: [base] });
  const trace = await provider();
  assert.equal(trace.traceId, "shiryugen-edit-new");
  assert.equal(trace.action, "edit");
  assert.equal(trace.state, "failed");
  assert.equal(trace.stages.at(-1)?.details.reason, "fixture failure");
});

test("ShiryuGen trace reader rejects invalid IDs and ignores rotated symlink escapes", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-shiryugen-root-"));
  const outside = await mkdtemp(join(tmpdir(), "devspace-shiryugen-outside-"));
  t.after(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });
  const base = join(root, "server.trace.ndjson");
  const escaped = join(outside, "escaped.ndjson");
  const traceId = "shiryugen-regenerate-outside";
  await writeFile(base, "");
  await writeFile(escaped, record({ traceId, stage: "request.received", action: "regenerate", startedAt: "2026-09-20T12:00:00.000Z" }) + "\n");
  await symlink(escaped, `${base}.1`);

  const provider = createShiryuGenTraceProvider({ allowedRoots: [root], basePaths: [base] });
  await assert.rejects(() => provider("not-a-shiryugen-trace"), /traceId must be/);
  const trace = await provider(traceId);
  assert.equal(trace.found, false);
  assert.equal(trace.sourceFiles.includes(`${base}.1`), false);
});

test("ShiryuGen trace reader ignores malformed NDJSON lines safely", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-shiryugen-malformed-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, "server.trace.ndjson");
  const traceId = "shiryugen-generate-after-malformed";
  await writeFile(base, [
    "{not-json",
    JSON.stringify(["also", "not", "a", "record"]),
    record({ traceId, stage: "request.received", startedAt: "2026-09-20T12:30:00.000Z" }),
    "",
  ].join("\n"));

  const provider = createShiryuGenTraceProvider({ allowedRoots: [root], basePaths: [base] });
  const trace = await provider(traceId);
  assert.equal(trace.found, true);
  assert.deepEqual(trace.stages.map((stage) => stage.stage), ["request.received"]);
});

test("ShiryuGen trace reader applies the retained-file cap globally across log roots", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-shiryugen-multiroot-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const userdataDir = join(root, "userdata");
  const devDir = join(root, "dev");
  await mkdir(userdataDir);
  await mkdir(devDir);
  const userdataBase = join(userdataDir, "server.trace.ndjson");
  const devBase = join(devDir, "server.trace.ndjson");
  const traceId = "shiryugen-generate-newer-root";

  await writeFile(userdataBase, `${"x".repeat(1100)}\n`);
  await writeFile(devBase, `${record({
    traceId,
    stage: "request.received",
    startedAt: "2026-09-20T13:30:00.000Z",
  })}\n`);
  await utimes(userdataBase, new Date("2026-09-20T13:00:00.000Z"), new Date("2026-09-20T13:00:00.000Z"));
  await utimes(devBase, new Date("2026-09-20T13:30:00.000Z"), new Date("2026-09-20T13:30:00.000Z"));

  const provider = createShiryuGenTraceProvider({
    allowedRoots: [root],
    basePaths: [userdataBase, devBase],
    maxFiles: 1,
    maxTotalBytes: 1024,
  });
  const trace = await provider(traceId);
  assert.equal(trace.found, true);
  assert.deepEqual(trace.sourceFiles, [devBase]);
});

test("ShiryuGen trace reader bounds retained files and byte scanning", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "devspace-shiryugen-bounds-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const base = join(root, "server.trace.ndjson");
  const rotatedOnlyTrace = "shiryugen-generate-rotated-only";
  await writeFile(base, `${"x".repeat(1100)}\n${record({
    traceId: "shiryugen-generate-beyond-budget",
    stage: "request.received",
    startedAt: "2026-09-20T13:00:00.000Z",
  })}\n`);
  await writeFile(`${base}.1`, `${record({
    traceId: rotatedOnlyTrace,
    stage: "request.received",
    startedAt: "2026-09-20T12:59:00.000Z",
  })}\n`);
  await utimes(`${base}.1`, new Date("2026-09-20T13:00:00.000Z"), new Date("2026-09-20T13:00:00.000Z"));
  await utimes(base, new Date("2026-09-20T14:00:00.000Z"), new Date("2026-09-20T14:00:00.000Z"));

  const byteBounded = createShiryuGenTraceProvider({
    allowedRoots: [root],
    basePaths: [base],
    maxTotalBytes: 1024,
  });
  const beyondBudget = await byteBounded("shiryugen-generate-beyond-budget");
  assert.equal(beyondBudget.found, false);
  assert.ok(beyondBudget.bytesScanned <= 1101, `unexpected scan size: ${beyondBudget.bytesScanned}`);

  const fileBounded = createShiryuGenTraceProvider({
    allowedRoots: [root],
    basePaths: [base],
    maxFiles: 1,
  });
  const omittedRotation = await fileBounded(rotatedOnlyTrace);
  assert.equal(omittedRotation.found, false);
  assert.equal(omittedRotation.sourceFiles.includes(`${base}.1`), false);
});
