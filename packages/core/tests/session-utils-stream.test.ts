import assert from "assert";
import test from "node:test";
import { writeFileSync, unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { spawnAndCollect, spawnAndStream, spawnAndStreamNdjson } from "../src/runtime/session/utils";

test("spawnAndStream forwards stdout and stderr chunks", async () => {
  const chunks: Array<{ type: "stdout" | "stderr"; text: string }> = [];
  const script = "process.stdout.write('hello'); process.stderr.write('warn'); process.stdout.write(' world')";

  const result = await spawnAndStream(
    `node -e \"${script}\"`,
    [],
    { timeoutMs: 2_000 },
    (type, text) => {
      chunks.push({ type, text });
    }
  );

  assert.equal(result.code, 0);
  assert.equal(result.stdout, "hello world");
  assert.equal(result.stderr, "warn");
  assert.ok(chunks.some((chunk) => chunk.type === "stdout"));
  assert.ok(chunks.some((chunk) => chunk.type === "stderr"));
});

test("spawnAndStream returns aggregated output when callback omitted", async () => {
  const script = "process.stdout.write('abc'); process.stderr.write('def')";

  const streamed = await spawnAndStream(
    `node -e \"${script}\"`,
    [],
    { timeoutMs: 2_000 }
  );

  const collected = await spawnAndCollect(
    `node -e \"${script}\"`,
    [],
    { timeoutMs: 2_000 }
  );

  assert.equal(streamed.code, 0);
  assert.deepEqual(streamed, collected);
});

test("spawnAndCollect returns exit code 127 for missing command (shell mode)", async () => {
  const result = await spawnAndCollect("nonexistent_cmd_abc123", [], { timeoutMs: 5_000 });
  assert.equal(result.code, 127);
  assert.match(result.stderr, /not found/);
});

test("spawnAndCollect rejects with cwd message when directory not found", async () => {
  await assert.rejects(
    () => spawnAndCollect("echo", ["hi"], { cwd: "/nonexistent_dir_xyz", timeoutMs: 5_000 }),
    (error: Error) => {
      assert.match(error.message, /Working directory not found/);
      return true;
    }
  );
});

test("spawnAndStream rejects with cwd message when directory not found", async () => {
  await assert.rejects(
    () => spawnAndStream("echo", ["hi"], { cwd: "/nonexistent_dir_xyz", timeoutMs: 5_000 }),
    (error: Error) => {
      assert.match(error.message, /Working directory not found/);
      return true;
    }
  );
});

test("spawnAndStream activity-based timeout resets on output", async () => {
  // Script produces output every 200ms for 4 iterations (total ~800ms).
  // Timeout is 500ms — would fail with a wall-clock timeout, but should
  // succeed because each chunk resets the inactivity timer.
  const script = `
    let i = 0;
    const iv = setInterval(() => {
      process.stdout.write('tick' + i + '\\n');
      if (++i >= 4) { clearInterval(iv); }
    }, 200);
  `;

  const result = await spawnAndStream(
    `node -e "${script.replace(/\n/g, " ")}"`,
    [],
    { timeoutMs: 500 }
  );

  assert.equal(result.code, 0, "should complete without timeout");
  assert.ok(result.stdout.includes("tick3"), "should have received all ticks");
});

test("spawnAndStreamNdjson reassembles lines split across stdout chunks", async () => {
  const events: unknown[] = [];
  // Write a generator script to a tmp file — embedding the JS source in `-e`
  // alongside the test's own shell quoting is brittle because the inner JSON
  // strings contain both single and double quotes. The script writes
  // `{"a":1}\n{"b":` then `2}\n` (completes a line started in the first chunk)
  // then `not json\n{"c":3}\n` (verifies non-JSON lines are silently dropped).
  const scriptPath = join(tmpdir(), `ndjson-test-${Date.now()}.js`);
  writeFileSync(scriptPath, [
    `process.stdout.write('{"a":1}\\n{"b":');`,
    `setTimeout(() => process.stdout.write('2}\\n'), 30);`,
    `setTimeout(() => process.stdout.write('not json\\n{"c":3}\\n'), 60);`,
  ].join("\n"));

  try {
    const result = await spawnAndStreamNdjson(
      `node ${scriptPath}`,
      [],
      { timeoutMs: 2_000 },
      (event) => { events.push(event); }
    );

    assert.equal(result.code, 0);
    assert.deepEqual(events, [{ a: 1 }, { b: 2 }, { c: 3 }]);
  } finally {
    try { unlinkSync(scriptPath); } catch { /* best-effort */ }
  }
});

test("spawnAndStreamNdjson forwards stderr as text", async () => {
  const stderrChunks: string[] = [];
  const script = "process.stderr.write('warn1'); process.stderr.write(' warn2')";

  const result = await spawnAndStreamNdjson(
    `node -e "${script}"`,
    [],
    { timeoutMs: 2_000 },
    undefined,
    (text) => { stderrChunks.push(text); }
  );

  assert.equal(result.code, 0);
  assert.equal(result.stderr, "warn1 warn2");
  assert.ok(stderrChunks.length > 0);
});

test("spawnAndCollect activity-based timeout resets on output", async () => {
  const script = `
    let i = 0;
    const iv = setInterval(() => {
      process.stdout.write('tick' + i + '\\n');
      if (++i >= 4) { clearInterval(iv); }
    }, 200);
  `;

  const result = await spawnAndCollect(
    `node -e "${script.replace(/\n/g, " ")}"`,
    [],
    { timeoutMs: 500 }
  );

  assert.equal(result.code, 0, "should complete without timeout");
  assert.ok(result.stdout.includes("tick3"), "should have received all ticks");
});
