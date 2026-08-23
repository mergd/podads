import { describe, expect, test } from "bun:test";

import {
  BASIC_TRANSCRIBER_MAX_DURATION_SECONDS,
  BASIC_TRANSCRIBER_MAX_SOURCE_BYTES,
  selectTranscriberTier
} from "./containerSizing";

describe("selectTranscriberTier", () => {
  test("routes normal episodes to the basic container", () => {
    expect(selectTranscriberTier(40 * 1024 * 1024, 60 * 60)).toBe("basic");
  });

  test("routes episodes above either limit to the large container", () => {
    expect(selectTranscriberTier(BASIC_TRANSCRIBER_MAX_SOURCE_BYTES + 1, 30 * 60)).toBe("large");
    expect(selectTranscriberTier(10 * 1024 * 1024, BASIC_TRANSCRIBER_MAX_DURATION_SECONDS + 1)).toBe("large");
  });

  test("uses the available signal and treats fully unknown episodes conservatively", () => {
    expect(selectTranscriberTier(null, 45 * 60)).toBe("basic");
    expect(selectTranscriberTier(20 * 1024 * 1024, null)).toBe("basic");
    expect(selectTranscriberTier(null, null)).toBe("large");
  });
});
