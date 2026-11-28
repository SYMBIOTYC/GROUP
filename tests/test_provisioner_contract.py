import json
import unittest
from pathlib import Path

from jsonschema import Draft202012Validator, FormatChecker

ROOT = Path(__file__).resolve().parents[1]
CONTRACTS = ROOT / "contracts"


class ProvisionerContractTests(unittest.TestCase):
    def load_validator(self, name):
        schema = json.loads((CONTRACTS / name).read_text(encoding="utf-8"))
        Draft202012Validator.check_schema(schema)
        return Draft202012Validator(schema, format_checker=FormatChecker())

    def test_provisioner_enrollment_request_accepts_bounded_host_metadata(self):
        validator = self.load_validator("provisioner-enrollment-request-v1.schema.json")
        valid = {
            "protocol": "symbiotyc.compute.v1", "schema_version": "1.0",
            "worker_pool": "CLOUD-CPU", "provider": "linux_host", "region": "eu-west",
            "runtime": {"os": "linux", "architecture": "x86_64", "version": "1"},
            "capacity": {"cpu_millis": 2000, "memory_mib": 4096,
                         "ephemeral_disk_mib": 20480, "max_concurrency": 2}
        }
        self.assertTrue(validator.is_valid(valid))

    def test_provisioner_request_rejects_caller_selected_identity_and_trust(self):
        validator = self.load_validator("provisioner-enrollment-request-v1.schema.json")
        invalid = {
            "protocol": "symbiotyc.compute.v1", "schema_version": "1.0",
            "worker_pool": "CLOUD-CPU", "provider": "linux_host", "region": "eu-west",
            "runtime": {"os": "linux", "architecture": "x86_64", "version": "1"},
            "capacity": {"cpu_millis": 2000, "memory_mib": 4096,
                         "ephemeral_disk_mib": 20480, "max_concurrency": 2},
            "tenant_id": "attacker-tenant", "project_id": "attacker-project",
            "worker_id": "attacker-worker", "trust_class": "isolated",
            "capabilities": ["admin"], "provisioner_subject": "forged"
        }
        self.assertFalse(validator.is_valid(invalid))

    def test_provisioner_request_rejects_capacity_above_schema_ceiling(self):
        validator = self.load_validator("provisioner-enrollment-request-v1.schema.json")
        invalid = {
            "protocol": "symbiotyc.compute.v1", "schema_version": "1.0",
            "worker_pool": "CLOUD-VPS", "provider": "fly", "region": "eu",
            "runtime": {"os": "linux", "architecture": "x86_64", "version": "1"},
            "capacity": {"cpu_millis": 1048577, "memory_mib": 4096,
                         "ephemeral_disk_mib": 20480, "max_concurrency": 2}
        }
        self.assertFalse(validator.is_valid(invalid))

    def test_worker_enrollment_proof_accepts_one_time_challenge_shape(self):
        validator = self.load_validator("worker-enrollment-proof-v1.schema.json")
        valid = {
            "protocol": "symbiotyc.compute.v1", "schema_version": "1.0",
            "challenge_id": "8f3a5c2e-0c4d-4f88-a55b-29bbab90f999",
            "challenge": "A" * 43
        }
        self.assertTrue(validator.is_valid(valid))

    def test_worker_enrollment_proof_rejects_identity_override_and_extra_fields(self):
        validator = self.load_validator("worker-enrollment-proof-v1.schema.json")
        invalid = {
            "protocol": "symbiotyc.compute.v1", "schema_version": "1.0",
            "challenge_id": "8f3a5c2e-0c4d-4f88-a55b-29bbab90f999",
            "challenge": "A" * 43, "tenant_id": "attacker-tenant",
            "registration_epoch": 999
        }
        self.assertFalse(validator.is_valid(invalid))


if __name__ == "__main__":
    unittest.main()
