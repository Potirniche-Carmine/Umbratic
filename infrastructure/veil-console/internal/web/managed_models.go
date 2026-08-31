package web

import (
	"encoding/json"
	"errors"
	"fmt"
	"html/template"
	"net"
	"net/http"
	"strconv"
	"strings"
	"time"

	"umbratic-veil-console/internal/config"
	"umbratic-veil-console/internal/state"
	"umbratic-veil-console/internal/supervisor"
)

// modelsView is what the Models page renders.
type modelsView struct {
	// Configured is false when Console was started without --vllm-binary. The
	// page then explains why nothing can be started rather than offering
	// buttons that fail.
	Configured bool
	Rows       []modelRow
	// PendingApply is true when the stored registry differs from the one the
	// running Veil was started with. Model start and stop are live; changing
	// which models exist is configuration, and configuration needs a restart.
	PendingApply bool
	// Running and Registered are the dashboard's summary line. The Models page
	// itself does not repeat them: every card already says what it is doing.
	Running    int
	Registered int
	// Form is the add form's current values, so a rejected submission comes
	// back with what the administrator typed.
	Form      modelForm
	FormError string
	// Kind is the tab being shown. Chat and dictation are different enough that
	// one list of both would need a column explaining which is which.
	Kind config.ServingKind
	// DictationTaken is true when a dictation runtime is already registered.
	// Veil takes one speech endpoint, so the add form says so rather than
	// letting the submission fail.
	DictationTaken bool
	// Catalog is the reviewed list the add form offers, and CatalogJSON is the
	// same data for the script that keeps the served id, the context and the
	// command in step with the menu. One source, rendered twice, rather than a
	// list in Go and a copy of it in JavaScript.
	Catalog     []config.ServingModel
	CatalogJSON template.JS
	// SuggestedPort is what a new model is offered, and what the browser
	// rebuilds each catalog command around.
	SuggestedPort int
	CustomKey     string
}

type modelRow struct {
	config.ManagedModel
	State     supervisor.ModelState
	StateText string
	PID       int
	// Logs is the tail of the runtime's output, carried only for a model that
	// failed.
	Logs      string
	IsDefault bool
	Running   bool
	// Stale is true when the saved command is not the one the live process was
	// started with — the model is serving yesterday's flags.
	Stale bool
	// Notice is the card's one reserved line. It is always rendered, empty or
	// not, so a card never changes height when its state does.
	Notice string
	// Summary is the command in one readable line: what is being served, at
	// what context, on which port. The card used to answer that with eight
	// lines of monospace argv, which is the truth but not the answer.
	Summary string
}

// modelForm is the add form. Editing happens on the card itself, so this is
// only ever the three things a new model needs.
type modelForm struct {
	ID          string
	DisplayName string
	Command     string
	Role        string
	// CatalogKey names the catalog row this model is being created from, or
	// CustomCatalogKey when the administrator is typing a command themselves.
	CatalogKey string
	// Variant is the precision chosen for that row.
	Variant string
	// Context is the context length chosen for it, in tokens.
	Context int
}

// CustomCatalogKey is the "not on the list" option. It is what the add form was
// before the catalog existed: three text fields and a command box. Nothing is
// taken away by having a list — a repository this build has never reviewed is
// still registrable, just deliberately rather than by default.
const CustomCatalogKey = "custom"

// Selected reports whether this catalog row is the chosen one, for the menu.
func (f modelForm) Selected(key string) bool {
	if strings.TrimSpace(f.CatalogKey) == "" {
		return key == CustomCatalogKey
	}
	return f.CatalogKey == key
}

// IsCustom drives whether the form opens on the command box.
func (f modelForm) IsCustom() bool {
	return f.Selected(CustomCatalogKey)
}

// SpeechSelected drives the add form's role control, so a rejected submission
// comes back with the role the administrator picked rather than the default.
func (f modelForm) SpeechSelected() bool { return f.Role == config.RoleSpeech }

func (s *Server) modelsPage(w http.ResponseWriter, r *http.Request) {
	s.render(w, "models.html", s.modelsData(r, "", "", nil))
}

