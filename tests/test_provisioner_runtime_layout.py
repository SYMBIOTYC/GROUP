import json
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
PROVISIONER = ROOT / "provisioner"


class ProvisionerRuntimeLayoutTests(unittest.TestCase):
    def test_runtime_has_dedicated_worker_identity_and_private_group_binding(self):
        config = json.loads((PROVISIONER / "wrangler.jsonc").read_text(encoding="utf-8"))
        self.assertEqual(config["name"], "symbiotyc-group-provisioner")
        self.assertEqual(config["main"], "src/index.mjs")
        self.assertFalse(config["workers_dev"])
        self.assertFalse(config["preview_urls"])
        self.assertEqual(
            config["services"],
            [{"binding": "GROUP", "service": "symbiotyc-group-control-plane"}],
        )

    def test_provisioner_has_no_database_or_signing_key_binding(self):
        config = json.loads((PROVISIONER / "wrangler.jsonc").read_text(encoding="utf-8"))
        self.assertNotIn("d1_databases", config)
        self.assertNotIn("kv_namespaces", config)
        self.assertNotIn("vars", config)
        self.assertNotIn("secrets", config)

    def test_runtime_is_quarantined_until_access_and_group_trust_are_implemented(self):
        source = (PROVISIONER / "src" / "index.mjs").read_text(encoding="utf-8")
        self.assertIn('"/health"', source)
        self.assertIn("PROVISIONER_NOT_CONFIGURED", source)
        self.assertIn("enrollment_enabled: false", source)
        self.assertNotIn("env.GROUP.fetch", source)
        self.assertNotIn("x-symbiotyc-caller", source)


if __name__ == "__main__":
    unittest.main()
