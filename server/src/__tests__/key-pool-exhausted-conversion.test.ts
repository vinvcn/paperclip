import { describe, expect, it } from "vitest";
import { HttpError } from "../errors.js";
import {
  KEY_POOL_EXHAUSTED_FAILURE_CODE,
  keyPoolExhaustedFailureFromHttpError,
} from "../services/heartbeat/run-preparation.js";

describe("keyPoolExhaustedFailureFromHttpError", () => {
  it("converts the pool service's 422 with the exhausted code into the typed failure", () => {
    const failure = keyPoolExhaustedFailureFromHttpError(
      new HttpError(
        422,
        "All keys are busy or cooling down: slot 5 leased by another run, slot 2 cooling until 12:00",
        { code: KEY_POOL_EXHAUSTED_FAILURE_CODE, connectionId: "conn-1", model: "z-ai/glm-5.3-flash", pool: [{ slot: 5, reason: "leased" }] },
      ),
    );
    expect(failure).toBeInstanceOf(Error);
    expect(failure?.code).toBe("provider_key_pool_exhausted");
    expect(failure?.message).toContain("All keys are busy");
    expect(failure?.resultJson).toEqual({
      keyPoolFailure: {
        reason: "pool_exhausted",
        connectionId: "conn-1",
        model: "z-ai/glm-5.3-flash",
        slots: [{ slot: 5, reason: "leased" }],
      },
    });
  });

  it("omits optional snapshot fields the pool service did not send", () => {
    const failure = keyPoolExhaustedFailureFromHttpError(
      new HttpError(422, "The connection's key pool cannot serve this run", { code: KEY_POOL_EXHAUSTED_FAILURE_CODE }),
    );
    expect(failure?.resultJson).toEqual({
      keyPoolFailure: { reason: "pool_exhausted", slots: [] },
    });
  });

  it("ignores other statuses and other 422 codes", () => {
    expect(keyPoolExhaustedFailureFromHttpError(new HttpError(500, "boom", { code: KEY_POOL_EXHAUSTED_FAILURE_CODE }))).toBeNull();
    expect(keyPoolExhaustedFailureFromHttpError(new HttpError(422, "nope", { code: "other_code" }))).toBeNull();
    expect(keyPoolExhaustedFailureFromHttpError(new Error("plain error"))).toBeNull();
    expect(keyPoolExhaustedFailureFromHttpError(null)).toBeNull();
  });
});
