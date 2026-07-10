require "test_helper"

module GoogleDocs
  class JobsTest < ActiveJob::TestCase
    def google_app(slug: "google")
      OauthApp.create!(
        provider: "google",
        slug: slug,
        client_id: "google-client-#{SecureRandom.hex(4)}",
        client_secret: "secret",
        allowed_scopes: [
          GoogleDocs::SyncCredential::DRIVE_METADATA_SCOPE,
          GoogleDocs::SyncCredential::DOCS_READONLY_SCOPE
        ],
        credential_namespace: "acme",
        created_by: users(:acme_admin)
      )
    end

    def google_credential(
      app:,
      scopes: [
        GoogleDocs::SyncCredential::DRIVE_METADATA_SCOPE,
        GoogleDocs::SyncCredential::DOCS_READONLY_SCOPE
      ],
      access_token: "ya29-live"
    )
      BrokerCredential.create!(
        oauth_app: app,
        namespace: "acme",
        foreign_id: "google-docs-#{SecureRandom.hex(6)}",
        token_endpoint: Oauth::Providers::Google::TOKEN_ENDPOINT,
        access_token: access_token,
        refresh_token: "refresh",
        last_refresh: Time.current,
        expires_at: 1.hour.from_now,
        scopes: scopes,
        provider_subject: "google-subject-#{SecureRandom.hex(4)}"
      )
    end

    test "PollSyncJob enqueues credentials for the configured Google OAuth app with required scopes" do
      app = google_app
      good = google_credential(app: app)
      missing_scope = google_credential(app: app, scopes: [ GoogleDocs::SyncCredential::DOCS_READONLY_SCOPE ])
      no_token = google_credential(app: app, access_token: nil)
      other_app = google_app(slug: "other-google")
      other = google_credential(app: other_app)

      GoogleDocs::PollSyncJob.perform_now("google")

      enqueued_ids = enqueued_jobs
        .select { |job| job[:job] == GoogleDocs::SyncCredentialJob }
        .map { |job| job[:args].first }
      assert_includes enqueued_ids, good.id
      refute_includes enqueued_ids, missing_scope.id
      refute_includes enqueued_ids, no_token.id
      refute_includes enqueued_ids, other.id
    end

    test "SyncCredentialJob is a no-op for missing credentials" do
      assert_nothing_raised { GoogleDocs::SyncCredentialJob.perform_now(-1) }
    end

    test "SyncCredentialJob retries indexing errors before surfacing them" do
      app = google_app
      credential = google_credential(app: app)
      calls = 0
      original = GoogleDocs::SyncCredential.method(:new)
      GoogleDocs::SyncCredential.define_singleton_method(:new) do |*args, **kwargs|
        original.call(*args, **kwargs).tap do |sync|
          sync.define_singleton_method(:call) do
            calls += 1
            raise GoogleDocs::SyncCredential::GoogleApiError, "temporary indexing failure"
          end
        end
      end

      assert_enqueued_jobs 1 do
        GoogleDocs::SyncCredentialJob.perform_now(credential.id)
      end
      assert_equal 1, calls
    ensure
      GoogleDocs::SyncCredential.define_singleton_method(:new, original)
    end

    test "SyncCredentialJob raises indexing errors after retries are exhausted" do
      app = google_app
      credential = google_credential(app: app)
      calls = 0
      original = GoogleDocs::SyncCredential.method(:new)
      GoogleDocs::SyncCredential.define_singleton_method(:new) do |*args, **kwargs|
        original.call(*args, **kwargs).tap do |sync|
          sync.define_singleton_method(:call) do
            calls += 1
            raise GoogleDocs::SyncCredential::GoogleApiError, "permanent indexing failure"
          end
        end
      end

      assert_raises(GoogleDocs::SyncCredential::GoogleApiError) do
        job = GoogleDocs::SyncCredentialJob.new(credential.id)
        5.times { job.perform_now }
      end
      assert_equal 5, calls
    ensure
      GoogleDocs::SyncCredential.define_singleton_method(:new, original)
    end
  end
end
