import hashlib
import unittest
from pathlib import Path


class BootstrapContractTests(unittest.TestCase):
    def test_spec_checksum_manifest(self):
        root = Path(__file__).resolve().parents[1]
        spec = root / "spec"
        expected = {}
        for line in (spec / "SHA256SUMS").read_text(encoding="ascii").splitlines():
            digest, name = line.split("  ", 1)
            expected[name] = digest
        required = {"instruction.md", "knowledge_base.json", "task.md"}
        optional = {"commands.json", "community.yml", "roadmap.json"}
        self.assertLessEqual(required, set(expected))
        self.assertLessEqual(set(expected), required | optional)
        for name, digest in expected.items():
            self.assertEqual(digest, hashlib.sha256((spec / name).read_bytes()).hexdigest())


if __name__ == "__main__":
    unittest.main()
