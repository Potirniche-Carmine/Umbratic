package supervisor

import "testing"

// A base URL that already carries the API version is the documented default,
// so joining it with a versioned endpoint must not repeat the version.
func TestProviderPathJoinsWithoutRepeatingSharedSegments(t *testing.T) {
	for _, testCase := range []struct{ base, endpoint, want string }{
		{"/v1", "/v1/models", "/v1/models"},
		{"/v1", "/v1/chat/completions", "/v1/chat/completions"},
		{"/v1/", "/v1/chat/completions", "/v1/chat/completions"},
		{"", "/v1/chat/completions", "/v1/chat/completions"},
		{"/openai/v1", "/v1/chat/completions", "/openai/v1/chat/completions"},
		{"/proxy", "/v1/models", "/proxy/v1/models"},
	} {
		if got := providerPath(testCase.base, testCase.endpoint); got != testCase.want {
			t.Errorf("providerPath(%q, %q) = %q, want %q", testCase.base, testCase.endpoint, got, testCase.want)
		}
	}
}
