"""Saved chart reads use the Developer API without changing Dashboard REST auth."""

import httpx
import pytest
from centaur_tool_amplitude.client import AmplitudeClient

CHART_URL = (
    "https://app.amplitude.com/analytics/splits/chart/crzjkabd"
    "?linkingDashboardId=t2d1v8wc&sharingId=ssiZ-rqy"
)


def _client(handler):
    client = AmplitudeClient(developer_token="amp_test")
    client._client = httpx.Client(transport=httpx.MockTransport(handler))
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
