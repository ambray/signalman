/**
 * Unit tests for the F4 input validators in
 * `host/src/control-plane/build/git.ts`.
 *
 * These validators are the primary defense against git option-injection
 * attacks (CVE-2017-1000117 family). Every code path that ends in a
 * `git clone ... <repoUrl> <ref>` shell-out passes through them, and
 * `cloneProductAtTag` re-applies them at the spawn site as defense in
 * depth.
 */

import { describe, expect, it } from "vitest";
import {
  GitRefValidationError,
  RepoUrlValidationError,
  validateGitRef,
  validateRepoUrl,
} from "../control-plane/build/git.js";

describe("validateRepoUrl", () => {
  it.each([
    "https://github.com/example/repo.git",
    "http://localhost:3000/repo.git",
    "ssh://git@github.com/example/repo.git",
    "git://example.com/repo.git",
    "file:///tmp/repo",
    "git@github.com:example/repo.git",
    "user@host.example.com:path/to/repo.git",
    // Bare absolute paths — git accepts these as local clone sources.
    "/var/git/mirrors/example.git",
    "/tmp/signalman-remote-build-repo-AbCdEf",
    "C:\\Users\\ci\\repo.git",
    "C:/Users/ci/repo.git",
    "\\\\server\\share\\repo.git",
  ])("accepts %s", (url) => {
    expect(() => validateRepoUrl(url)).not.toThrow();
  });

  it.each([
    ["empty string", ""],
    ["leading dash (option injection)", "--upload-pack=evil"],
    ["leading dash short", "-x"],
    ["javascript scheme", "javascript:alert(1)"],
    ["unknown scheme", "ftp://example.com/repo"],
    ["embedded newline", "https://example.com/\nrepo"],
    ["embedded NUL", "https://example.com/\x00repo"],
    ["relative path", "etc/passwd"],
    ["just a word", "u"],
  ])("rejects %s", (_label, url) => {
    expect(() => validateRepoUrl(url)).toThrow(RepoUrlValidationError);
  });

  it("rejects overly long input", () => {
    expect(() =>
      validateRepoUrl("https://example.com/" + "a".repeat(3000)),
    ).toThrow(/too long/);
  });
});

describe("validateGitRef", () => {
  it.each([
    "v1.0.0",
    "main",
    "feature/login",
    "release-2024.01",
    "v0.3.0-rc.1",
  ])("accepts %s", (ref) => {
    expect(() => validateGitRef(ref)).not.toThrow();
  });

  it.each([
    ["empty", ""],
    ["leading dash", "--upload-pack=evil"],
    ["double dot", "v1..0"],
    ["embedded space", "v1 0"],
    ["embedded tilde", "v1~1"],
    ["embedded caret", "v1^"],
    ["embedded colon", "refs/heads/main:..."],
    ["embedded question mark", "v1?"],
    ["embedded star", "v*"],
    ["embedded bracket", "v[1]"],
    ["leading slash", "/main"],
    ["trailing slash", "main/"],
    ["lock suffix", "main.lock"],
    ["reflog selector", "main@{0}"],
    ["control char", "v\x01"],
  ])("rejects %s", (_label, ref) => {
    expect(() => validateGitRef(ref)).toThrow(GitRefValidationError);
  });
});
