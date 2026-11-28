import { verifyProvisionerAssertion } from "./provisioner-auth.mjs";
import { validateProvisionerEnrollmentRequest } from "./provisioner-enrollment-schema.mjs";

function failure(code) {
  return { ok: false, code };
}

/**
 * Validate and authenticate a Provisioner enrollment request without performing
 * D1 writes or exposing an HTTP route. Callers must keep this function behind
 * the dedicated GROUP Service Binding boundary.
 */
export async function prepareProvisionerEnrollment(request, env, options = {}) {
  const verified = await verifyProvisionerAssertion(request, env, options);
  if (!verified.ok) return failure(verified.code);

  if (!validateProvisionerEnrollmentRequest(verified.body)) {
    return failure("PROVISIONER_ENROLLMENT_SCHEMA_INVALID");
  }

  return {
    ok: true,
    subject: verified.subject,
    jti: verified.jti,
    keyId: verified.keyId,
    requestDigest: verified.requestDigest,
    idempotencyKeyHash: verified.idempotencyKeyHash,
    enrollmentRequest: verified.body
  };
}
