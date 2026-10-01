import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { defaultTokenPath, readToken } from "../src/auth.js";

describe("token loading", () => {
  it("reads and trims a token from an explicit temporary file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "governance-token-"));
    const path = join(directory, "token.txt");
    await writeFile(path, "  fake-value-for-tests \n");
    await expect(readToken(path)).resolves.toBe("fake-value-for-tests");
  });

  it("rejects empty and missing token files without echoing paths", async () => {
    const directory = await mkdtemp(join(tmpdir(), "governance-token-"));
    const path = join(directory, "token.txt");
    await expect(readToken(path)).rejects.toThrow(
      /unable to read the configured GitHub token file$/
    );
    await writeFile(path, " \n");
    await expect(readToken(path)).rejects.toThrow(/empty/);
  });

  it("defaults to the documented location", () => {
    expect(defaultTokenPath()).toMatch(/\.config\/agent-eval\/github-governance-token\.txt$/);
  });
});
