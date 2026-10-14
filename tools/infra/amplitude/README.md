# Saved Amplitude chart results

`amplitude chart-results <chart-URL-or-ID>` fetches the saved chart's CSV result
with the existing project API key and secret. Shared URLs with dashboard and
sharing query parameters work without extra credentials.

```text
amplitude chart-results 'https://app.amplitude.com/analytics/example/chart/abc123?sharingId=example'
```

This uses Amplitude's [Dashboard REST API endpoint for an existing chart](https://amplitude.com/docs/apis/analytics/dashboard-rest#get-results-from-an-existing-chart).
Dashboard URLs require a separate API path and are not handled by this command.
