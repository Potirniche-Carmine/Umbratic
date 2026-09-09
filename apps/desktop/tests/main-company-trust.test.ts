import assert from "node:assert/strict";
import test from "node:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadTypeScriptModule } from "./helpers/load-ts-module.ts";

test("enrollment trust is bounded, supplied out of band, and scoped to its origin", (t) => {
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),"company-trust-"));t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
 const ca=fs.readFileSync(new URL("./fixtures/company-ca.pem",import.meta.url),"utf8");
 let credential={baseUrl:"https://veil.example:8432",caPem:ca};
 const trust=loadTypeScriptModule(new URL("../src/main/companyTrust.ts",import.meta.url),{mocks:{electron:{app:{getPath:()=>directory}},"./storage":{readCompanyCertificate:()=>credential}}});
 const encode=(value)=>"umbr_enroll1_"+Buffer.from(JSON.stringify(value)).toString("base64url");
 const material=encode({url:credential.baseUrl,code:"umbr_test",ca});
 assert.equal(trust.enrollmentDetails(credential.baseUrl,material).ca,ca);
 for(const value of [encode({url:"https://attacker.example",code:"umbr_test",ca}),encode({url:credential.baseUrl,code:"umbr_test",ca:"not a certificate"}),"umbr_enroll1_"+"a".repeat(16384)]) {
  assert.throws(()=>trust.enrollmentDetails(credential.baseUrl,value));
 }
 assert.equal(trust.companyTLS("https://other.example"),undefined);
 const transport=trust.companyTLS(credential.baseUrl);
 assert.equal(fs.readFileSync(transport.caPath,"utf8"),ca);
 fs.writeFileSync(transport.caPath,"tampered");
 assert.throws(()=>trust.companyTLS(credential.baseUrl),/modified/);
 credential=undefined;assert.equal(trust.companyTLS("https://other.example"),undefined);
});
