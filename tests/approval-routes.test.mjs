import test from "node:test";
import assert from "node:assert/strict";
import worker from "../src/index.mjs";

const principal = scopes => btoa(JSON.stringify({
  kind:"user",tenant_id:"symbiotyc",project_id:"compute",actor_id:"access:owner-hash",scopes
}));
const request = (path, scopes, caller="amphetamin") => new Request("https://group.internal"+path, {
  method:"POST",
  headers:{
    "content-type":"application/json",
    ...(caller ? {"x-symbiotyc-caller":caller} : {}),
    ...(scopes ? {"x-symbiotyc-principal":principal(scopes)} : {})
  },
  body:JSON.stringify({action:"job.submit",operation_id:"image.thumbnail",request_hash:"a".repeat(64)})
});

test("approval creation requires the private Service Binding caller", async () => {
  const response=await worker.fetch(request("/v1/approvals",["compute:approvals:write"],null),{});
  assert.equal(response.status,401);
  assert.equal((await response.json()).error.code,"INTERNAL_GATEWAY_REQUIRED");
});
test("approval creation requires its dedicated scope", async () => {
  const response=await worker.fetch(request("/v1/approvals",["compute:jobs:write"]),{});
  assert.equal(response.status,403);
  assert.equal((await response.json()).error.code,"FORBIDDEN");
});
test("approval routes fail closed without durable D1", async () => {
  const response=await worker.fetch(request("/v1/approvals",["compute:approvals:write"]),{});
  assert.equal(response.status,503);
  assert.equal((await response.json()).error.code,"DATABASE_UNAVAILABLE");
});
test("approval consumption requires its dedicated scope", async () => {
  const response=await worker.fetch(request("/v1/approvals/00000000-0000-4000-8000-000000000001/consume",["compute:approvals:write"]),{});
  assert.equal(response.status,403);
  assert.equal((await response.json()).error.code,"FORBIDDEN");
});
