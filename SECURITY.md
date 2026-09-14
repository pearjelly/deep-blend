# Security policy

DeepBlend Studio is a **local** tool: it drives a Blender you installed, on your machine, under
your user account. It has no server, no account, and no telemetry. The interesting question is
therefore not "who can reach it" but **"what can the thing it drives reach"** — and that is
written down, per requirement, in [`deepblend/docs/security.md`](deepblend/docs/security.md).

## The trust boundary in one paragraph

The model driving a DeepBlend session can call sixteen tools. It cannot run a shell, write a
file, fetch a URL, run arbitrary Python, or install anything: the product preset's row set is
asserted by **equality**, so a row that should not be there fails the suite as loudly as one
that should. Blender is started as an argv array (never through a shell) with
`--background --factory-startup`, and the child's environment is a five-variable whitelist, so
neither your Blender add-ons nor your API keys travel into it. Two operations leave the machine
or cost real money — a final render above the configured frame threshold, and importing an
asset from a URL — and both **ask you first**; nothing else does. Everything the tool writes
lives inside the project directory, and the path guards compare realpaths, so a symlink is not
a way out.

## Reporting a vulnerability

Open a [private security advisory](https://github.com/pearjelly/deep-blend/security/advisories/new)
or email the maintainer at the address on the [GitHub profile](https://github.com/pearjelly).
Please do not open a public issue for something exploitable.

Useful in a report: what you ran, what you expected, what happened, and — if you got that far —
which of the controls in `deepblend/docs/security.md` you think failed. That document lists
exactly what is and is not enforced, including the six requirements this project knows it does
not meet, so "this is not enforced" may already be written down there with a reason; a report
that a control claimed as ✅ does not hold is the one that matters most.

There is no bounty programme and no response-time promise. This is a single-maintainer project.

## Supported versions

The `main` branch is the only supported version. Compatibility is pinned, not floating: the DSH
release this is built against is an anchor (`deepblend/tools/dsh-baseline.json`) and CI asserts
that the pin, the baseline document and the workflow all state the same version. Security fixes
land on `main`; there are no backports to older commits.

## What is out of scope

- **A malicious Blender build.** The managed install is verified by byte count and sha256
  against `deepblend/tools/blender-release.json`; a Blender you point `blenderPath` at yourself
  is trusted, as a deliberate operator choice.
- **A malicious model response.** The tool plane validates every argument against a schema and
  every result against the harness's own lossless-JSON rule; a model that asks for something
  forbidden gets a coded refusal, not an action.
- **Your own `$DSH_HOME`.** The installer refuses to overwrite an operator layer it did not
  write rather than guessing.
- **Denial of service through resource exhaustion.** CPU, memory and GPU quotas are NOT
  implemented — see deviation §7 #9 in `milestone-status.md`. A render can use the whole
  machine; that is a known gap, not a vulnerability report.
