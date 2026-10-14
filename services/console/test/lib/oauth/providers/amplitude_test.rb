require "test_helper"

module Oauth
  module Providers
    class AmplitudeTest < ActiveSupport::TestCase
      def result(scope: "all:read offline_access")
        Broker::AuthorizationCodeClient::Result.new(
          access_token: "synthetic", refresh_token: "synthetic-refresh", expires_in: 3600,
          scope: scope, id_token: nil, response: {}
        )
      end

      test "resolves the authenticated Amplitude principal" do
        http = expect_http_call(status: 200, body: {
          data: { principal: { org_id: "123", login_id: "analyst@example.com", org_name: "Splits" } }
        }.to_json) do |request|
          assert_equal :get, request[:method]
          assert_equal Amplitude::CONTEXT_ENDPOINT, request[:url]
          assert_equal "Bearer synthetic", request[:headers]["Authorization"]
        end

        identity = Amplitude.new.identity_from(result, client_id: "unused", http_client: HttpClient.new(http: http))
        assert_equal "123:analyst@example.com", identity[:subject]
        assert_equal "analyst@example.com", identity[:email]
        assert_equal "Splits", identity[:name]
        http.verify
      end

      test "requires only read scope and limits credential to MCP host" do
        strategy = Amplitude.new
        assert_equal [ "all:read" ], strategy.required_scopes
        assert_equal [ "all:read" ], strategy.preset[:allowed_scopes]
        assert_equal [ { host: "mcp.amplitude.com", http_methods: [ "POST" ], paths: [ "/mcp" ] } ],
                     strategy.credential_request_rules
        strategy.validate_result!(result)
        assert_raises(Broker::ExchangeError) { strategy.validate_result!(result(scope: "all:write")) }
      end

      test "rejects an identity response without a principal" do
        http = expect_http_call(status: 200, body: { data: {} }.to_json)
        assert_raises(Broker::ExchangeError) do
          Amplitude.new.identity_from(result, client_id: "unused", http_client: HttpClient.new(http: http))
        end
        http.verify
      end
    end
  end
end
