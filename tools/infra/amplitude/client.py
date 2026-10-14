"""Amplitude Dashboard REST, Taxonomy, and Developer API client.

Queries events with the Dashboard REST API and reads the tracking plan with the
Taxonomy API. Those calls use HTTP Basic with the project's API key and secret.

Saved chart results use the Dashboard REST API. Structured definitions can use
the Developer API with an optional read-only PAT; dashboards use OAuth MCP.
"""

import base64
import json
import os
import re
from urllib.parse import urlparse

import httpx

from centaur_sdk import secret

_US_HOST = "amplitude.com"
_EU_HOST = "analytics.eu.amplitude.com"
_DEVELOPER_HOST = "developer-api.amplitude.com"
_MCP_URL = "https://mcp.amplitude.com/mcp"
_CHART_PATH = re.compile(r"^/analytics/[^/]+/chart/([A-Za-z0-9_-]+)/?$")


class ChartNotFoundError(RuntimeError):
    """A saved chart is absent from one accessible project."""


def _fmt_date(value: str) -> str:
    """Normalize a date to Amplitude's YYYYMMDD format.

    Accepts YYYY-MM-DD, YYYY/MM/DD, or YYYYMMDD.
    """
    return value.replace("-", "").replace("/", "").strip()


class AmplitudeClient:
    """Client for Amplitude's Dashboard REST, Taxonomy, and Developer APIs.

    Requires a project API key and secret key (Settings > Projects > General).
    Set AMPLITUDE_REGION to "eu" for EU-residency projects.
    """

    def __init__(
        self,
        api_key: str | None = None,
        secret_key: str | None = None,
        developer_token: str | None = None,
        region: str | None = None,
        timeout: float = 60.0,
    ):
        """Initialize the Amplitude client.

        Args:
            api_key: Project API key (or set AMPLITUDE_API_KEY)
            secret_key: Project secret key (or set AMPLITUDE_SECRET_KEY)
            developer_token: Raw Personal Access Token for saved chart reads
            region: Data residency region, "us" (default) or "eu"
            timeout: Request timeout in seconds
        """
        self._api_key = api_key
        self._secret_key = secret_key
        self._developer_token = developer_token
        self._region = region
        self.timeout = timeout
        self._client: httpx.Client | None = None

    @property
    def region(self) -> str:
        region = self._region or os.getenv("AMPLITUDE_REGION", "us")  # noqa: TID251
        return region.strip().lower()

    @property
    def host(self) -> str:
        return _EU_HOST if self.region == "eu" else _US_HOST

    @property
    def base_url(self) -> str:
        return f"https://{self.host}"

    def _credentials(self) -> tuple[str, str]:
        api_key = self._api_key or secret("AMPLITUDE_API_KEY", "")
        secret_key = self._secret_key or secret("AMPLITUDE_SECRET_KEY", "")
        if not api_key or not secret_key:
            raise RuntimeError(
                "AMPLITUDE_API_KEY and AMPLITUDE_SECRET_KEY must be set "
                "(Settings > Projects > General in Amplitude)."
            )
        return api_key, secret_key

    def _auth_header(self) -> str:
        api_key, secret_key = self._credentials()
        token = base64.b64encode(f"{api_key}:{secret_key}".encode()).decode()
        return f"Basic {token}"

    @property
    def client(self) -> httpx.Client:
        if self._client is None:
            self._client = httpx.Client(base_url=self.base_url, timeout=self.timeout)
        return self._client

    def _request(
        self,
        method: str,
        endpoint: str,
        params: dict | list | None = None,
    ) -> dict:
        """Make an authenticated Dashboard REST / Taxonomy API request.

        Args:
            method: HTTP method (GET, POST, etc.)
            endpoint: API endpoint path
            params: Query parameters (dict, or list of tuples for repeated keys)

        Returns:
            JSON response data

        Raises:
            RuntimeError: If the request fails
        """
        headers = {"Authorization": self._auth_header()}
        try:
            response = self.client.request(method, endpoint, headers=headers, params=params)
            response.raise_for_status()
            return response.json()
        except httpx.HTTPStatusError as e:
            raise RuntimeError(f"API error: {e.response.status_code} - {e.response.text}") from e
        except httpx.RequestError as e:
            raise RuntimeError(f"Request failed: {e}") from e

    def _developer_request(self, method: str, endpoint: str, **kwargs) -> dict:
        """Call the Developer API without exposing token or error response bodies."""
        token = self._developer_token or secret("AMPLITUDE_PAT", "")
        if not token:
            raise RuntimeError("AMPLITUDE_PAT is not configured")
        try:
            response = self.client.request(
                method,
                f"https://{_DEVELOPER_HOST}{endpoint}",
                headers={"Authorization": f"Bearer PAT={token}"},
                **kwargs,
            )
            response.raise_for_status()
            result = response.json()
            if not isinstance(result, dict):
                raise RuntimeError("Developer API returned an unexpected response")
            return result
        except httpx.HTTPStatusError as exc:
            if exc.response.status_code == 404:
                raise ChartNotFoundError("Chart not found in project") from exc
            raise RuntimeError(f"Developer API error: HTTP {exc.response.status_code}") from exc
        except httpx.RequestError as exc:
            raise RuntimeError(f"Developer API request failed ({type(exc).__name__})") from exc

    @staticmethod
    def _chart_id(value: str) -> str:
        """Accept a chart ID or the chart URL shared from Amplitude."""
        if re.fullmatch(r"[A-Za-z0-9_-]+", value):
            return value
        parsed = urlparse(value)
        match = _CHART_PATH.fullmatch(parsed.path)
        if parsed.scheme != "https" or parsed.hostname != "app.amplitude.com" or not match:
            raise RuntimeError("Expected an Amplitude chart URL or chart ID")
        return match.group(1)

    def _project_ids(self) -> list[str]:
        """List every project visible to the PAT so a shared URL needs no project ID."""
        project_ids: list[str] = []
        cursor = None
        while True:
            params = {"limit": 200}
            if cursor:
                params["cursor"] = cursor
            result = self._developer_request("GET", "/v1/projects", params=params)
            project_ids.extend(str(project["id"]) for project in result["data"])
            cursor = result.get("pagination", {}).get("next_cursor")
            if not cursor:
                return project_ids

    def get_chart(self, value: str, project_id: str | None = None) -> dict:
        """Read a saved chart definition from a shared URL or ID."""
        chart_id = self._chart_id(value)
        project_ids = [project_id] if project_id else self._project_ids()
        for candidate in project_ids:
            if not candidate or not candidate.isdigit():
                raise RuntimeError("Project ID must be numeric")
            try:
                return self._developer_request(
                    "GET",
                    f"/v1/projects/{candidate}/charts/{chart_id}",
                    params={"include_definition": "true"},
                )
            except ChartNotFoundError:
                continue
        raise RuntimeError("Chart not found in accessible Amplitude projects")

    def query_chart(self, value: str, project_id: str | None = None) -> dict:
        """Compute a saved chart using its own saved configuration and time range."""
        chart = self.get_chart(value, project_id)
        chart_data = chart["data"]
        return self._developer_request(
            "POST",
            f"/v1/projects/{chart_data['project_id']}/charts/{chart_data['id']}/query",
            json={},
        )

    def chart_results(self, value: str) -> dict:
        """Get saved chart results with the project's existing API key and secret."""
        chart_id = self._chart_id(value)
        return self._request("GET", f"/api/3/chart/{chart_id}/csv")

    def _mcp_rpc(self, method: str, params: dict | None = None) -> dict:
        """Call Amplitude's read-only MCP connection through brokered OAuth."""
        session_id = None
        if method != "initialize":
            initialized, session_id = self._mcp_post(
                "initialize",
                {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {"name": "centaur-amplitude", "version": "1.0"},
                },
            )
            if not initialized.get("protocolVersion"):
                raise RuntimeError("Amplitude MCP initialization failed")
            self._mcp_post(
                "notifications/initialized", {}, session_id=session_id, notification=True
            )
        result, _ = self._mcp_post(method, params, session_id=session_id)
        return result

    def _mcp_post(
        self,
        method: str,
        params: dict | None,
        *,
        session_id: str | None = None,
        notification: bool = False,
    ) -> tuple[dict, str | None]:
        headers = {"Accept": "application/json, text/event-stream"}
        if session_id:
            headers["Mcp-Session-Id"] = session_id
        message = {"jsonrpc": "2.0", "method": method, "params": params or {}}
        if not notification:
            message["id"] = 1
        try:
            response = self.client.post(
                _MCP_URL,
                headers=headers,
                json=message,
            )
            response.raise_for_status()
        except httpx.HTTPStatusError as exc:
            raise RuntimeError(f"Amplitude MCP error: HTTP {exc.response.status_code}") from exc
        except httpx.RequestError as exc:
            raise RuntimeError(f"Amplitude MCP request failed ({type(exc).__name__})") from exc
        if notification:
            return {}, response.headers.get("mcp-session-id", session_id)
        if response.headers.get("content-type", "").startswith("text/event-stream"):
            messages = [
                line[6:] for line in response.text.splitlines() if line.startswith("data: ")
            ]
            if not messages:
                raise RuntimeError("Amplitude MCP returned an empty event stream")
            payload = json.loads(messages[-1])
        else:
            payload = response.json()
        if not isinstance(payload, dict) or "error" in payload or "result" not in payload:
            raise RuntimeError(f"Amplitude MCP {method} failed")
        return payload["result"], response.headers.get("mcp-session-id", session_id)

    def mcp_tools(self) -> dict:
        """List the available MCP tool schemas for dashboard and chart reads."""
        return self._mcp_rpc("tools/list")

    def dashboard_get(self, url: str) -> dict:
        """Read an Amplitude dashboard definition, including its chart links."""
        parsed = urlparse(url)
        if (
            parsed.scheme != "https"
            or parsed.hostname != "app.amplitude.com"
            or not re.fullmatch(r"/analytics/[^/]+/dashboard/[A-Za-z0-9_-]+/?", parsed.path)
        ):
            raise RuntimeError("Expected an Amplitude dashboard URL")
        result = self._mcp_rpc("tools/call", {"name": "get_from_url", "arguments": {"url": url}})
        if result.get("isError"):
            raise RuntimeError("Amplitude MCP could not read the dashboard")
        return result

    def _event_spec(
        self,
        event_type: str,
        filters: list[dict] | None = None,
        group_by: list[dict] | None = None,
    ) -> str:
        """Build the compact JSON for a Dashboard REST `e` event parameter."""
        spec: dict = {"event_type": event_type}
        if filters:
            spec["filters"] = filters
        if group_by:
            spec["group_by"] = group_by
        return json.dumps(spec, separators=(",", ":"))

    def segmentation(
        self,
        event: str,
        start: str,
        end: str,
        metric: str = "totals",
        interval: int = 1,
        group_by: str | None = None,
        group_by_type: str = "event",
        segment: list[dict] | None = None,
        limit: int = 100,
    ) -> dict:
        """Event segmentation — counts/uniques of an event over time.

        Args:
            event: Event type (use "_all" for any active event)
            start: Start date (YYYYMMDD or YYYY-MM-DD)
            end: End date (YYYYMMDD or YYYY-MM-DD)
            metric: uniques, totals, pct_dau, average, histogram, sums, value_avg
            interval: 1 (daily), 7 (weekly), 30 (monthly)
            group_by: Property to break down by (optional, up to one here)
            group_by_type: "event" or "user" property for group_by
            segment: Segment filter definitions (JSON array)
            limit: Max breakdown groups returned

        Returns:
            Segmentation series data
        """
        gb = [{"type": group_by_type, "value": group_by}] if group_by else None
        params: list[tuple[str, str]] = [
            ("e", self._event_spec(event, group_by=gb)),
            ("start", _fmt_date(start)),
            ("end", _fmt_date(end)),
            ("m", metric),
            ("i", str(interval)),
            ("limit", str(limit)),
        ]
        if segment:
            params.append(("s", json.dumps(segment, separators=(",", ":"))))
        return self._request("GET", "/api/2/events/segmentation", params=params)

    def funnel(
        self,
        events: list[str],
        start: str,
        end: str,
        mode: str = "ordered",
        conversion_window_days: int | None = None,
    ) -> dict:
        """Funnel conversion across an ordered sequence of events.

        Args:
            events: Event types in step order (one `e` param per step)
            start: Start date (YYYYMMDD or YYYY-MM-DD)
            end: End date (YYYYMMDD or YYYY-MM-DD)
            mode: ordered, unordered, or sequential
            conversion_window_days: Conversion window in days (optional)

        Returns:
            Funnel conversion data
        """
        params: list[tuple[str, str]] = [("e", self._event_spec(e)) for e in events]
        params += [
            ("start", _fmt_date(start)),
            ("end", _fmt_date(end)),
            ("mode", mode),
        ]
        if conversion_window_days is not None:
            params.append(("cs", str(conversion_window_days * 86_400_000)))
        return self._request("GET", "/api/2/funnels", params=params)

    def retention(
        self,
        start_event: str,
        return_event: str,
        start: str,
        end: str,
        retention_mode: str = "n-day",
        interval: int = 1,
    ) -> dict:
        """Retention analysis between a start event and a return event.

        Args:
            start_event: Event that starts the retention measurement
            return_event: Event that counts as a return ("_all" for any)
            start: Start date (YYYYMMDD or YYYY-MM-DD)
            end: End date (YYYYMMDD or YYYY-MM-DD)
            retention_mode: n-day, rolling, or bracket
            interval: 1 (daily), 7 (weekly), 30 (monthly)

        Returns:
            Retention data
        """
        params: list[tuple[str, str]] = [
            ("se", self._event_spec(start_event)),
            ("re", self._event_spec(return_event)),
            ("start", _fmt_date(start)),
            ("end", _fmt_date(end)),
            ("rm", retention_mode),
            ("i", str(interval)),
        ]
        return self._request("GET", "/api/2/retention", params=params)

    def events_list(self) -> dict:
        """List every event type defined in the project."""
        return self._request("GET", "/api/2/events/list")

    def user_activity(
        self,
        user: str,
        limit: int = 100,
        offset: int = 0,
        direction: str = "latest",
    ) -> dict:
        """Fetch a single user's event stream by Amplitude ID.

        Args:
            user: Amplitude ID
            limit: Max events (up to 1000)
            offset: Pagination offset
            direction: "latest" or "earliest"

        Returns:
            User details and recent events
        """
        params = {"user": user, "limit": limit, "offset": offset, "direction": direction}
        return self._request("GET", "/api/2/useractivity", params=params)

    def user_search(self, user: str) -> dict:
        """Search for a user by Amplitude ID, Device ID, User ID, or prefix.

        Args:
            user: Identifier or prefix to match

        Returns:
            Matching users
        """
        return self._request("GET", "/api/2/usersearch", params={"user": user})

    def realtime(self, interval: int | None = None) -> dict:
        """Real-time active user counts.

        Args:
            interval: Interval in seconds (e.g. 300 for 5-minute buckets)

        Returns:
            Realtime active-user series
        """
        params = {"i": -interval * 1000} if interval else None
        return self._request("GET", "/api/2/realtime", params=params)

    def annotations(self) -> dict:
        """List chart annotations for the project."""
        return self._request("GET", "/api/2/annotations")

    def taxonomy_events(self) -> dict:
        """List event types in the tracking plan (Taxonomy API)."""
        return self._request("GET", "/api/2/taxonomy/event")

    def taxonomy_event_properties(self, event_type: str) -> dict:
        """List event properties defined for an event type (Taxonomy API).

        Args:
            event_type: Event type whose properties to list
        """
        return self._request(
            "GET", "/api/2/taxonomy/event-property", params={"event_type": event_type}
        )

    def taxonomy_user_properties(self) -> dict:
        """List user properties in the tracking plan (Taxonomy API)."""
        return self._request("GET", "/api/2/taxonomy/user-property")

    def close(self):
        """Close the HTTP client."""
        if self._client:
            self._client.close()
            self._client = None

    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


def _client() -> AmplitudeClient:
    api_key = secret("AMPLITUDE_API_KEY", "")
    secret_key = secret("AMPLITUDE_SECRET_KEY", "")
    return AmplitudeClient(api_key=api_key, secret_key=secret_key)
