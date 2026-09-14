/**
 * lib/radioAddress.test.ts — `validateRadioOverrideInput`'s own
 * coverage (ticket 017-008), moved out of the two duplicated inline
 * checks in `RadioAddressDialog.tsx`/`ConfigurationPage.tsx`.
 */
import { describe, expect, it } from "vitest";
import { validateRadioOverrideInput } from "./radioAddress";

describe("validateRadioOverrideInput", () => {
  it("accepts any integer channel/group within the raw hardware range", () => {
    expect(validateRadioOverrideInput(55, 114)).toBeNull();
    expect(validateRadioOverrideInput(0, 0)).toBeNull();
    expect(validateRadioOverrideInput(83, 255)).toBeNull();
  });

  it("accepts values outside the *derived*-address space that a stricter, name-derived check would reject", () => {
    // Channel 5 / group 5: below the name-derived 11-83 / 15-255, but a
    // legal hardware override the host itself accepts.
    expect(validateRadioOverrideInput(5, 5)).toBeNull();
    // Group 10 (the relay's `!C` space) is never derived but legal here.
    expect(validateRadioOverrideInput(41, 10)).toBeNull();
    // In range, but no name derives 11/16.
    expect(validateRadioOverrideInput(11, 16)).toBeNull();
  });

  it("rejects a channel outside 0-83 before checking the group", () => {
    expect(validateRadioOverrideInput(99, 1)).toBe("Channel must be a whole number from 0 to 83.");
    expect(validateRadioOverrideInput(-1, 1)).toBe("Channel must be a whole number from 0 to 83.");
    expect(validateRadioOverrideInput(1.5, 1)).toBe("Channel must be a whole number from 0 to 83.");
  });

  it("rejects a group outside 0-255 once the channel is valid", () => {
    expect(validateRadioOverrideInput(55, 999)).toBe("Group must be a whole number from 0 to 255.");
    expect(validateRadioOverrideInput(55, -1)).toBe("Group must be a whole number from 0 to 255.");
    expect(validateRadioOverrideInput(55, 1.5)).toBe("Group must be a whole number from 0 to 255.");
  });
});
