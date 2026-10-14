module Oauth
  module Providers
    # Read-only Amplitude MCP connection for shared analytics access.
    class Amplitude
      include HttpIdentity

      KEY = "amplitude"
      ORIGIN = "https://mcp.amplitude.com"
      CONTEXT_ENDPOINT = "https://developer-api.amplitude.com/v1/context"
      READ_SCOPE = "all:read"

      def key = KEY
      def display_name = "Amplitude"
      def authorization_endpoint = "#{ORIGIN}/authorize"
      def token_endpoint = "#{ORIGIN}/token"
      def registration_endpoint = "#{ORIGIN}/register"
      def identity_scopes = %w[offline_access]
      def required_scopes = [ READ_SCOPE ]
      def api_hosts = %w[mcp.amplitude.com]
      def credential_request_rules
        [ { host: "mcp.amplitude.com", http_methods: [ "POST" ], paths: [ "/mcp" ] } ]
      end
      def preset
        { slug: KEY, description: "Read Amplitude charts and dashboards.",
          allowed_scopes: [ READ_SCOPE ], shared: true }
      end
      def authorization_scope_param = "scope"
      def scope_separator = " "
      def extra_authorization_params = { "resource" => ORIGIN }
      def refreshable? = true
      def parse_granted_scopes(scope) = scope.to_s.split
      def refresh_scopes(scopes) = Array(scopes)

      def validate_result!(result)
        return if parse_granted_scopes(result.scope).include?(READ_SCOPE)
        raise Broker::ExchangeError.new("Amplitude read scope was not granted", stage: "oauth", code: "missing_scope")
      end

      def identity_from(result, client_id:, http_client: HttpClient.new)
        response = identity_response(provider: display_name) do
          http_client.get(CONTEXT_ENDPOINT,
            headers: { "Authorization" => "Bearer #{result.access_token}", "User-Agent" => "centaur-console" })
        end
        principal = identity_json(response, provider: display_name).dig("data", "principal")
        unless principal.is_a?(Hash)
          raise Broker::ExchangeError.new("Amplitude account identity unavailable", stage: "oauth", code: "missing_identity")
        end
        org_id = require_identity(principal["org_id"], provider: display_name).to_s
        login_id = require_identity(principal["login_id"], provider: display_name).to_s
        { subject: "#{org_id}:#{login_id}", email: login_id.include?("@") ? login_id : nil,
          name: principal["org_name"].presence || login_id }
      end
    end
  end
end
