const SERVICE_NAME = "symbiotyc-group-provisioner";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store"
    }
  });
}

export default {
  async fetch(request) {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/health") {
      return jsonResponse(200, {
        status: "blocked",
        service: SERVICE_NAME,
        enrollment_enabled: false,
        reason: "INDEPENDENT_ACCESS_AND_GROUP_TRUST_NOT_CONFIGURED"
      });
    }

    if (request.method === "POST" && url.pathname === "/v1/enrollments") {
      return jsonResponse(503, {
        error: {
          code: "PROVISIONER_NOT_CONFIGURED",
          message: "Enrollment is disabled until the dedicated Access identity and GROUP trust boundary are implemented and verified."
        }
      });
    }

    return jsonResponse(404, {
      error: { code: "NOT_FOUND", message: "The requested endpoint does not exist." }
    });
  }
};
