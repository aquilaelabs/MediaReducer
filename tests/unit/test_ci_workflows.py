"""The CI workflows, where getting them wrong is silent: a job that queues for
24 hours waiting for a runner that does not exist, a commit tested twice, or a
release built without the suite having run on it.
"""
import re
import sys
import pathlib

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
WF = ROOT / ".github" / "workflows"

ok = True


def check(name, cond, extra=None):
    global ok
    print(("PASS " if cond else "FAIL ") + name + ("" if cond else f"   {extra!r}"))
    ok = ok and cond


def load(name):
    d = yaml.safe_load((WF / name).read_text())
    # YAML 1.1 reads a bare `on:` as the boolean True, which is exactly the key
    # every GitHub workflow uses. Both spellings, so this does not depend on
    # which YAML version the installed parser follows.
    d["on"] = d.get("on", d.get(True))
    return d


tests = load("tests.yml")
publish = load("publish.yml")

# ── Where the jobs run ───────────────────────────────────────────────────────
# A public repo gets GitHub's runners free, and no runner of ours is attached
# to it: a self-hosted label here queues every run for 24 hours and expires.
check("the test job runs on a hosted runner",
      tests["jobs"]["tests"]["runs-on"] == "ubuntu-latest",
      tests["jobs"]["tests"]["runs-on"])
# The publish job builds and boots a Docker image. It runs in the
# same place, and the runner must be GitHub's.
check("the publish job stays on a hosted runner",
      publish["jobs"]["publish"]["runs-on"] == "ubuntu-latest",
      publish["jobs"]["publish"]["runs-on"])
# A self-hosted runner with the docker socket is root on the host, and that is
# the one thing the container hardening is careful not to hand out.
check("nothing asks for the docker socket",
      not any("docker.sock" in p.read_text() for p in WF.glob("*.yml")))

# ── How often it runs ────────────────────────────────────────────────────────
# push and pull_request are separate concurrency groups, so when both fire for
# one commit neither cancels the other and the whole suite runs twice.
triggers = tests["on"]
push = triggers.get("push") or {}
branches = push.get("branches") or []
check("push and pull_request cannot both fire for one commit",
      "pull_request" not in triggers or "**" not in branches,
      {"push.branches": branches, "pull_request": "pull_request" in triggers})
# Fork pull requests never fire `push` on this repo, so dropping the trigger
# would leave outside contributions untested where that matters.
check("...with pull_request kept, since that is how the public repo sees a fork",
      "pull_request" in triggers, sorted(map(str, triggers)))
check("a branch with no pull request can still be run by hand",
      "workflow_dispatch" in triggers, sorted(map(str, triggers)))

# A newer push makes an older run pointless; without this they queue up behind
# each other.
check("an in-flight run is cancelled by a newer one",
      tests.get("concurrency", {}).get("cancel-in-progress") is True,
      tests.get("concurrency"))

# ── The checks that skip themselves when a tool is missing ───────────────────
# Both are deliberate: a contributor's laptop runs the suite without pyflakes
# or ESLint and still gets a useful answer. Here that would be a green build
# proving less than it looks like it does, so the workflow has to install them.
_tests_yml = (WF / "tests.yml").read_text()
for tool, why in (("pyflakes", "test_no_undefined_names"),
                  ("eslint", "test_js_lint")):
    check(f"CI installs {tool}, or {why} silently checks nothing",
          re.search(rf"\b{tool}[@=\s]", _tests_yml) is not None)

# ── When the suite does NOT run ──────────────────────────────────────────────
# Never. A release arrives through publish.yml's workflow_call, and inside a
# called workflow the github context belongs to the CALLER, so a tag push
# reads as event_name 'push' in here too. Any condition on the job risks
# skipping the very suite the release gates on, and `needs:` treats a skipped
# job as satisfied rather than failed, so the image would build having tested
# nothing.
check("the test job has no condition that could skip it",
      "if" not in tests["jobs"]["tests"], tests["jobs"]["tests"].get("if"))

# ── The release gate ─────────────────────────────────────────────────────────
# The image is what deletes people's files. It must not be buildable without
# the suite passing on the exact commit being tagged.
check("publishing still runs the suite first",
      str(publish["jobs"]["tests"].get("uses", "")).endswith("tests.yml"),
      publish["jobs"]["tests"])
check("...and the build waits for it",
      publish["jobs"]["publish"].get("needs") == "tests",
      publish["jobs"]["publish"].get("needs"))

print("RESULT:", "PASS" if ok else "FAIL")
sys.exit(0 if ok else 1)
