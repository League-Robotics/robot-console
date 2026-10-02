/**
 * StoredData.ts — what a robot reports about its persistent memory, read
 * from the link log lines that followed a "Read stored data" press:
 * `RUN calshow` for the calibration store and `WIFICRED` for the Wi-Fi
 * networks.
 */
import { deriveCalStoreState, type CalStoreState } from "./CalibrationStore";

export interface StoredWifiNetwork {
  slot: number;
  hasPassword: boolean;
  ssid: string;
}

/** `refused` is a nack or an `err`: the robot's program or firmware has no such command. */
export type StoredDataAnswer = "waiting" | "answered" | "refused";

export interface StoredData {
  calibration: CalStoreState;
  calibrationAnswer: StoredDataAnswer;
  wifi: StoredWifiNetwork[];
  wifiAnswer: StoredDataAnswer;
}

type Entry = { direction: "tx" | "rx"; line: string };

const WIFICRED_LINE = /^wificred (\d+) ([01]) (.*)$/;
const REPLY_LINE = /^(ack|nack) (\d+)\b/;
const ERR_LINE = /^err \d+ #(\d+)$/;

function sentId(entries: readonly Entry[], command: RegExp): string | undefined {
  for (const entry of entries) {
    const match = entry.direction === "tx" ? command.exec(entry.line.trim()) : null;
    if (match) {
      return match[1];
    }
  }
  return undefined;
}

/** An `err` for the id wins over its `ack`: the robot accepts the line, then rejects it on its merits. */
function replyTo(entries: readonly Entry[], id: string | undefined): "ack" | "refused" | undefined {
  if (id === undefined) {
    return undefined;
  }
  let reply: "ack" | "refused" | undefined;
  for (const entry of entries) {
    if (entry.direction !== "rx") {
      continue;
    }
    const line = entry.line.trim();
    if (ERR_LINE.exec(line)?.[1] === id) {
      return "refused";
    }
    const match = REPLY_LINE.exec(line);
    if (match && match[2] === id && reply === undefined) {
      reply = match[1] === "ack" ? "ack" : "refused";
    }
  }
  return reply;
}

export function deriveStoredData(entries: readonly Entry[]): StoredData {
  const calibration = deriveCalStoreState(entries);
  const calshowReply = replyTo(entries, sentId(entries, /^RUN calshow #(\d+)$/));
  const calibrationAnswer: StoredDataAnswer =
    calibration.values !== undefined ? "answered" : calshowReply === "refused" ? "refused" : "waiting";

  const wifi: StoredWifiNetwork[] = [];
  for (const entry of entries) {
    const match = entry.direction === "rx" ? WIFICRED_LINE.exec(entry.line.trim()) : null;
    if (match) {
      wifi.push({ slot: Number(match[1]), hasPassword: match[2] === "1", ssid: match[3] ?? "" });
    }
  }
  const wificredReply = replyTo(entries, sentId(entries, /^WIFICRED #(\d+)$/));
  const wifiAnswer: StoredDataAnswer =
    wifi.length > 0 || wificredReply === "ack" ? "answered" : wificredReply === "refused" ? "refused" : "waiting";

  return { calibration, calibrationAnswer, wifi, wifiAnswer };
}
