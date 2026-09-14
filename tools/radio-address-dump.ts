/**
 * Helper for `tools/radio-address-dump` (see that file for the contract):
 * writes protocol's canonical radio-address form, version 1 or 2, to
 * stdout. Run with tsx against the protocol package's source.
 */
import { radioAddressCanonicalForm } from "../packages/protocol/src/radioAddress.js";

// A reader that stops early (`| head`) is not an error worth a stack trace.
process.stdout.on("error", (err: NodeJS.ErrnoException) => {
  process.exit(err.code === "EPIPE" ? 0 : 1);
});

const version = process.argv[2] === "1" ? 1 : 2;
process.stdout.write(radioAddressCanonicalForm(version));
