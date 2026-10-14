# Saved Amplitude charts

The Dashboard REST API key and secret used by the existing commands cannot read
saved chart definitions. `chart-get` and `chart-query` use Amplitude's Developer
API instead. They accept a chart ID or a shared chart URL, including its query
parameters. With no `--project-id`, the tool lists the PAT's accessible projects
and checks them for the chart.

Provision a **raw Amplitude Personal Access Token** with `projects:read` and
`analytics:read` in the configured secret source as `AMPLITUDE_PAT`, then grant
that optional secret to the Amplitude tool for `developer-api.amplitude.com`.
The client adds `Bearer PAT=` and the proxy replaces the token placeholder in
the Authorization header. Do not store the prefix with the secret.

```text
amplitude chart-get 'https://app.amplitude.com/analytics/splits/chart/crzjkabd?linkingDashboardId=t2d1v8wc&sharingId=ssiZ-rqy'
amplitude chart-query 'https://app.amplitude.com/analytics/splits/chart/crzjkabd?linkingDashboardId=t2d1v8wc&sharingId=ssiZ-rqy'
```

`chart-get` includes the chart's read-only definition. `chart-query` uses its
saved filters and time range. The Developer API currently computes only event
segmentation, sessions, funnels, and retention charts; other chart types can
still be inspected with `chart-get` but return HTTP 422 on `chart-query`.

See [Amplitude Developer API authentication](https://amplitude.com/docs/developers/cli/authentication),
[Get chart](https://amplitude.com/docs/apis/developer/analytics/get-chart), and
[Query chart](https://amplitude.com/docs/apis/developer/analytics/query-chart).
