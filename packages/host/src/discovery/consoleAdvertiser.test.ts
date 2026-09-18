/**
 * consoleAdvertiser.test.ts — sprint 021 ticket 002's own suite for
 * `startConsoleAdvertiser`: publish/unpublish call shape against a fully
 * synthetic fake backend (no real multicast socket, mirroring
 * `discovery/mdnsDiscovery.test.ts`'s own fake-backend discipline), the
 * actual bound port (not a requested one that may differ), and `stop()`
 * calling `unpublish`/`destroy` exactly once.
 */
import os from "node:os";
import { describe, expect, it, vi } from "vitest";
import { startConsoleAdvertiser, CONSOLE_SERVICE_TYPE, type ConsoleAdvertiserBackend, type PublishConfig, type PublishedConsoleService } from "./consoleAdvertiser.js";

function fakeBackend(): ConsoleAdvertiserBackend & {
  publishCalls: PublishConfig[];
  unpublishMock: ReturnType<typeof vi.fn>;
  destroyMock: ReturnType<typeof vi.fn>;
} {
  const publishCalls: PublishConfig[] = [];
  const unpublishMock = vi.fn();
  const destroyMock = vi.fn();
  return {
    publishCalls,
    unpublishMock,
    destroyMock,
    publish(config: PublishConfig): PublishedConsoleService {
      publishCalls.push(config);
      return { unpublish: unpublishMock };
    },
    destroy(): void {
      destroyMock();
    },
  };
}

describe("startConsoleAdvertiser", () => {
  it("publishes {name: os.hostname(), type: robotconsole, protocol: tcp, port} against the injected backend", () => {
    const backend = fakeBackend();

    startConsoleAdvertiser({ port: 4795, backend });

    expect(backend.publishCalls).toEqual([{ name: os.hostname(), type: CONSOLE_SERVICE_TYPE, protocol: "tcp", port: 4795 }]);
  });

  it("advertises the actual bound port handed in, not some other value -- distinct calls with different ports publish distinct ports", () => {
    const backendA = fakeBackend();
    const backendB = fakeBackend();

    startConsoleAdvertiser({ port: 0, backend: backendA });
    startConsoleAdvertiser({ port: 54219, backend: backendB });

    expect(backendA.publishCalls[0]?.port).toBe(0);
    expect(backendB.publishCalls[0]?.port).toBe(54219);
  });

  it("stop() calls the published service's unpublish() and the backend's destroy(), each exactly once", () => {
    const backend = fakeBackend();
    const advertiser = startConsoleAdvertiser({ port: 4795, backend });

    expect(backend.unpublishMock).not.toHaveBeenCalled();
    expect(backend.destroyMock).not.toHaveBeenCalled();

    advertiser.stop();

    expect(backend.unpublishMock).toHaveBeenCalledTimes(1);
    expect(backend.destroyMock).toHaveBeenCalledTimes(1);
  });

  it("stop() is idempotent -- a second call does not unpublish/destroy again", () => {
    const backend = fakeBackend();
    const advertiser = startConsoleAdvertiser({ port: 4795, backend });

    advertiser.stop();
    advertiser.stop();
    advertiser.stop();

    expect(backend.unpublishMock).toHaveBeenCalledTimes(1);
    expect(backend.destroyMock).toHaveBeenCalledTimes(1);
  });

  it("start() calls publish exactly once per call, even across repeated stop()s of a prior instance", () => {
    const backend = fakeBackend();
    const first = startConsoleAdvertiser({ port: 4795, backend });
    first.stop();
    first.stop();
    startConsoleAdvertiser({ port: 4795, backend });

    expect(backend.publishCalls).toHaveLength(2);
    expect(backend.unpublishMock).toHaveBeenCalledTimes(1);
    expect(backend.destroyMock).toHaveBeenCalledTimes(1);
  });
});
