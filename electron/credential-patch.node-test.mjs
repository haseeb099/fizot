import assert from "node:assert/strict";
import { test } from "node:test";
import { credentialSaveError } from "./credential-patch.mjs";

test("a key the provider refused crosses IPC named KeyRejected, with the server's words", () => {
  const error = credentialSaveError(400, { error: "example.invalid rejected that key", code: "key_rejected" });
  assert.equal(error.toString(), "KeyRejected: example.invalid rejected that key");
  assert.equal(`Error invoking remote method 'credential:set': ${error}`, "Error invoking remote method 'credential:set': KeyRejected: example.invalid rejected that key");
});

test("every other refusal stays a plain Error", () => {
  for (const [status, body] of [[400, { error: "Couldn't reach example.invalid" }], [409, { error: "busy", code: "conflict" }], [503, null], [403, { code: "KeyRejected" }]]) {
    const error = credentialSaveError(status, body);
    assert.ok(error.toString().startsWith("Error: "), error.toString());
    assert.ok(!error.toString().startsWith("KeyRejected: "));
  }
  assert.equal(credentialSaveError(503, null).message, "Could not save credential (HTTP 503)");
});
