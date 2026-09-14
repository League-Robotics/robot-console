// The TypeScript half of tools/radio-address-dump: prints the canonical form
// of radio-robot-lib docs/design/radio-addressing.md from the REAL
// packages/protocol/src/radioAddress.ts, for n = 0..3124.
import { deviceIdToName, nameToValue } from "../packages/protocol/src/naming.ts";
import { nameToRadioAddress, radioAddressToName } from "../packages/protocol/src/radioAddress.ts";

const version = process.argv[2] === "1" ? 1 : 2;
const lines: string[] = [];
for (let n = 0; n < 3125; n++) {
  const name = deviceIdToName(n);
  const { channel, group } = nameToRadioAddress(name);
  if (version === 1) {
    lines.push(`${name},${channel},${group}\n`);
  } else {
    lines.push(`${name},${channel},${group},${nameToValue(name)},${nameToValue(radioAddressToName(channel, group))}\n`);
  }
}
process.stdout.write(lines.join(""));
