"""Saved chart reads use the Developer API without changing Dashboard REST auth."""

import json

import httpx
import pytest
from centaur_tool_amplitude.client import AmplitudeClient

CHART_URL = (
    "https://app.amplitude.com/analytics/splits/chart/crzjkabd"
    "?linkingDashboardId=t2d1v8wc&sharingId=ssiZ-rqy"
)


def _client(handler):
    client = AmplitudeClient(developer_token="amp_test")
    client._client = httpx.Client(
        base_url="https://amplitude.com", transport=httpx.MockTransport(handler)
    )
    return client


def test_get_chart_from_shared_url_discovers_project_and_includes_definition():
    requests = []

    def handler(request):
        requests.append(request)
        assert request.headers["Authorization"] == "Bearer PAT=amp_test"
        assert request.url.host == "developer-api.amplitude.com"
        if request.url.path == "/v1/projects":
            if "cursor" not in request.url.params:
                return httpx.Response(
                    200,
                    json={"data": [{"id": "12345"}], "pagination": {"next_cursor": "next"}},
                )
            return httpx.Response(
                200,
                json={"data": [{"id": "67890"}], "pagination": {"next_cursor": None}},
            )
        if "/12345/" in request.url.path:
            return httpx.Response(404, json={"detail": "private"})
        assert request.url.params["include_definition"] == "true"
        return httpx.Response(
            200,
            json={"data": {"id": "crzjkabd", "project_id": "67890", "definition": {"events": []}}},
        )

    with _client(handler) as client:
        chart = client.get_chart(CHART_URL)

    assert chart["data"]["definition"] == {"events": []}
    assert len(requests) == 4
    assert requests[-1].url.path == "/v1/projects/67890/charts/crzjkabd"


def test_query_chart_uses_resolved_project_and_saved_settings():
    requests = []

    def handler(request):
        requests.append(request)
        if request.method == "GET":
            return httpx.Response(200, json={"data": {"id": "9pmbm4k7", "project_id": "12345"}})
        return httpx.Response(200, json={"data": {"result_kind": "scalar", "data": {"series": []}}})

    with _client(handler) as client:
        result = client.query_chart("9pmbm4k7", project_id="12345")

    assert result["data"]["result_kind"] == "scalar"
    assert requests[-1].method == "POST"
    assert requests[-1].url.path == "/v1/projects/12345/charts/9pmbm4k7/query"
    assert requests[-1].content == b"{}"


def test_chart_url_rejects_other_hosts_and_developer_errors_hide_response():
    with _client(lambda request: httpx.Response(403, text="sensitive response")) as client:
        with pytest.raises(RuntimeError, match="Expected an Amplitude chart URL"):
            client.get_chart("https://elsewhere.example/chart/crzjkabd", project_id="12345")
        with pytest.raises(RuntimeError, match="Developer API error: HTTP 403") as exc:
            client.get_chart(CHART_URL, project_id="12345")
    assert "sensitive response" not in str(exc.value)


def test_chart_results_uses_existing_project_credentials():
    def handler(request):
        assert request.url.host == "amplitude.com"
        assert request.url.path == "/api/3/chart/crzjkabd/csv"
        assert request.headers["Authorization"].startswith("Basic ")
        return httpx.Response(200, json={"data": "Segment,2026-10-14\norgs,3\n"})

    client = AmplitudeClient(api_key="project_key", secret_key="project_secret")
    client._client = httpx.Client(
        base_url="https://amplitude.com", transport=httpx.MockTransport(handler)
    )
    with client:
        result = client.chart_results(CHART_URL)

    assert result["data"] == "Segment,2026-10-14\norgs,3\n"


def test_dashboard_get_reads_mcp_object_with_brokered_auth():
    calls = []

    def handler(request):
        assert request.url.host == "mcp.amplitude.com"
        assert request.url.path == "/mcp"
        assert "Authorization" not in request.headers
        call = json.loads(request.content)
        calls.append(call["method"])
        if call["method"] == "initialize":
            return httpx.Response(
                200,
                headers={"Mcp-Session-Id": "test-session"},
                json={"jsonrpc": "2.0", "id": 1, "result": {"protocolVersion": "2025-03-26"}},
            )
        assert request.headers["Mcp-Session-Id"] == "test-session"
        if call["method"] == "notifications/initialized":
            assert "id" not in call
            return httpx.Response(202)
        assert call["method"] == "tools/call"
        assert call["params"] == {
            "name": "get_from_url",
            "arguments": {"url": "https://app.amplitude.com/analytics/splits/dashboard/t2d1v8wc"},
        }
        return httpx.Response(200, json={"jsonrpc": "2.0", "id": 1, "result": {"content": []}})

    client = AmplitudeClient()
    client._client = httpx.Client(transport=httpx.MockTransport(handler))
    with client:
        result = client.dashboard_get(
            "https://app.amplitude.com/analytics/splits/dashboard/t2d1v8wc"
        )

    assert result == {"content": []}
    assert calls == ["initialize", "notifications/initialized", "tools/call"]
