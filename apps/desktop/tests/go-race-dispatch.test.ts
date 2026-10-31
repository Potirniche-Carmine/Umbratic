import assert from "node:assert/strict";
import test from "node:test";
import { goTestArguments } from "../../../scripts/run-go-race.ts";

test("Go race dispatch retains all tests on unsupported Windows targets", () => {
  for (const environment of [
    { GOOS: "windows", GOARCH: "arm64", CGO_ENABLED: "1" },
    { GOOS: "windows", GOARCH: "amd64", CGO_ENABLED: "0" },
  ]) assert.deepEqual(goTestArguments(environment), ["test", "./..."]);
});

test("Go race dispatch preserves race checks on supported native jobs", () => {
  for (const environment of [
    { GOOS: "windows", GOARCH: "amd64", CGO_ENABLED: "1" },
    { GOOS: "darwin", GOARCH: "arm64", CGO_ENABLED: "1" },
    { GOOS: "linux", GOARCH: "amd64", CGO_ENABLED: "1" },
    { GOOS: "linux", GOARCH: "amd64", CGO_ENABLED: "0" },
  ]) assert.deepEqual(goTestArguments(environment), ["test", "-race", "./..."]);
});
