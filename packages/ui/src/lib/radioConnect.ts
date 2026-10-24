export const RADIO_CONNECT_GIVE_UP_MS = 60_000;

export const RADIO_NO_ANSWER_TEXT = "Couldn't connect: no answer through the radio bridge";

export const RAW_RADIO_OPTION_VALUE = "@channel-group";

export const MAX_RADIO_CHANNEL = 83;
export const MAX_RADIO_GROUP = 255;

export interface RawRadioAddress {
  channel: number;
  group: number;
}

function parseBounded(text: string, max: number): number | undefined {
  if (!/^\d+$/.test(text.trim())) {
    return undefined;
  }
  const value = Number(text);
  return value <= max ? value : undefined;
}

export function parseRawRadioAddress(channel: string, group: string): RawRadioAddress | undefined {
  const parsedChannel = parseBounded(channel, MAX_RADIO_CHANNEL);
  const parsedGroup = parseBounded(group, MAX_RADIO_GROUP);
  return parsedChannel === undefined || parsedGroup === undefined ? undefined : { channel: parsedChannel, group: parsedGroup };
}
