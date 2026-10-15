#!/usr/bin/env python3
"""Verify published evidence without installing DSH or starting Blender."""
import hashlib
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent


def read(name):
    return json.loads((ROOT / name).read_text())


def digest(name):
    return hashlib.sha256((ROOT / name).read_bytes()).hexdigest()


def check(condition, message):
    if not condition:
        raise SystemExit("FAIL: " + message)


count = 0
for line in (ROOT / "SHA256SUMS").read_text().splitlines():
    expected, name = line.split("  ", 1)
    check((ROOT / name).resolve().is_relative_to(ROOT), "invalid checksum path")
    check(digest(name) == expected, "checksum mismatch: " + name)
    count += 1

versions = read("versions.json")
check(versions["deepblend"] == "0.11.0", "DeepBlend version")
check(versions["commit"] == "210b039d7d216df08cd732db20759b4c4ce332c4", "implementation commit")
check(digest("runtime-package-lock.json") == versions["runtimeLockSha256"], "dependency lock")
report = read("evidence/verification.json")
manifest = read("evidence/delivery-manifest.json")
before = read("evidence/before-resume.json")
check(report["ok"] and report["allPngsDecoded"], "recorded verification did not pass")
check(report["renderedRevision"] == manifest["revisionId"] == "r0001", "rendered revision")
check(report["currentRevision"] == "r0002", "current revision")
for filename, source in [("scene-r0001.blend", "checkpoint"), ("source-r0001.scene-spec.json", "sceneSpec")]:
    check(digest(filename) == manifest["source"][source]["sha256"], "source identity: " + source)
check(report["sceneSpecDigest"] == manifest["source"]["sceneSpecDigest"], "scene digest")
check(digest("final.mp4") == manifest["video"]["sha256"], "video identity")
check(set(report["frames"]) == set(map(str, range(1, 25))), "frame inventory")
for frame, expected in report["frames"].items():
    check(digest(f"frames/frame_{int(frame):04d}.png") == expected, "frame identity: " + frame)
for frame, expected in before["hashes"].items():
    check(report["frames"][frame] == expected, "preserved frame: " + frame)
events = [json.loads(line) for line in (ROOT / "evidence/final-events.jsonl").read_text().splitlines()]
actual = [event["frame"] for event in events if event["type"] == "frame"]
check(actual == report["resumedFrames"] == read("evidence/final-plan.json")["frames"], "resume plan/journal")
check(sorted(actual) == sorted(before["ledger"]["toRender"]), "resume set")
check(set(actual).isdisjoint(report["preservedFrames"]), "preserved frames were re-rendered")
check(manifest["video"]["verified"], "recorded video probe")
check(manifest["render"]["provenance"]["coverage"] == "complete", "frame provenance")
check(manifest["render"]["provenance"]["configuration"] == "uniform", "render configuration")
print(f"PASS: {count} file checksums; source, frame, video and recovery evidence identities match.")
print("This verifies the published evidence. Run node repro.mjs run to repeat the Blender test.")
