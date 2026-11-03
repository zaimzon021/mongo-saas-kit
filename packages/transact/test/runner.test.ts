import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  withTransaction,
  createTransactionRunner,
  TransactionAbortedError,
  TransactionRetriesExhaustedError,
  TransactionTimeoutError,
} from "../src/index";
import type { TransactionClient, TransactionSession } from "../src/index";

function transientError(): Error {
  const error = new Error("TransientTransactionError") as Error & { errorLabels: string[] };
  error.errorLabels = ["TransientTransactionError"];
  return error;
}

class FakeSession implements TransactionSession {
  started = false;
  committed = false;
  aborted = false;
  ended = false;
  async startTransaction(): Promise<void> {
    this.started = true;
  }
  async commitTransaction(): Promise<void> {
    this.committed = true;
  }
  async abortTransaction(): Promise<void> {
    this.aborted = true;
  }
  async endSession(): Promise<void> {
    this.ended = true;
  }
}

class FakeClient implements TransactionClient {
  sessions: FakeSession[] = [];
  async startSession(): Promise<FakeSession> {
    const session = new FakeSession();
    this.sessions.push(session);
    return session;
  }
}

describe("withTransaction", () => {
  it("commits and always ends the session on success", async () => {
    const client = new FakeClient();
    const value = await withTransaction(client, async (session) => {
      assert.equal(session instanceof FakeSession, true);
      return 42;
    });
    assert.equal(value, 42);
    assert.equal(client.sessions[0].committed, true);
    assert.equal(client.sessions[0].aborted, false);
    assert.equal(client.sessions[0].ended, true);
  });

  it("aborts, ends the session, and preserves the original error", async () => {
    const client = new FakeClient();
    const original = new Error("validation failed");
    await assert.rejects(
      withTransaction(client, async () => {
        throw original;
      }),
      (error: unknown) => {
        assert.ok(error instanceof TransactionAbortedError);
        assert.equal((error as TransactionAbortedError).cause, original);
        return true;
      },
    );
    assert.equal(client.sessions[0].aborted, true);
    assert.equal(client.sessions[0].ended, true);
  });

  it("retries a transient error once and then succeeds", async () => {
    const client = new FakeClient();
    let calls = 0;
    let retries = 0;
    const value = await withTransaction(
      client,
      async () => {
        calls += 1;
        if (calls === 1) throw transientError();
        return "ok";
      },
      { baseDelayMs: 1, onRetry: () => { retries += 1; } },
    );
    assert.equal(value, "ok");
    assert.equal(calls, 2);
    assert.equal(retries, 1);
    assert.equal(client.sessions.length, 2);
    assert.ok(client.sessions.every((s) => s.ended));
  });

  it("does not retry a non-transient error", async () => {
    const client = new FakeClient();
    let calls = 0;
    await assert.rejects(
      withTransaction(client, async () => {
        calls += 1;
        throw new Error("duplicate key");
      }),
      TransactionAbortedError,
    );
    assert.equal(calls, 1);
  });

  it("gives up after maxAttempts on repeated transient errors", async () => {
    const client = new FakeClient();
    await assert.rejects(
      withTransaction(
        client,
        async () => {
          throw transientError();
        },
        { maxAttempts: 3, baseDelayMs: 1 },
      ),
      (error: unknown) => {
        assert.ok(error instanceof TransactionRetriesExhaustedError);
        assert.equal(error.attempts, 3);
        return true;
      },
    );
    assert.equal(client.sessions.length, 3);
  });

  it("times out, aborts, and ends the session", async () => {
    const client = new FakeClient();
    await assert.rejects(
      withTransaction(
        client,
        async () => {
          await new Promise((resolve) => setTimeout(resolve, 200));
          return "too late";
        },
        { timeoutMs: 20 },
      ),
      TransactionTimeoutError,
    );
    assert.equal(client.sessions[0].aborted, true);
    assert.equal(client.sessions[0].ended, true);
  });

  it("createTransactionRunner applies defaults", async () => {
    const client = new FakeClient();
    const tx = createTransactionRunner(client, { maxAttempts: 1 });
    const value = await tx(async () => "from-runner");
    assert.equal(value, "from-runner");
  });
});
