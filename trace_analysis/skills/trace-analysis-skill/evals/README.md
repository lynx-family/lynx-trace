# Source preparation behavioral evaluations

`evals.json` contains Agent conversation scenarios and observable grading criteria. Cases 23–29
reproduce the source-preparation failures; cases 1, 4–7, 16–17 use the current automatic runtime
preparation/retry policy. The companion analyzer suite is in
`vmsdkcli/ai/skills/js-memory-analyzer/evals/evals.json`.
Cases 30–32 cover the inclusive `4.5.0` Trace-version floor, an existing but invalid old tag,
numeric version comparison and mixed-process version scope.

Run each conversation with the local generated Trace Skill and local analyzer. Supply isolated
fixture repositories/artifacts and controlled tool responses where the prompt names them; placeholder
URLs must not be fetched from the public network. Grade actual tool calls and final output, not just
whether the Agent recites the policy. For a waiting case, any heap analysis, finalization, publication
or final report delivery before the answer fails that case. For an automatic-success case, an
unnecessary consent question fails it. Continue replacement cases with at least two failing locators,
then a matched locator or an explicit scoped opt-out; verify that the source project stays unchanged.

Separately run deterministic CLI/state regressions after building `packages/trace_query`:

```bash
npm run test:source-preparation
# Optional real local Trace and offline rerender; set TRACE_PROCESSOR_SHELL_URL to a local binary.
npm run test:source-preparation -- /absolute/sample.pftrace
```

The CLI suite checks early rejection, recorded opt-outs, stale manifests, final binding conflicts,
snapshot coverage, legacy/offline input, and optional evidence gaps. It does not execute Agent
conversations. JSON validation, prompt inspection and passing CLI tests must not be reported as
passing these behavioral scenarios. Record model/version, tool fixtures, conversation, per-expectation
verdicts and limitations when a full Agent evaluation is run.
