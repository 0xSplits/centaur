# Saved Amplitude charts

`chart-results` uses the existing project API key and secret to return the
saved chart's current CSV result. It accepts a chart ID or a shared chart URL,
including its query parameters. No additional credential is required for this
command.

`chart-get` and `chart-query` use Amplitude's Developer API for a structured
chart definition and normalized query result. These commands are optional.
With no `--project-id`, the tool lists the PAT's accessible projects and checks
them for the chart.

`dashboard-get` calls Amplitude MCP's `get_from_url` tool to read a dashboard
and its chart references. This path needs a read-only Amplitude OAuth connection
to `mcp.amplitude.com`. After deploying the Console provider, an operator must
connect the shared Amplitude account, grant its brokered credential to the
assistant principal, and verify `mcp-tools` against the live server. The MCP
tool schema and OAuth identity lookup have not yet been verified with a live
Amplitude OAuth connection. Use `chart-results` on each returned chart ID for
its saved results.

For optional structured chart reads, provision a **raw Amplitude Personal Access
Token** with `projects:read` and `analytics:read` as `AMPLITUDE_PAT`, then grant
it to the Amplitude tool for `developer-api.amplitude.com`. The client adds
`Bearer PAT=`; do not store that prefix with the secret.

```text
amplitude chart-results 'https://app.amplitude.com/analytics/splits/chart/crzjkabd?linkingDashboardId=t2d1v8wc&sharingId=ssiZ-rqy'
amplitude chart-get 'https://app.amplitude.com/analytics/splits/chart/crzjkabd?linkingDashboardId=t2d1v8wc&sharingId=ssiZ-rqy'
amplitude chart-query 'https://app.amplitude.com/analytics/splits/chart/crzjkabd?linkingDashboardId=t2d1v8wc&sharingId=ssiZ-rqy'
amplitude dashboard-get 'https://app.amplitude.com/analytics/splits/dashboard/t2d1v8wc'
```

`chart-results` returns the Dashboard REST API's CSV output, including visible
chart formula, filters, and values. `chart-get` includes the chart's read-only
definition. `chart-query` uses its saved filters and time range. The Developer
API currently computes only event segmentation, sessions, funnels, and retention
charts; other chart types can still be inspected with `chart-get` but return
HTTP 422 on `chart-query`.

See [Amplitude Developer API authentication](https://amplitude.com/docs/developers/cli/authentication),
[Dashboard REST saved chart results](https://amplitude.com/docs/apis/analytics/dashboard-rest#get-results-from-an-existing-chart),
[Get chart](https://amplitude.com/docs/apis/developer/analytics/get-chart), and
[Query chart](https://amplitude.com/docs/apis/developer/analytics/query-chart).
The [Amplitude MCP](https://amplitude.com/docs/amplitude-ai/amplitude-mcp)
documents its `get_from_url` dashboard read and OAuth access.