// IsChat and IsDictation drive the tab bar.
func (v modelsView) IsChat() bool      { return v.Kind != config.KindDictation }
func (v modelsView) IsDictation() bool { return v.Kind == config.KindDictation }

func (s *Server) modelsData(r *http.Request, errorMessage, noticeMessage string, form *modelForm) pageData {
	models, err := s.store.ManagedModels(r.Context())
	if err != nil && errorMessage == "" {
		errorMessage = "The model list could not be loaded."
	}
	kind := requestKind(r)
	defaultModel := ""
	if cfg, ok, cfgErr := s.store.Configuration(r.Context(), "current"); cfgErr == nil && ok {
		defaultModel = cfg.Model
	}

	port := state.NextFreeManagedPort(models, s.startup.Port, s.veilPort())
	catalog := config.CatalogFor(kind)
	catalogJSON, _ := json.Marshal(catalog)
	dictationTaken := false
	for _, model := range models {
		if model.IsSpeech() {
			dictationTaken = true
		}
	}
	first := catalog[0]
	view := modelsView{
		Configured:     s.models.Configured(),
		Registered:     len(models),
		Kind:           kind,
		DictationTaken: dictationTaken,
		Catalog:        catalog,
		CatalogJSON:    template.JS(catalogJSON),
		SuggestedPort:  port,
		CustomKey:      CustomCatalogKey,
		Form: modelForm{
			CatalogKey: first.Key,
			Variant:    first.Variants[0].Key,
			Context:    first.DefaultContext,
			Command:    config.CatalogCommand(first, first.Variants[0], port, first.DefaultContext),
		},
	}
	if form != nil {
		view.Form = *form
	}
	for _, model := range models {
		if (config.KindDictation == kind) != model.IsSpeech() {
			continue
		}
		status := s.models.Status(model.ID)
		running := status.State == supervisor.ModelHealthy || status.State == supervisor.ModelStarting
		stale := running && s.models.RunningCommand(model.ID) != strings.TrimSpace(model.Command)
		row := modelRow{
			ManagedModel: model,
			State:        status.State,
			StateText:    modelStateText(status),
			PID:          status.PID,
			IsDefault:    model.ID == defaultModel,
			Running:      running,
			Stale:        stale,
			Notice:       modelNotice(model, running, stale),
		}
		row.Summary = modelSummary(model)
		// Output is shown when it is the answer to a question the card raises.
		// A model that is serving has nothing to explain; one that failed has
		// exactly one thing, and it used to be behind a link.
		if status.State == supervisor.ModelFailed {
			row.Logs = s.models.Logs(model.ID)
		}
		view.Rows = append(view.Rows, row)
	}

	// Only meaningful against a running Veil: with none there is nothing for a
	// change to be pending against, and the next start picks the stored set up.
	stored, _ := config.ModelsEnvJSON(models)
	storedSpeech := strings.Join(config.SpeechEnvironment(models), "\n")
	view.PendingApply = s.supervisor.Status().Running &&
		(stored != s.supervisor.ModelsEnvironment() || storedSpeech != s.supervisor.SpeechEnvironment())

	session := r.Context().Value(sessionKey).(requestSession)
	processStatus := s.supervisor.Status()
	return pageData{
		Title: "Models", CSRF: csrfCookie(r), Username: session.Data.Username,
		Status: processStatus.String(), Running: processStatus.Running, Healthy: processStatus.Healthy,
		Error: errorMessage, Notice: noticeMessage, Models: view,
	}
}

// modelNotice is the card's reserved line. It answers one question — is what is
// running what is saved — and says nothing when the answer is yes.
func modelNotice(model config.ManagedModel, running, stale bool) string {
	if _, err := model.Parse(); err != nil {
		return "This command will not start: " + err.Error()
	}
	if stale {
		return "Saved. Restart to run this command."
	}
	return ""
}

