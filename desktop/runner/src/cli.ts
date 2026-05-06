import { aegisRunnerName, aegisRunnerVersion } from "./policy.js";
import { listen } from "./server.js";

function parseArgs(argv: string[]): { command?: string; port?: string; password?: string; hostname?: string } {
  const [command, ...rest] = argv;
  const parsed: { command?: string; port?: string; password?: string; hostname?: string } = { command };
  for (const item of rest) {
    const [key, value] = item.split("=", 2);
    if (key === "--port") parsed.port = value;
    if (key === "--password") parsed.password = value;
    if (key === "--hostname") parsed.hostname = value;
  }
  return parsed;
}

const args = parseArgs(process.argv.slice(2));

if (args.command !== "serve") {
  console.error(`${aegisRunnerName} ${aegisRunnerVersion}`);
  console.error("usage: aegis-runner serve --port=<port> --password=<password>");
  process.exit(1);
}

if (!args.password) {
  console.error("--password is required");
  process.exit(1);
}

const port = args.port ? Number(args.port) : 0;
const hostname = args.hostname || "127.0.0.1";
const server = await listen({ hostname, port, password: args.password });
console.error(`aegis runner listening on ${server.url}`);

process.once("SIGINT", () => void server.close().finally(() => process.exit(0)));
process.once("SIGTERM", () => void server.close().finally(() => process.exit(0)));
