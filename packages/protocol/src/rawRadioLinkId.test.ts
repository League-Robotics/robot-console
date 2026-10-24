import { describe, expect, it } from "vitest";
import { rawRadioChildLinkId } from "./rawRadioLinkId.js";

describe("rawRadioChildLinkId", () => {
  it("builds the synthetic id from relay, channel and group", () => {
    expect(rawRadioChildLinkId("guvov", 76, 30)).toBe("radio-ch76-g30-via-guvov");
  });
});