// modelSummary reads the command back as a sentence. Everything in it is
// already in the argv below; this is the version someone can take in at a
// glance, with the precision named when the repository is one the catalog
// knows.
func modelSummary(model config.ManagedModel) string {
	facts, err := model.Parse()
	if err != nil {
		return ""
	}
	parts := []string{facts.ModelPath}
	if entry, ok := config.CatalogByRepo(facts.ModelPath); ok {
		for _, variant := range entry.Variants {
			if strings.EqualFold(variant.Repo, facts.ModelPath) {
				parts = append(parts, variant.Label)
				break
			}
		}
	}
	if facts.MaxModelLen > 0 {
		parts = append(parts, fmt.Sprintf("%dK context", facts.MaxModelLen/1024))
	}
	parts = append(parts, fmt.Sprintf("port %d", facts.Port))
	return strings.Join(parts, " · ")
}

func modelStateText(status supervisor.ModelStatus) string {
	if status.Message != "" {
		return status.Message
	}
	// Every state reads as a capitalized word in the UI.
	switch status.State {
	case supervisor.ModelHealthy:
		return "Serving"
	case supervisor.ModelStarting:
		return "Starting"
	case supervisor.ModelFailed:
		return "Failed"
	default:
		return "Stopped"
	}
}

func (s *Server) veilPort() int {
	_, port, err := net.SplitHostPort(s.startup.VeilAddress)
	if err != nil {
		return 0
	}
	parsed, err := strconv.Atoi(port)
	if err != nil {
		return 0
	}
	return parsed
}

// catalogPort is the port a catalog command is built around. It arrives from
// the form because the page is what knows which ports are already taken, and it
// is bounded here and collision-checked by ValidateManagedModels afterwards —
// exactly the path a hand-typed --port takes.
func catalogPort(r *http.Request) int {
	port, err := strconv.Atoi(strings.TrimSpace(r.FormValue("port")))
	if err != nil || port < config.MinManagedPort || port > config.MaxManagedPort {
		return config.SuggestedPortStart
	}
	return port
}

func parseModelForm(r *http.Request, id string) (config.ManagedModel, modelForm) {
	form := modelForm{
		ID:          strings.TrimSpace(r.FormValue("id")),
		DisplayName: strings.TrimSpace(r.FormValue("display_name")),
		Command:     strings.TrimSpace(r.FormValue("command")),
		Role:        config.NormalizeRole(r.FormValue("role")),
		CatalogKey:  strings.TrimSpace(r.FormValue("catalog_key")),
		Variant:     strings.TrimSpace(r.FormValue("variant")),
	}
	// A catalog row decides the identity and the command. The browser fills the
	// same three values into the form as the menu changes, but they arrive from
	// a client and are rebuilt here rather than trusted: what gets executed is
	// always assembled from the reviewed row on this side.
	if entry, ok := config.CatalogEntry(form.CatalogKey); ok {
		variant := entry.Variant(form.Variant)
		context, _ := strconv.Atoi(strings.TrimSpace(r.FormValue("context")))
		context = entry.ClampContext(context)
		form.Variant = variant.Key
		form.Context = context
		form.ID = entry.ServedID
		form.DisplayName = entry.DisplayName
		form.Command = config.CatalogCommand(entry, variant, catalogPort(r), context)
		// The tab the form was submitted from decides the role. A dictation
		// model registered as chat would be published in the model picker and
		// fail every message sent to it.
		form.Role = entry.Kind.Role()
	}
	if id != "" {
		form.ID = id
	}
	model := config.ManagedModel{
		ID: form.ID, DisplayName: form.DisplayName, Command: form.Command, Role: form.Role,
	}
	// Store it laid out one flag per line however it arrived, so a pasted
	// one-liner is readable the next time the card is opened.
	if facts, err := model.Parse(); err == nil {
		model.Command = config.FormatCommand(facts.Args)
	}
	return model, form
}

func (s *Server) modelsCreate(w http.ResponseWriter, r *http.Request) {
	model, form := parseModelForm(r, "")
	if err := model.Validate(); err != nil {
		s.renderModelFormError(w, r, form, err)
		return
	}
	existing, err := s.store.ManagedModels(r.Context())
	if err != nil {
		s.renderModelFormError(w, r, form, errors.New("the model list could not be loaded"))
		return
	}
	if err := config.ValidateManagedModels(append(existing, model), s.startup.Port, s.veilPort()); err != nil {
		s.renderModelFormError(w, r, form, err)
		return
	}
	if err := s.store.InsertManagedModel(r.Context(), model); err != nil {
		s.renderModelFormError(w, r, form, errors.New("the model could not be saved"))
		return
	}
	s.handOffModels(r)
	s.modelActionResult(w, r, nil, "model.create")
}

