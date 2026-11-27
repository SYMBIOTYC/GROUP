import json
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[1]
CONTRACTS = ROOT / "contracts"


class ContractSchemaTests(unittest.TestCase):
    def load_schema(self, name):
        schema = json.loads((CONTRACTS / name).read_text(encoding="utf-8"))
        Draft202012Validator.check_schema(schema)
        return Draft202012Validator(schema, format_checker=FormatChecker())

    def test_all_protocol_schemas_are_valid_json_schema(self):
        for path in sorted(CONTRACTS.glob("*.schema.json")):
            with self.subTest(schema=path.name):
                schema = json.loads(path.read_text(encoding="utf-8"))
                Draft202012Validator.check_schema(schema)

    def test_job_intent_accepts_bounded_allowlisted_request_shape(self):
        validator = self.load_schema("job-intent-v1.schema.json")
        valid = {
            "protocol": "symbiotyc.compute.v1",
            "schema_version": "1.0",
            "operation_id": "image.thumbnail",
            "input": {"source_ref": "artifact:opaque-123"},
            "constraints": {
                "worker_pool": "CLOUD-CPU",
                "cpu_millis": 1000,
                "memory_mib": 512,
                "timeout_seconds": 120,
                "max_attempts": 2
            },
            "output_policy": {"format": "json", "max_bytes": 1048576}
        }
        self.assertTrue(validator.is_valid(valid))

    def test_job_intent_rejects_tenant_identity_in_request_body(self):
        validator = self.load_schema("job-intent-v1.schema.json")
        invalid = {
            "protocol": "symbiotyc.compute.v1",
            "schema_version": "1.0",
            "operation_id": "image.thumbnail",
            "input": {},
            "constraints": {},
            "output_policy": {"format": "json", "max_bytes": 1024},
            "tenant_id": "attacker-selected-tenant"
        }
        self.assertFalse(validator.is_valid(invalid))

    def test_worker_registration_cannot_self_assign_trust_or_tenant(self):
        validator = self.load_schema("worker-registration-v1.schema.json")
        invalid = {
            "protocol": "symbiotyc.compute.v1",
            "schema_version": "1.0",
            "worker_pool": "CLOUD-CPU",
            "provider": "cloud",
            "region": "eu",
            "runtime": {"os": "linux", "architecture": "x86_64", "version": "1"},
            "capabilities": ["cpu"],
            "capacity": {"cpu_millis": 1000, "memory_mib": 1024, "ephemeral_disk_mib": 1024, "max_concurrency": 1},
            "supported_protocols": ["symbiotyc.compute.v1"],
            "trust_level": "trusted",
            "tenant_id": "tenant-1"
        }
        self.assertFalse(validator.is_valid(invalid))

    def test_heartbeat_requires_monotonic_sequence_and_registration_epoch(self):
        validator = self.load_schema("worker-heartbeat-v1.schema.json")
        valid = {
            "protocol": "symbiotyc.compute.v1",
            "schema_version": "1.0",
            "registration_epoch": "epoch-0123456789abcdef",
            "sequence": 1,
            "observed_at": "2026-11-28T00:00:00Z",
            "health": "healthy",
            "capacity": {
                "available_cpu_millis": 500,
                "available_memory_mib": 512,
                "available_disk_mib": 1024,
                "running_executions": 0
            }
        }
        self.assertTrue(validator.is_valid(valid))
        valid["sequence"] = 0
        self.assertFalse(validator.is_valid(valid))

    def test_worker_result_is_not_allowed_to_set_job_terminal_state(self):
        validator = self.load_schema("task-result-v1.schema.json")
        invalid = {
            "protocol": "symbiotyc.compute.v1",
            "schema_version": "1.0",
            "job_id": "b5d6b8c6-79ec-4e45-86e7-5c9f0e36d0ad",
            "execution_id": "c9a6b8c6-79ec-4e45-86e7-5c9f0e36d0ad",
            "worker_id": "worker-1",
            "lease_id": "lease-0123456789abcdef",
            "outcome": "completed",
            "finished_at": "2026-11-28T00:00:00Z",
            "job_state": "SUCCEEDED"
        }
        self.assertFalse(validator.is_valid(invalid))


if __name__ == "__main__":
    unittest.main()
