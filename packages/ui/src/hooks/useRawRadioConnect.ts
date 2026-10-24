import { useEffect, useState } from "react";
import type { SnapshotDevice } from "@robot-console/host/src/wsMessages.js";
import type { LinkNotice } from "../ws/WsProvider";
import { findLink, isLinkUsable, linkStateText } from "../deviceDisplay";
import { RADIO_CONNECT_GIVE_UP_MS, RADIO_NO_ANSWER_TEXT } from "../lib/radioConnect";

export type RawRadioAttempt = { state: "pending" } | { state: "failed"; text: string };

interface Pending {
  childLinkId: string;
  since: number | null;
  notice: LinkNotice | undefined;
}

export function useRawRadioConnect(
  devices: readonly SnapshotDevice[],
  linkNotices: ReadonlyMap<string, LinkNotice>,
): { attempt: RawRadioAttempt | null; start: (childLinkId: string) => void; clear: () => void } {
  const [pending, setPending] = useState<Pending | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const childLink = pending ? findLink(devices, pending.childLinkId) : undefined;
  const childNotice = pending ? linkNotices.get(pending.childLinkId) : undefined;

  useEffect(() => {
    if (!pending) {
      return;
    }
    if (childLink && isLinkUsable(childLink)) {
      setPending(null);
      setFailure(null);
      return;
    }
    if (childNotice !== undefined && childNotice !== pending.notice) {
      setPending(null);
      setFailure(childNotice.text);
      return;
    }
    if (childLink && (childLink.state === "failed" || childLink.state === "unresponsive") && childLink.since !== pending.since) {
      setPending(null);
      setFailure(linkStateText(childLink, Date.now()));
    }
  }, [pending, childLink, childNotice]);

  useEffect(() => {
    if (!pending) {
      return undefined;
    }
    const timer = setTimeout(() => {
      setPending(null);
      setFailure(RADIO_NO_ANSWER_TEXT);
    }, RADIO_CONNECT_GIVE_UP_MS);
    return () => clearTimeout(timer);
  }, [pending]);

  return {
    attempt: pending ? { state: "pending" } : failure !== null ? { state: "failed", text: failure } : null,
    start: (childLinkId) => {
      setFailure(null);
      setPending({ childLinkId, since: findLink(devices, childLinkId)?.since ?? null, notice: linkNotices.get(childLinkId) });
    },
    clear: () => {
      setPending(null);
      setFailure(null);
    },
  };
}
