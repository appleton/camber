import { type ACPAgentServerConfig } from "@camber/rpc";
import { describe, expect, it } from "vitest";
import {
  versionFromArchiveReference,
  versionFromConfig,
  versionFromPackageReference,
} from "./agentVersions";

describe("versionFromArchiveReference", () => {
  it("reads the version from its own path segment", () => {
    expect(
      versionFromArchiveReference(
        "https://downloads.poolside.ai/pool/v1.0.5/pool-darwin-arm64.tar.gz",
        "darwin-arm64",
      ),
    ).toBe("1.0.5");
    expect(
      versionFromArchiveReference(
        "https://github.com/example/agent/releases/download/v1.2.3/agent.tgz",
        "darwin-arm64",
      ),
    ).toBe("1.2.3");
  });

  it("supports hyphenated prereleases and build metadata in path segments", () => {
    expect(
      versionFromArchiveReference(
        "https://example.com/agent/v1.2.3-beta-1+build.2/agent-darwin-arm64.zip",
        "darwin-arm64",
      ),
    ).toBe("1.2.3-beta-1+build.2");
  });

  it("reads versions embedded in the file name", () => {
    expect(
      versionFromArchiveReference("https://example.com/agent-v1.2.3.tar.gz", "linux-x64"),
    ).toBe("1.2.3");
    expect(
      versionFromArchiveReference(
        "https://example.com/agent-v1.2.3-darwin-arm64.tar.gz",
        "darwin-arm64",
      ),
    ).toBe("1.2.3");
    expect(
      versionFromArchiveReference(
        "https://example.com/agent-v1.2.3-beta.1-darwin-arm64.tar.gz",
        "darwin-arm64",
      ),
    ).toBe("1.2.3-beta.1");
  });

  it("strips platform suffixes that spell architectures differently than the key", () => {
    expect(
      versionFromArchiveReference(
        "https://example.com/pool-v2.0.0-darwin-arm64.tar.gz",
        "darwin-aarch64",
      ),
    ).toBe("2.0.0");
    expect(
      versionFromArchiveReference(
        "https://example.com/pool-v1.1.0-linux-amd64.tar.gz",
        "linux-x86_64",
      ),
    ).toBe("1.1.0");
    expect(
      versionFromArchiveReference(
        "https://example.com/agent-v1.2.3-x86_64-unknown-linux-gnu.tar.gz",
        "linux-x86_64",
      ),
    ).toBe("1.2.3");
    expect(
      versionFromArchiveReference(
        "https://example.com/agent-v1.2.3-beta-1-darwin-arm64.tar.gz",
        "darwin-aarch64",
      ),
    ).toBe("1.2.3-beta-1");
  });

  it("strips every archive extension the helper can install", () => {
    for (const extension of ["zip", "tar.gz", "tgz", "tar.bz2", "tbz2"]) {
      expect(
        versionFromArchiveReference(
          `https://example.com/agent-v1.2.3-linux-x64.${extension}`,
          "linux-x86_64",
        ),
      ).toBe("1.2.3");
    }
  });

  it("ignores query strings and fragments", () => {
    expect(
      versionFromArchiveReference("https://example.com/agent-v1.2.3.zip?download=1", "linux-x64"),
    ).toBe("1.2.3");
    expect(
      versionFromArchiveReference(
        "https://example.com/agent-darwin-arm64.zip?redirect=/v9.9.9/",
        "darwin-aarch64",
      ),
    ).toBeNull();
  });

  it("returns null when the file name carries no version", () => {
    expect(versionFromArchiveReference("https://example.com/agent.zip", "darwin-arm64")).toBeNull();
  });
});

describe("versionFromPackageReference", () => {
  it("parses npm and scoped npm references", () => {
    expect(versionFromPackageReference("some-package@1.2.3")).toBe("1.2.3");
    expect(versionFromPackageReference("@scope/pkg@1.2.3-beta.1")).toBe("1.2.3-beta.1");
  });

  it("parses PyPI version specifiers", () => {
    expect(versionFromPackageReference("example-acp==1.0.0")).toBe("1.0.0");
  });

  it("parses versions in paths", () => {
    expect(versionFromPackageReference("/opt/agent/v2.1.0/agent")).toBe("2.1.0");
    expect(versionFromPackageReference("/v1.2.3-beta-1+build.2/agent")).toBe(
      "1.2.3-beta-1+build.2",
    );
  });

  it("returns null for unversioned references", () => {
    expect(versionFromPackageReference("--acp")).toBeNull();
    expect(versionFromPackageReference("some-command")).toBeNull();
  });
});

describe("versionFromConfig", () => {
  it("prefers binary archive versions and passes the platform key", () => {
    const config = {
      command: "./agent",
      binary: {
        "darwin-arm64": {
          archive: "https://example.com/agent-v2.0.0-darwin-arm64.tar.gz",
          cmd: "./agent",
        },
      },
    } as unknown as ACPAgentServerConfig;
    expect(versionFromConfig(config)).toBe("2.0.0");
  });

  it("falls back to args package references", () => {
    const config = {
      command: "npx",
      args: ["-y", "@scope/agent@0.5.0"],
    } as unknown as ACPAgentServerConfig;
    expect(versionFromConfig(config)).toBe("0.5.0");
  });

  it("returns null without a config or version", () => {
    expect(versionFromConfig(undefined)).toBeNull();
    expect(versionFromConfig({ command: "agent" } as ACPAgentServerConfig)).toBeNull();
  });
});