// modelsDefault points Veil's default model at this card.
//
// It lives here rather than on Settings because the question is which of these
// models answers a request that names none, and that is a fact about the fleet.
// Settings asked it as a text field beside a runtime URL, which made a page
// about server limits also the place models were chosen.
//
// The provider URL is moved with it. The registry gives Veil a URL per model,
// but the single-model variables are still what a request falls back to, and
// leaving them pointed at the previous default was a way to serve the wrong
// weights without anything on screen being wrong.
func (s *Server) modelsDefault(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("model_id")
	models, err := s.store.ManagedModels(r.Context())
	if err != nil {
		s.modelActionResult(w, r, errors.New("the model list could not be loaded"), "model.default")
		return
	}
	var chosen *config.ManagedModel
	for index, candidate := range models {
		if candidate.ID == id {
			chosen = &models[index]
		}
	}
	if chosen == nil {
		s.modelActionResult(w, r, errors.New("that model is not registered"), "model.default")
		return
	}
	if chosen.IsSpeech() {
		s.modelActionResult(w, r, errors.New("a dictation model cannot answer chat requests"), "model.default")
		return
	}
	facts, err := chosen.Parse()
	if err != nil {
		s.modelActionResult(w, r, err, "model.default")
		return
	}
	cfg, ok, err := s.store.Configuration(r.Context(), "current")
	if err != nil {
		s.modelActionResult(w, r, errors.New("the active configuration could not be read"), "model.default")
		return
	}
	if !ok {
		// The first default on a fresh deployment. Settings can no longer name a
		// model, so refusing here left no way to ever configure Veil: the
		// baseline is the same defaults Settings starts from, and choosing the
		// default is what creates the first configuration.
		cfg = config.DefaultVeil()
	}
	cfg.Model = chosen.ID
	cfg.ProviderBaseURL = fmt.Sprintf("http://127.0.0.1:%d/v1", facts.Port)
	// The context follows the model. It is read out of this model's own
	// --max-model-len rather than set on Settings, because a KV cache is sized
	// by the weights it belongs to and one number applied to every model at
	// once was either wasteful or wrong.
	cfg.ContextLength = facts.MaxModelLen
	cfg = config.WithModelDefaults(cfg, facts.ModelPath)
	if err := cfg.Validate(); err != nil {
		s.modelActionResult(w, r, err, "model.default")
		return
	}
	if err := s.store.SavePending(r.Context(), cfg, time.Now()); err != nil {
		s.modelActionResult(w, r, errors.New("the default could not be saved"), "model.default")
		return
	}
	if err := s.store.PromotePending(r.Context(), time.Now()); err != nil {
		_ = s.store.DiscardPending(r.Context())
		s.modelActionResult(w, r, errors.New("the default could not be saved"), "model.default")
		return
	}
	// A running Veil is holding the previous default in its environment.
	if restartErr := s.restartVeilForChange(r.Context()); restartErr != nil {
		s.modelActionResult(w, r, errors.New("the default was saved, but Veil could not be restarted. Restart it from Overview."), "model.default")
		return
	}
	s.modelActionResult(w, r, nil, "model.default")
}

