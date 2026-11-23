# Phase 0 spikes

Throwaway scripts behind [docs/spikes/phase-0.md](../docs/spikes/phase-0.md). Not part of the product or the pipeline.

```sh
uv venv .venv && uv pip install --python .venv/bin/python e2b
.venv/bin/python s1_docker.py   # needs E2B_API_KEY, or ~/.config/workz/e2b.env
```

Each script creates real E2B sandboxes and kills them when it finishes.
