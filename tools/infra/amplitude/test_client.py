"""Saved chart URLs use the existing Dashboard REST credentials."""

import httpx
import pytest
from centaur_tool_amplitude.client import AmplitudeClient


@pytest.mark.parametrize(
    "chart",
    ["abc123", "https://app.amplitude.com/analytics/example/chart/abc123?sharingId=example"],
)
def test_chart_results_uses_project_credentials(chart):
    def handler(request):
        assert request.method == "GET"
        assert request.url == "https://amplitude.com/api/3/chart/abc123/csv"
        assert request.headers["Authorization"].startswith("Basic ")
        return httpx.Response(200, json={"data": "Segment,2026-10-14\norgs,3\n"})

    client = AmplitudeClient(api_key="project_key", secret_key="project_secret")
    client._client = httpx.Client(
        base_url="https://amplitude.com", transport=httpx.MockTransport(handler)
    )
    with client:
        result = client.chart_results(chart)

    assert result == {"data": "Segment,2026-10-14\norgs,3\n"}


def test_chart_results_rejects_other_hosts_before_request():
    client = AmplitudeClient(api_key="project_key", secret_key="project_secret")
    with pytest.raises(RuntimeError, match="Expected an Amplitude chart URL"):
        client.chart_results("https://other.example/analytics/splits/chart/crzjkabd")
