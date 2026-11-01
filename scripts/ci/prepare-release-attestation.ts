import fs from "node:fs";
import path from "node:path";
import { prepareAttestation } from "./release-attestations.ts";

const version = JSON.parse(fs.readFileSync("package.json", "utf8")).version;
prepareAttestation(path.resolve("target/release/upload"), version, "release", process.env.RELEASE_COMMIT!);
