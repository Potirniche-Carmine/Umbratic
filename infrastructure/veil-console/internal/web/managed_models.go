package web

import (
	"errors"
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
}

type modelRow struct {
	config.ManagedModel
	State     supervisor.ModelState
	StateText string
	PID       int
	Logs      string
	Expanded  bool
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
	ID          string
	DisplayName string
	Command     string
	Role        string
}

// SpeechSelected drives the add form's role control, so a rejected submission
// comes back with the role the administrator picked rather than the default.
func (f modelForm) SpeechSelected() bool { return f.Role == config.RoleSpeech }

func (s *Server) modelsPage(w http.ResponseWriter, r *http.Request) {
	s.render(w, "models.html", s.modelsData(r, "", "", nil))
}

func (s *Server) modelsData(r *http.Request, errorMessage, noticeMessage string, form *modelForm) pageData {
	models, err := s.store.ManagedModels(r.Context())
	if err != nil && errorMessage == "" {
		errorMessage = "The model list could not be loaded."
	}
	expanded := r.URL.Query().Get("logs")
	defaultModel := ""
	if cfg, ok, cfgErr := s.store.Configuration(r.Context(), "current"); cfgErr == nil && ok {
		defaultModel = cfg.Model
	}

	view := modelsView{
		Configured: s.models.Configured(),
		Registered: len(models),
		Form: modelForm{
			Command: config.DefaultCommand("", "", state.NextFreeManagedPort(models, s.startup.Port, s.veilPort())),
		},
	}
	if form != nil {
		view.Form = *form
	}
	for _, model := range models {
		status := s.models.Status(model.ID)
		running := status.State == supervisor.ModelHealthy || status.State == supervisor.ModelStarting
		stale := running && s.models.RunningCommand(model.ID) != strings.TrimSpace(model.Command)
		row := modelRow{
			ManagedModel: model,
			State:        status.State,
			StateText:    modelStateText(status),
			PID:          status.PID,
			Expanded:     expanded == model.ID,
			IsDefault:    model.ID == defaultModel,
			Running:      running,
			Stale:        stale,
			Notice:       modelNotice(model, running, stale),
		}
		if row.Expanded {
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

func parseModelForm(r *http.Request, id string) (config.ManagedModel, modelForm) {
	form := modelForm{
		ID:          strings.TrimSpace(r.FormValue("id")),
		DisplayName: strings.TrimSpace(r.FormValue("display_name")),
		Command:     strings.TrimSpace(r.FormValue("command")),
		Role:        config.NormalizeRole(r.FormValue("role")),
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

func (s *Server) modelActionResult(w http.ResponseWriter, r *http.Request, err error, event string) {
	if err != nil {
		s.store.Audit(r.Context(), event, "failure", time.Now())
		s.renderStatus(w, "models.html", statusFor(err), s.modelsData(r, err.Error(), "", nil))
		return
	}
	s.store.Audit(r.Context(), event, "success", time.Now())
	http.Redirect(w, r, "/models", http.StatusSeeOther)
}