// modelsUpdate saves a card's edits. The command is the interesting one: it is
// stored as typed and only becomes argv at start, so a model that is running
// keeps running exactly as it was launched until it is restarted.
func (s *Server) modelsUpdate(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("model_id")
	model, _ := parseModelForm(r, id)
	if err := model.Validate(); err != nil {
		s.modelActionResult(w, r, err, "model.update")
		return
	}
	existing, err := s.store.ManagedModels(r.Context())
	if err != nil {
		s.modelActionResult(w, r, errors.New("the model list could not be loaded"), "model.update")
		return
	}
	fleet := make([]config.ManagedModel, 0, len(existing))
	for _, candidate := range existing {
		if candidate.ID == id {
			continue
		}
		fleet = append(fleet, candidate)
	}
	if err := config.ValidateManagedModels(append(fleet, model), s.startup.Port, s.veilPort()); err != nil {
		s.modelActionResult(w, r, err, "model.update")
		return
	}
	if err := s.store.UpdateManagedModel(r.Context(), model); err != nil {
		s.modelActionResult(w, r, errors.New("that model is not registered"), "model.update")
		return
	}
	s.handOffModels(r)
	s.modelActionResult(w, r, nil, "model.update")
}

func (s *Server) modelsDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("model_id")
	// Removing a running model would orphan its process and its GPU memory.
	if state := s.models.Status(id).State; state == supervisor.ModelHealthy || state == supervisor.ModelStarting {
		s.modelActionResult(w, r, errors.New("stop this model before removing it"), "model.delete")
		return
	}
	if err := s.store.DeleteManagedModel(r.Context(), id); err != nil {
		s.modelActionResult(w, r, errors.New("the model could not be removed"), "model.delete")
		return
	}
	s.handOffModels(r)
	s.modelActionResult(w, r, nil, "model.delete")
}

func (s *Server) modelsStart(w http.ResponseWriter, r *http.Request) {
	model, ok, err := s.store.ManagedModel(r.Context(), r.PathValue("model_id"))
	if err != nil || !ok {
		s.modelActionResult(w, r, errors.New("that model is not registered"), "model.start")
		return
	}
	s.modelActionResult(w, r, s.models.Start(model), "model.start")
}

func (s *Server) modelsStop(w http.ResponseWriter, r *http.Request) {
	s.modelActionResult(w, r, s.models.Stop(r.PathValue("model_id")), "model.stop")
}

// modelsRestart is how an edited command takes effect: stop, then start from
// the saved command.
func (s *Server) modelsRestart(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("model_id")
	model, ok, err := s.store.ManagedModel(r.Context(), id)
	if err != nil || !ok {
		s.modelActionResult(w, r, errors.New("that model is not registered"), "model.restart")
		return
	}
	if err := s.models.Stop(id); err != nil {
		s.modelActionResult(w, r, err, "model.restart")
		return
	}
	s.modelActionResult(w, r, s.models.Start(model), "model.restart")
}

// handOffModels records the stored registry for the next Veil start. It does
// not restart Veil: which models exist is configuration, and an administrator
// applies it deliberately from the dashboard.
func (s *Server) handOffModels(r *http.Request) {
	models, err := s.store.ManagedModels(r.Context())
	if err != nil {
		return
	}
	s.supervisor.SetModels(models)
}

func (s *Server) renderModelFormError(w http.ResponseWriter, r *http.Request, form modelForm, err error) {
	data := s.modelsData(r, "", "", &form)
	data.Models.FormError = err.Error()
	s.renderStatus(w, "models.html", http.StatusBadRequest, data)
}

// requestKind is the tab this request belongs to. A GET carries it in the query
// and a POST carries it in the form, so an action taken on the dictation tab
// comes back to the dictation tab rather than dropping the reader onto chat.
func requestKind(r *http.Request) config.ServingKind {
	if value := strings.TrimSpace(r.URL.Query().Get("kind")); value != "" {
		return config.NormalizeKind(value)
	}
	return config.NormalizeKind(r.FormValue("kind"))
}

// modelsPath is the page for one tab.
func modelsPath(kind config.ServingKind) string {
	if kind == config.KindDictation {
		return "/models?kind=dictation"
	}
	return "/models"
}

func (s *Server) modelActionResult(w http.ResponseWriter, r *http.Request, err error, event string) {
	if err != nil {
		s.store.Audit(r.Context(), event, "failure", time.Now())
		s.renderStatus(w, "models.html", statusFor(err), s.modelsData(r, err.Error(), "", nil))
		return
	}
	s.store.Audit(r.Context(), event, "success", time.Now())
	http.Redirect(w, r, modelsPath(requestKind(r)), http.StatusSeeOther)
}
