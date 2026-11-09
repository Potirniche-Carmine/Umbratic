import assert from "node:assert/strict";
import test from "node:test";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

const { CloudRpc } = loadTypeScriptModule(new URL("../src/main/cloudTransport.ts", import.meta.url), { realm: "host" });
const child = `
const readline = require('node:readline');
readline.createInterface({input:process.stdin}).on('line', line => {
  const request=JSON.parse(line);
  if(request.method==='exit') process.exit(0);
  else if(request.method==='bad') process.stdout.write('not JSON\\n');
  else if(request.method==='error') console.log(JSON.stringify({id:request.id,error:{code:-1,message:'No access'}}));
  else {
    console.log(JSON.stringify({method:'item/agentMessage/delta',params:{delta:'hello'}}));
    setTimeout(()=>console.log(JSON.stringify({id:request.id,result:{value:request.params.value}})),request.params.delay || 0);
  }
});`;

test("native JSONL transport correlates interleaved replies and streams notifications", async () => {
  const rpc = new CloudRpc(process.execPath, ["-e", child], process.cwd(), process.env);
  const events = []; rpc.onMessage = message => events.push(message);
  try {
    const values = await Promise.all([rpc.request("echo", { value: "slow", delay: 30 }), rpc.request("echo", { value: "fast" })]);
    assert.deepEqual(values, [{ value: "slow" }, { value: "fast" }]);
    assert.equal(events.length, 2);
    await assert.rejects(rpc.request("error"), /No access/);
  } finally { rpc.close(); }
});
test("process exit and malformed output reject pending calls instead of hanging", async () => {
  for (const method of ["exit", "bad"]) {
    const rpc = new CloudRpc(process.execPath, ["-e", child], process.cwd(), process.env);
    try { await assert.rejects(rpc.request(method), /stopped|invalid protocol/); await assert.rejects(rpc.request("echo"), /closed/); }
    finally { rpc.close(); }
  }
});
