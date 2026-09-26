import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoomMetadata } from "@elm-chat/shared";
import { ReconnectScheduler } from "../apps/web/src/reconnect";
import { loadRoomMetadata, RoomMetadataError } from "../apps/web/src/room-metadata";

const metadata: RoomMetadata = {
  roomId: "test-room",
  createdAt: 1,
  expiresAt: null,
  inactivityTimeoutMs: null,
  maxAgeMs: null,
  disappearAfterReadSeconds: null,
  status: "open",
  participantCount: 1,
  creatorJoined: true,
  lastActivityAt: 1,
  membershipVersion: 1
};

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("room metadata recovery classification", () => {
  it("loads room metadata from the room endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue(Response.json(metadata));
    vi.stubGlobal("fetch", fetchMock);
    await expect(loadRoomMetadata("test-room")).resolves.toEqual(metadata);
    expect(fetchMock).toHaveBeenCalledWith("/api/rooms/test-room");
  });

  it("classifies network rejection as temporary", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));
    await expect(loadRoomMetadata("test-room")).rejects.toMatchObject({ kind: "temporary" });
  });

  it("retries a body transport failure after successful response headers", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"roomId":'));
      },
      pull(controller) {
        controller.error(new TypeError("Connection lost while reading response"));
      }
    });
    const response = new Response(body, { status: 200 });
    expect(response.ok).toBe(true);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(response));
    await expect(loadRoomMetadata("test-room")).rejects.toMatchObject({ kind: "temporary" });
  });

  it.each([
    [404, "missing"], [410, "missing"],
    [408, "temporary"], [500, "temporary"], [502, "temporary"], [503, "temporary"], [504, "temporary"],
    [400, "failed"], [401, "failed"], [403, "failed"], [429, "failed"]
  ])("classifies HTTP %i as %s", async (status, kind) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: Number(status) })));
    await expect(loadRoomMetadata("test-room")).rejects.toMatchObject({ kind });
  });

  it("does not classify malformed successful JSON as a temporary network failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("{", { status: 200 })));
    const failure = await loadRoomMetadata("test-room").catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(SyntaxError);
    expect(failure).not.toBeInstanceOf(RoomMetadataError);
  });
});

describe("shared reconnect scheduling", () => {
  it("keeps one bounded retry budget across metadata failures and socket closes", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Network unavailable"))
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockImplementation(() => Promise.resolve(Response.json(metadata)));
    vi.stubGlobal("fetch", fetchMock);
    const scheduled = vi.fn();
    const socketClose = vi.fn();
    const exhausted = vi.fn();
    let scheduler: ReconnectScheduler;
    const connect = async () => {
      try {
        await loadRoomMetadata("test-room");
        // Model a socket that closes before the server acknowledges a join.
        socketClose();
      } catch (error) {
        if (!(error instanceof RoomMetadataError) || error.kind !== "temporary") throw error;
      }
      if (!scheduler.schedule()) exhausted();
    };
    scheduler = new ReconnectScheduler(() => true, () => { void connect(); }, scheduled);

    await connect();
    for (const delay of [500, 1000, 2000, 4000, 8000]) {
      await vi.advanceTimersByTimeAsync(delay);
    }
    expect(scheduled.mock.calls.map(([delay]) => delay)).toEqual([500, 1000, 2000, 4000, 8000]);
    expect(fetchMock).toHaveBeenCalledTimes(6);
    expect(socketClose).toHaveBeenCalledTimes(4);
    expect(exhausted).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("coalesces duplicate scheduling without consuming retry attempts", () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    const scheduled = vi.fn();
    const scheduler = new ReconnectScheduler(() => true, retry, scheduled);
    expect(scheduler.schedule()).toBe(true);
    expect(scheduler.schedule()).toBe(true);
    expect(vi.getTimerCount()).toBe(1);
    vi.advanceTimersByTime(499);
    expect(retry).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(scheduler.schedule()).toBe(true);
    expect(scheduled.mock.calls).toEqual([[500], [1000]]);
  });

  it("resets the budget after a successful join and cancels a pending retry", () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    const scheduled = vi.fn();
    const scheduler = new ReconnectScheduler(() => true, retry, scheduled);
    scheduler.schedule();
    vi.advanceTimersByTime(500);
    scheduler.schedule();
    scheduler.reset();
    vi.advanceTimersByTime(10_000);
    expect(retry).toHaveBeenCalledTimes(1);
    expect(scheduler.schedule()).toBe(true);
    expect(scheduled.mock.calls).toEqual([[500], [1000], [500]]);
    vi.advanceTimersByTime(500);
    expect(retry).toHaveBeenCalledTimes(2);
  });

  it("cancels a pending reconnect during cleanup", () => {
    vi.useFakeTimers();
    const retry = vi.fn();
    const scheduler = new ReconnectScheduler(() => true, retry, vi.fn());
    scheduler.schedule();
    scheduler.cancel();
    scheduler.cancel();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(10_000);
    expect(retry).not.toHaveBeenCalled();
  });

  it("checks eligibility again when a pending timer fires", () => {
    vi.useFakeTimers();
    let allowed = true;
    const retry = vi.fn();
    const scheduled = vi.fn();
    const scheduler = new ReconnectScheduler(() => allowed, retry, scheduled);
    scheduler.schedule();
    allowed = false;
    vi.advanceTimersByTime(500);
    expect(retry).not.toHaveBeenCalled();
    expect(scheduler.schedule()).toBe(false);
    expect(scheduled).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
