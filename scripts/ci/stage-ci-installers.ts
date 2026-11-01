// Run only after archive/native verification. Upload a platform's exact final
// unsigned installer set, rather than its unpacked build or intermediate files.
import fs from "node:fs";
import path from "node:path";
import { verifyUpdateChannel } from "./release-artifacts.ts";

const directory = path.resolve("target/release/desktop");
const destination = path.resolve("target/release/ci-upload");
const releaseVersion = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
const channel = process.platform === "darwin" ? "latest-mac.yml" : "latest.yml";
const installer = `Umbratic-${releaseVersion}${process.platform === "darwin" ? ".zip" : `-${process.arch}.exe`}`;
const names = verifyUpdateChannel(directory, releaseVersion, channel, installer);
fs.rmSync(destination, { recursive: true, force: true });
fs.mkdirSync(destination, { recursive: true });
for (const name of names) {
  const target = name === "latest.yml" && process.arch === "arm64" ? "latest-arm64.yml" : name;
  fs.copyFileSync(path.join(directory, name), path.join(destination, target));
  if (fs.existsSync(path.join(directory, `${name}.blockmap`))) {
    fs.copyFileSync(path.join(directory, `${name}.blockmap`), path.join(destination, `${target}.blockmap`));
  }
}
