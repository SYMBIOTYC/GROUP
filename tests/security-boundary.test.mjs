import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../wrangler.jsonc", import.meta.url), "utf8"));

test("GROUP has no public workers.dev or preview ingress", () => {
  assert.equal(config.name, "symbiotyc-group-control-plane");
  assert.equal(config.workers_dev, false);
  assert.equal(config.preview_urls, false);
});

test("GROUP has no route or custom-domain ingress", () => {
  assert.equal(config.routes === undefined || config.routes.length === 0, true);
  assert.equal(config.route === undefined, true);
  assert.equal(config.custom_domains === undefined || config.custom_domains.length === 0, true);
});
