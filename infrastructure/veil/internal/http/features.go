package httpapi

// serverFeatures is how a client discovers what this Veil can do. Names, never
// versions: a version number tells a client which build is running, which it
// then has to translate into behavior with a comparison table that goes stale.
// A feature name is the behavior itself, so a client asks the only question it
// actually has — "can I send this?" — and gets a direct answer.
//
// Adding a name here is a promise. Remove one only in a coordinated release,
// the same bar as a transport or auth change.
var serverFeatures = []string{
	// Tool definitions and skill entries are bounds-checked and passed through
	// rather than schema-arbitrated. A harness may send constructs this build has
	// never seen and let the provider judge them.
	"tools.bounds_only",
	// harness_bucket is a free-form hint. An unknown value defaults to no
	// playbook instead of failing the request.
	"chat.harness_bucket_hint",
	// Unknown body fields on product routes are stripped and counted.
	"chat.tolerant_body",
	// Telemetry accepts any event type and drops unreadable records one at a
	// time instead of rejecting the bundle.
	"telemetry.open_vocabulary",
	// The orient classifier accepts previousResponse as carried context.
	"orient.previous_response",
}

// Features returns the advertised capability list. The slice is copied so a
// caller cannot rewrite what this server claims to support.
func Features() []string {
	names := make([]string, len(serverFeatures))
	copy(names, serverFeatures)
	return names
}
