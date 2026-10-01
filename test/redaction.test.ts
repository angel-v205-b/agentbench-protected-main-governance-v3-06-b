import { describe, expect, it } from "vitest";
import { describeRemoteBody, redactSensitive, safeErrorMessage } from "../src/redaction.js";

describe("sensitive material redaction", () => {
  const fakeClassicToken = ["ghp", "supersecret123"].join("_");
  const fakeFineGrainedToken = ["github", "pat", "11AA", "supersecret123"].join("_");
  const fakeValue = ["super", "secret123"].join("");

  it.each([
    `Authorization: Bearer ${fakeClassicToken}`,
    `Authorization: token supersecret123`,
    `Authorization: Basic c3VwZXJzZWNyZXQxMjM=supersecret123`,
    `request failed?access_token=${fakeClassicToken}&mode=test`,
    ["https://octo:", fakeClassicToken, "@github.com/octo/repo.git"].join(""),
    ["https://x-access-token:", "supersecret123", "@github.com/octo/repo.git"].join(""),
    JSON.stringify({ token: fakeClassicToken, message: "bad credentials" }),
    JSON.stringify({ password: fakeValue }),
    `remote returned ${fakeFineGrainedToken}`
  ])("does not retain known token forms", (value) => {
    const redacted = redactSensitive(value);
    expect(redacted).not.toContain("supersecret123");
    expect(redacted).toContain("REDACTED");
  });

  it("leaves ordinary text alone", () => {
    expect(redactSensitive("ruleset agentbench/protected-main updated")).toBe(
      "ruleset agentbench/protected-main updated"
    );
  });

  it("redacts error messages without returning stacks", () => {
    const error = new Error(`Authorization: Bearer ${["github", "pat", "secret"].join("_")}`);
    expect(safeErrorMessage(error)).toBe("Authorization: Bearer [REDACTED]");
    expect(safeErrorMessage(`token=${"x".repeat(3)}?token=abc`)).toBe("token=xxx?token=[REDACTED]");
  });

  it("describes remote bodies with sensitive keys removed and bounded length", () => {
    const body = JSON.stringify({
      message: "Validation Failed",
      errors: [{ field: "rules", client_secret: fakeValue }],
      nested: { a: { b: { c: { d: { e: "deep" } } } } }
    });
    const described = describeRemoteBody(body);
    expect(described).toContain("Validation Failed");
    expect(described).not.toContain("supersecret123");
    expect(described).toContain("[TRUNCATED]");
    expect(describeRemoteBody("")).toBe("(empty response body)");
    expect(describeRemoteBody("x".repeat(500), 10)).toBe(`${"x".repeat(10)}…`);
    expect(describeRemoteBody(`<html>\n${fakeClassicToken}</html>`)).toBe(
      "<html> [REDACTED]</html>"
    );
  });
});
