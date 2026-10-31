import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const source = new URL("../src/main/readFile.ts", import.meta.url);
const reader = loadTypeScriptModule(source);
const utils = loadTypeScriptModule(new URL("../src/main/utils.ts", import.meta.url));

function workspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umbratic-file-read-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("bounded file reads reject directories and over-limit files", (t) => {
  const root = workspace(t);
  const file = path.join(root, "input.txt");
  fs.writeFileSync(file, "hello");
  assert.equal(reader.readRegularFileSync(file, 5).toString(), "hello");
  assert.throws(() => reader.readRegularFileSync(file, 4), /byte limit/);
  assert.throws(() => reader.readRegularFileSync(root, 100), /regular file/);
});

test("file replacement between lstat and open is rejected and closes its descriptor", (t) => {
  const root = workspace(t);
  const file = path.join(root, "input.txt");
  fs.writeFileSync(file, "original");
  let closed = false;
  const raced = loadTypeScriptModule(source, { mocks: { "node:fs": {
    ...fs,
    openSync: (...args) => {
      fs.renameSync(file, path.join(root, "original.txt"));
      fs.writeFileSync(file, "replacement");
      return fs.openSync(...args);
    },
    closeSync: (fd) => { closed = true; fs.closeSync(fd); },
  } } });
  assert.throws(() => raced.readRegularFileSync(file, 100), /changed while opening/);
  assert.equal(closed, true);
});

test("file growth during a bounded read is rejected", (t) => {
  const root = workspace(t);
  const file = path.join(root, "input.txt");
  fs.writeFileSync(file, "original");
  const raced = loadTypeScriptModule(source, { mocks: { "node:fs": {
    ...fs,
    readSync: (...args) => {
      const count = fs.readSync(...args);
      fs.appendFileSync(file, "more");
      return count;
    },
  } } });
  assert.throws(() => raced.readRegularFileSync(file, 8), /changed while reading/);
});

test("command display round-trips shell metacharacters and empty arguments", { skip: process.platform === "win32" }, () => {
  const args = ["", "a b", 'a"b', "a'b", "a\\b", "$(echo unsafe)", "`echo unsafe`", "x;y", "x\ny"];
  const command = utils.commandText(process.execPath, ["-e", "process.stdout.write(JSON.stringify(process.argv.slice(1)))", ...args]);
  assert.deepEqual(JSON.parse(execFileSync("/bin/sh", ["-c", command], { encoding: "utf8" })), args);
});
