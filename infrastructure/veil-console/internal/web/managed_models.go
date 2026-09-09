package web

import (
	"errors"
	"fmt"
	"net"
	"net/http"
	"path/filepath"
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
	Folders        []string
	FolderHints    map[string]string
	ModelsDir      string
	SuggestedPort  int
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
}

// modelForm is the add form. Editing happens on the card itself, so this is
// only ever the three things a new model needs.
type modelForm struct {
	ReasoningEfforts string
	SamplingJSON     string
	ID               string
	DisplayName      string
	Command          string
	Role             string
	Folder           string
}

func (s *Server) modelsPage(w http.ResponseWriter, r *http.Request) {
	s.render(w, "models.html", s.modelsData(r, "", "", nil))
}

// IsChat and IsDictation drive the tab bar.
func (v modelsView) IsChat() bool      { return v.Kind == config.KindChat }
func (v modelsView) IsEmbedding() bool { return v.Kind == config.KindEmbedding }
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
	folders, folderErr := localModelFolders(s.modelsDirectory())
	if folderErr != nil && errorMessage == "" {
		errorMessage = folderErr.Error()
	}
	view := modelsView{
		Configured: s.models.Configured(), Registered: len(models), Kind: kind,
		Folders: folders, ModelsDir: s.modelsDirectory(), SuggestedPort: port,
		FolderHints: make(map[string]string, len(folders)),
	}
	for _, folder := range folders {
		metadata := supervisor.InspectModel(filepath.Join(s.modelsDirectory(), folder))
		view.FolderHints[folder] = map[string]string{config.RoleSpeech: "Dictation", config.RoleEmbedding: "Embedding"}[metadata.SuggestedRole]
	}
	for _, model := range models {
		if model.IsSpeech() {
			view.DictationTaken = true
		}
	}
	if form != nil {
		view.Form = *form
	}
	for _, model := range models {
		if kind.Role() != config.NormalizeRole(model.Role) {
			continue
		}
		status := s.models.Status(model.ID)
		running := status.PID > 0
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
		// Output is shown when it is the answer to a question the card raises.
		// A model that is serving has nothing to explain; one that failed has
		// exactly one thing, and it used to be behind a link.
		if status.State == supervisor.ModelFailed {
			row.StateText = "Failed to start"
			row.Notice = status.Message
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

// suggestedModelPort is the port a catalog command is built around. It arrives from
// the form because the page is what knows which ports are already taken, and it
// is bounded here and collision-checked by ValidateManagedModels afterwards —
// exactly the path a hand-typed --port takes.
func suggestedModelPort(r *http.Request) int {
	port, err := strconv.Atoi(strings.TrimSpace(r.FormValue("port")))
	if err != nil || port < config.MinManagedPort || port > config.MaxManagedPort {
		return config.SuggestedPortStart
	}
	return port
}

func parseModelForm(r *http.Request, id string) (config.ManagedModel, modelForm) {
	_ = r.ParseForm()
	efforts := append([]string(nil), r.Form["reasoning_effort"]...)
	for _, extra := range strings.Split(r.FormValue("extra_efforts"), ",") {
		if value := strings.ToLower(strings.TrimSpace(extra)); value != "" {
			efforts = append(efforts, value)
		}
	}
	form := modelForm{
		ID:               strings.TrimSpace(r.FormValue("id")),
		DisplayName:      strings.TrimSpace(r.FormValue("display_name")),
		Command:          strings.TrimSpace(r.FormValue("command")),
		ReasoningEfforts: strings.Join(efforts, ","),
		SamplingJSON:     strings.TrimSpace(r.FormValue("sampling_json")),
		Role:             config.NormalizeRole(r.FormValue("role")),
		Folder:           strings.TrimSpace(r.FormValue("folder")),
	}
	if id == "" {
		form.Role = requestKind(r).Role()
	}
	if id != "" {
		form.ID = id
	}
	model := config.ManagedModel{
		ID: form.ID, DisplayName: form.DisplayName, Command: form.Command, Role: form.Role,
		ReasoningEfforts: form.ReasoningEfforts,
		SamplingJSON:     form.SamplingJSON,
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
	folder, err := resolveLocalModel(s.modelsDirectory(), form.Folder)
	if err != nil {
		s.renderModelFormError(w, r, form, err)
		return
	}
	if model.DisplayName == "" {
		model.DisplayName = filepath.Base(folder)
	}
	if model.ID == "" {
		model.ID = localModelID(filepath.Base(folder))
	}
	if model.Command == "" {
		model.Command = config.DefaultCommand(folder, model.ID, suggestedModelPort(r))
		if model.Role == config.RoleEmbedding {
			model.Command += "\n--runner pooling"
		}
		model, err = s.models.PrepareCommand(model)
		if err != nil {
			s.renderModelFormError(w, r, form, err)
			return
		}
	}
	facts, parseErr := model.Parse()
	if parseErr != nil || facts.ModelPath != folder {
		s.renderModelFormError(w, r, form, errors.New("the command must use the selected local model folder"))
		return
	}
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
	s.modelActionResult(w, r, s.handOffModels(r), "model.create")
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
	if config.NormalizeRole(chosen.Role) != config.RoleChat {
		s.modelActionResult(w, r, errors.New("only a chat model can be the chat default"), "model.default")
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
	_, err := s.saveLaunchCommand(r)
	s.modelActionResult(w, r, err, "model.update")
}

func (s *Server) modelsDelete(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("model_id")
	// Removing a running model would orphan its process and its GPU memory.
	if status := s.models.Status(id); status.PID > 0 {
		s.modelActionResult(w, r, errors.New("stop this model before removing it"), "model.delete")
		return
	}
	if err := s.store.DeleteManagedModel(r.Context(), id); err != nil {
		s.modelActionResult(w, r, errors.New("the model could not be removed"), "model.delete")
		return
	}
	s.modelActionResult(w, r, s.handOffModels(r), "model.delete")
}

func (s *Server) modelsStart(w http.ResponseWriter, r *http.Request) {
	model, err := s.saveLaunchCommand(r)
	if err != nil {
		s.modelActionResult(w, r, err, "model.start")
		return
	}
	s.modelActionResult(w, r, s.startEnabledModel(r, model), "model.start")
}

func (s *Server) modelsStop(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("model_id")
	err := s.store.SetModelEnabled(r.Context(), id, false)
	if err == nil {
		err = s.models.Stop(id)
	}
	s.modelActionResult(w, r, err, "model.stop")
}

// modelsRestart is how an edited command takes effect: stop, then start from
// the saved command.
func (s *Server) modelsRestart(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("model_id")
	model, err := s.saveLaunchCommand(r)
	if err != nil {
		s.modelActionResult(w, r, err, "model.restart")
		return
	}
	if err := s.models.Stop(id); err != nil {
		s.modelActionResult(w, r, err, "model.restart")
		return
	}
	s.modelActionResult(w, r, s.startEnabledModel(r, model), "model.restart")
}

// Start and Restart submit the visible editor, just like Save. Validate before
// stopping anything so an invalid edit leaves a serving model alone.
func (s *Server) saveLaunchCommand(r *http.Request) (config.ManagedModel, error) {
	model, _ := parseModelForm(r, r.PathValue("model_id"))
	if err := model.Validate(); err != nil {
		return model, err
	}
	fleet, err := s.store.ManagedModels(r.Context())
	if err != nil {
		return model, err
	}
	found := false
	for i := range fleet {
		if fleet[i].ID == model.ID {
			fleet[i] = model
			found = true
		}
	}
	if !found {
		return model, errors.New("that model is not registered")
	}
	if err := config.ValidateManagedModels(fleet, s.startup.Port, s.veilPort()); err != nil {
		return model, err
	}
	if err := s.store.UpdateManagedModel(r.Context(), model); err != nil {
		return model, errors.New("the model could not be saved")
	}
	return model, s.handOffModels(r)
}

// handOffModels applies registry changes through the existing Veil supervisor.
// The first chat model becomes the default; removing it picks the next chat.
func (s *Server) handOffModels(r *http.Request) error {
	models, err := s.store.ManagedModels(r.Context())
	if err != nil {
		return err
	}
	cfg, ok, err := s.store.Configuration(r.Context(), "current")
	if err != nil {
		return err
	}
	if !ok {
		cfg = config.DefaultVeil()
	}
	var chosen *config.ManagedModel
	for i := range models {
		if config.NormalizeRole(models[i].Role) == config.RoleChat {
			if chosen == nil || models[i].ID == cfg.Model {
				chosen = &models[i]
			}
			if models[i].ID == cfg.Model {
				break
			}
		}
	}
	if chosen == nil {
		cfg.Model = ""
		cfg.ProviderBaseURL = config.DefaultVeil().ProviderBaseURL
		cfg.ContextLength = 0
	} else {
		facts, err := chosen.Parse()
		if err != nil {
			return err
		}
		cfg.Model = chosen.ID
		cfg.ProviderBaseURL = chosen.ProviderBaseURL()
		cfg.ContextLength = facts.MaxModelLen
		cfg = config.WithModelDefaults(cfg, facts.ModelPath)
	}
	if err := s.store.SavePending(r.Context(), cfg, time.Now()); err != nil {
		return err
	}
	if err := s.store.PromotePending(r.Context(), time.Now()); err != nil {
		return err
	}
	s.supervisor.SetModels(models)
	return s.restartVeilForChange(r.Context())
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
	if kind == config.KindEmbedding {
		return "/models?kind=embedding"
	}
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

func (s *Server) startEnabledModel(r *http.Request, model config.ManagedModel) error {
	if err := s.models.Start(model); err != nil {
		return err
	}
	if err := s.store.SetModelEnabled(r.Context(), model.ID, true); err != nil {
		_ = s.models.Stop(model.ID)
		return err
	}
	return nil
}
