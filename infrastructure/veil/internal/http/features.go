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
	// harness_bucket is a free-form hint. The field is accepted and does not
	// change the protected prompt. An unknown value is counted rather than
	// failing the request.
	"chat.harness_bucket_hint",
	// Unknown body fields on product routes are stripped and counted.
	"chat.tolerant_body",
	// Telemetry accepts any event type and drops unreadable records one at a
	// time instead of rejecting the bundle.
	"telemetry.open_vocabulary",
	// The orient classifier accepts previousResponse as carried context.
	"orient.previous_response",
	// GET /api/models lists the models this Veil routes to, with live
	// availability. Advertised on every build: a single-model deployment
	// answers with its one entry rather than a 404.
	"models.list",
	// Chat bodies may carry a `thinking` directive. Tolerant like
	// harness_bucket — the name exists so a client knows the field means
	// something here, not so an unknown value can be refused.
	"chat.thinking_toggle",
	"chat.reasoning_effort",
	// Chat bodies may carry `reasoning_visible`. Security-semantic: the
	// default is still to strip reasoning tokens, and a client must see this
	// name before asking to forward them. An older server that never
	// advertised it keeps stripping even if the field arrives.
	"chat.reasoning_visible",
}

// modelSelectionFeature is advertised only while a registry is configured. It
// is a security-semantic name: without it a client must not send `model`,
// because a server with no registry refuses the field rather than ignoring it.
const modelSelectionFeature = "chat.model_selection"

// ragFeature is advertised only while retrieval is actually configured and
// enabled. A name is a promise about behavior, and a server with no corpus
// wired up cannot keep this one — so it says nothing rather than advertising a
// capability that would silently do nothing.
const ragFeature = "rag"

// speechFeature is advertised only while a transcription runtime is
// configured. Like rag, a name is a promise: a server with no ASR endpoint
// wired up cannot keep this one, and a microphone button that fails on first
// press is worse than no microphone button.
const speechFeature = "speech.transcribe"

// webSearchFeature is advertised only while this build can actually run a
// search: a subscription key is baked in and the organization's month still has
// room. Gated harder than the others on purpose — a client that sees this name
// stops searching on its own and routes every query through here, so withdrawing
// it is how a spent month tells the client to stop asking rather than how it
// learns to fail.
const webSearchFeature = "web.search"

// Features returns the advertised capability list. The slice is built fresh so
// a caller cannot rewrite what this server claims to support.
func Features(ragEnabled, modelSelectionEnabled, speechEnabled, webSearchEnabled bool) []string {
	names := make([]string, 0, len(serverFeatures)+4)
	names = append(names, serverFeatures...)
	if ragEnabled {
		names = append(names, ragFeature)
	}
	if modelSelectionEnabled {
		names = append(names, modelSelectionFeature)
	}
	if speechEnabled {
		names = append(names, speechFeature)
	}
	if webSearchEnabled {
		names = append(names, webSearchFeature)
	}
	return names
}
