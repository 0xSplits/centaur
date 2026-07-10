require "test_helper"

module SlackDm
  class JobsTest < ActiveJob::TestCase
    def slack_app(slug: "slack-dms")
      OauthApp.create!(
        provider: "slack",
        slug: slug,
        client_id: "slack-client-#{SecureRandom.hex(4)}",
        client_secret: "secret",
        allowed_scopes: SlackDm::SyncCredential::REQUIRED_SCOPES,
        credential_namespace: "acme",
        created_by: users(:acme_admin)
      )
    end

    def slack_credential(
      app:,
      scopes: SlackDm::SyncCredential::REQUIRED_SCOPES,
      access_token: "xoxp-live",
      provider_subject: "U#{SecureRandom.hex(4).upcase}"
    )
      BrokerCredential.create!(
        oauth_app: app,
        namespace: "acme",
        foreign_id: "slack-dms-#{SecureRandom.hex(6)}",
        token_endpoint: "https://slack.com/api/oauth.v2.access",
        access_token: access_token,
        refresh_token: "refresh",
        last_refresh: Time.current,
        expires_at: 1.hour.from_now,
        scopes: scopes,
        provider_subject: provider_subject
      )
    end

    test "PollSyncJob enqueues credentials for the configured Slack OAuth app with required scopes" do
      app = slack_app
      good = slack_credential(app: app)
      missing_scope = slack_credential(app: app, scopes: %w[im:read im:history])
      no_token = slack_credential(app: app, access_token: nil)
      other_app = slack_app(slug: "other-slack")
      other = slack_credential(app: other_app)

      SlackDm::PollSyncJob.perform_now("slack-dms")

      enqueued_ids = enqueued_jobs
        .select { |job| job[:job] == SlackDm::SyncCredentialJob }
        .map { |job| job[:args].first }
      assert_includes enqueued_ids, good.id
      refute_includes enqueued_ids, missing_scope.id
      refute_includes enqueued_ids, no_token.id
      refute_includes enqueued_ids, other.id
    end

    test "SyncCredentialJob is a no-op for missing credentials" do
      assert_nothing_raised { SlackDm::SyncCredentialJob.perform_now(-1) }
    end

    test "SyncCredentialJob retries indexing errors before surfacing them" do
      app = slack_app
      credential = slack_credential(app: app)
      calls = 0
      original = SlackDm::SyncCredential.method(:new)
      SlackDm::SyncCredential.define_singleton_method(:new) do |*args, **kwargs|
        original.call(*args, **kwargs).tap do |sync|
          sync.define_singleton_method(:call) do
            calls += 1
            raise SlackDm::SyncCredential::SlackApiError, "temporary indexing failure"
          end
        end
      end

      assert_enqueued_jobs 1 do
        SlackDm::SyncCredentialJob.perform_now(credential.id)
      end
      assert_equal 1, calls
    ensure
      SlackDm::SyncCredential.define_singleton_method(:new, original)
    end

    test "SyncCredentialJob raises indexing errors after retries are exhausted" do
      app = slack_app
      credential = slack_credential(app: app)
      calls = 0
      original = SlackDm::SyncCredential.method(:new)
      SlackDm::SyncCredential.define_singleton_method(:new) do |*args, **kwargs|
        original.call(*args, **kwargs).tap do |sync|
          sync.define_singleton_method(:call) do
            calls += 1
            raise SlackDm::SyncCredential::SlackApiError, "permanent indexing failure"
          end
        end
      end

      assert_raises(SlackDm::SyncCredential::SlackApiError) do
        job = SlackDm::SyncCredentialJob.new(credential.id)
        5.times { job.perform_now }
      end
      assert_equal 5, calls
    ensure
      SlackDm::SyncCredential.define_singleton_method(:new, original)
    end
  end
end
