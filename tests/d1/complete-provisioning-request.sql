UPDATE worker_provisioning_requests
SET state = 'COMPLETED',
    worker_id = 'worker-d1-revoked',
    outcome_code = 'ENROLLED',
    outcome_json = '{}',
    completed_at = '2026-11-28T10:05:00Z',
    updated_at = '2026-11-28T10:05:00Z'
WHERE provisioning_request_id = 'request-d1-test';
