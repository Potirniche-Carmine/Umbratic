import assert from "node:assert/strict";
import test from "node:test";

import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

test("desktop defaults to editable local settings unless an endpoint is explicitly managed", () => {
  const names = [
    "UMBRATIC_ALLOW_ENDPOINT_EDIT",
    "UMBRATIC_DEFAULT_ENDPOINT_MODE",
    "UMBRATIC_VEIL_BASE_URL",
  ];
  const previous = Object.fromEntries(names.map((name) => [name, process.env[name]]));
  try {
    for (const name of names) delete process.env[name];
    const config = loadTypeScriptModule(new URL("../src/main/config.ts", import.meta.url), { cache: new Map() });

    assert.equal(config.defaultModelEndpointMode(), "local");
    assert.equal(config.endpointEditingAllowed(), true);
    // Local mode has no address to configure: the app starts its own runtime.
    assert.equal(config.defaultEndpointBaseUrlForMode("local"), "");

    process.env.UMBRATIC_ALLOW_ENDPOINT_EDIT = "false";
    assert.equal(config.endpointEditingAllowed(), false);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
});


