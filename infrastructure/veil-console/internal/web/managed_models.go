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
	PendingApply  bool
	GPUTotal      string
	GPUOverloaded bool
	Running       int
	Registered    int
	// Form is the add/edit form's current values, so a rejected submission
	// comes back with what the administrator typed.
	Form      modelForm
	Editing   bool
	FormError string
}

type modelRow struct {
	config.ManagedModel
	State     supervisor.ModelState
	StateText string
	PID       int
	GPULabel  string
	LenLabel  string
	Logs      string
	Expanded  bool
	IsDefault bool
}

// modelForm mirrors the typed fields as strings so a rejected value is shown
// back exactly as typed rather than silently normalized.
type modelForm struct {
	ID           string
	DisplayName  string
	ModelPath    string
	Port         string
	MaxModelLen  string
	GPUFraction  string
	KVCacheDType string
	Reasoning    bool
}

func newModelForm(model config.ManagedModel) modelForm {
	return modelForm{
		ID:           model.ID,
		DisplayName:  model.DisplayName,
		ModelPath:    model.ModelPath,
		Port:         strconv.Itoa(model.Port),
		MaxModelLen:  strconv.Itoa(model.MaxModelLen),
		GPUFraction:  strconv.FormatFloat(model.GPUMemoryUtilization, 'f', -1, 64),
		KVCacheDType: model.KVCacheDType,
		Reasoning:    model.Reasoning,
	}
}

func (s *Server) modelsPage(w http.ResponseWriter, r *http.Request) {
	s.render(w, "models.html", s.modelsData(r, "", "", nil))
}

// modelsEdit reuses the same page with the form prefilled, so editing is one
// place rather than a second nearly-identical template.
func (s *Server) modelsEdit(w http.ResponseWriter, r *http.Request) {
	model, ok, err := s.store.ManagedModel(r.Context(), r.PathValue("model_id"))
	if err != nil || !ok {
		s.renderStatus(w, "models.html", http.StatusNotFound, s.modelsData(r, "That model is not registered.", "", nil))
		return
	}
	data := s.modelsData(r, "", "", nil)
	data.Models.Form = newModelForm(model)
	data.Models.Editing = true
	s.render(w, "models.html", data)
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
		Form:       modelForm{KVCacheDType: config.KVCacheFP8, GPUFraction: "0.45", MaxModelLen: "32768"},
	}
	view.Form.Port = strconv.Itoa(state.NextFreeManagedPort(models, s.startup.Port, s.veilPort()))
	if form != nil {
		view.Form = *form
	}
	for _, model := range models {
		status := s.models.Status(model.ID)
		row := modelRow{
			ManagedModel: model,
			State:        status.State,
			StateText:    modelStateText(status),
			PID:          status.PID,
			GPULabel:     "GPU " + strconv.FormatFloat(model.GPUMemoryUtilization, 'f', -1, 64),
			LenLabel:     "max len " + compactCount(model.MaxModelLen),
			Expanded:     expanded == model.ID,
			IsDefault:    model.ID == defaultModel,
		}
		if row.Expanded {
			row.Logs = s.models.Logs(model.ID)
		}
		view.Rows = append(view.Rows, row)
	}
	view.Running = s.models.RunningCount(models)

	// Only meaningful against a running Veil: with none there is nothing for a
	// change to be pending against, and the next start picks the stored set up.
	stored, _ := config.ModelsEnvJSON(models)
	view.PendingApply = s.supervisor.Status().Running && stored != s.supervisor.ModelsEnvironment()
	total := config.TotalGPUFraction(models)
	view.GPUTotal = strconv.FormatFloat(total, 'f', 2, 64)
	view.GPUOverloaded = total > 1.0

	session := r.Context().Value(sessionKey).(requestSession)
	processStatus := s.supervisor.Status()
	return pageData{
		Title: "Models", CSRF: csrfCookie(r), Username: session.Data.Username,
		Status: processStatus.String(), Running: processStatus.Running, Healthy: processStatus.Healthy,
		Error: errorMessage, Notice: noticeMessage, Models: view,
	}
}

func modelStateText(status supervisor.ModelStatus) string {
	if status.Message != "" {
		return status.Message
	}
	return string(status.State)
}

// compactCount renders a token count the way the chip shows it: "32k", "128k".
func compactCount(value int) string {
	if value >= 1000 && value%1000 == 0 {
		return strconv.Itoa(value/1000) + "k"
	}
	if value >= 1000 {
		return strconv.Itoa(value/1024) + "k"
	}
	return strconv.Itoa(value)
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

// parseModelForm reads the typed fields. Every value is parsed into its own
// type here, so nothing downstream ever sees browser text.
func parseModelForm(r *http.Request) (config.ManagedModel, modelForm, error) {
	form := modelForm{
		ID:           strings.TrimSpace(r.FormValue("id")),
		DisplayName:  strings.TrimSpace(r.FormValue("display_name")),
		ModelPath:    strings.TrimSpace(r.FormValue("model_path")),
		Port:         strings.TrimSpace(r.FormValue("port")),
		MaxModelLen:  strings.TrimSpace(r.FormValue("max_model_len")),
		GPUFraction:  strings.TrimSpace(r.FormValue("gpu_memory_utilization")),
		KVCacheDType: strings.TrimSpace(r.FormValue("kv_cache_dtype")),
		// A checkbox submits its `value` when checked and nothing when not, so
		// presence is the signal. Comparing against "on" would depend on a
		// default the markup happens not to override.
		Reasoning: r.FormValue("reasoning") != "",
	}
	port, err := strconv.Atoi(form.Port)
	if err != nil {
		return config.ManagedModel{}, form, errors.New("port must be a number")
	}
	maxModelLen, err := strconv.Atoi(form.MaxModelLen)
	if err != nil {
		return config.ManagedModel{}, form, errors.New("max model length must be a number")
	}
	fraction, err := strconv.ParseFloat(form.GPUFraction, 64)
	if err != nil {
		return config.ManagedModel{}, form, errors.New("GPU memory fraction must be a number")
	}
	model := config.ManagedModel{
		ID: form.ID, DisplayName: form.DisplayName, ModelPath: form.ModelPath,
		Port: port, MaxModelLen: maxModelLen, GPUMemoryUtilization: fraction,
		KVCacheDType: form.KVCacheDType, Reasoning: form.Reasoning,
	}
	return model, form, model.Validate()
}

func (s *Server) modelsCreate(w http.ResponseWriter, r *http.Request) {
	if !s.confirmModelPassword(w, r) {
		return
	}
	model, form, err := parseModelForm(r)
	if err != nil {
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

func (s *Server) modelsUpdate(w http.ResponseWriter, r *http.Request) {
	if !s.confirmModelPassword(w, r) {
		return
	}
	id := r.PathValue("model_id")
	model, form, err := parseModelForm(r)
	if err != nil {
		s.renderModelFormError(w, r, form, err)
		return
	}
	// The served id is the name clients stored. Editing the row cannot rename
	// it: that is a remove and an add, and it is visibly one.
	model.ID = id
	existing, err := s.store.ManagedModels(r.Context())
	if err != nil {
		s.renderModelFormError(w, r, form, errors.New("the model list could not be loaded"))
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
		s.renderModelFormError(w, r, form, err)
		return
	}
	if err := s.store.UpdateManagedModel(r.Context(), model); err != nil {
		s.renderModelFormError(w, r, form, errors.New("that model is not registered"))
		return
	}
	s.handOffModels(r)
	s.modelActionResult(w, r, nil, "model.update")
}

func (s *Server) modelsDelete(w http.ResponseWriter, r *http.Request) {
	if !s.confirmModelPassword(w, r) {
		return
	}
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
	if !s.confirmModelPassword(w, r) {
		return
	}
	model, ok, err := s.store.ManagedModel(r.Context(), r.PathValue("model_id"))
	if err != nil || !ok {
		s.modelActionResult(w, r, errors.New("that model is not registered"), "model.start")
		return
	}
	s.modelActionResult(w, r, s.models.Start(model), "model.start")
}

func (s *Server) modelsStop(w http.ResponseWriter, r *http.Request) {
	if !s.confirmModelPassword(w, r) {
		return
	}
	s.modelActionResult(w, r, s.models.Stop(r.PathValue("model_id")), "model.stop")
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

func (s *Server) confirmModelPassword(w http.ResponseWriter, r *http.Request) bool {
	if err := s.freshPassword(w, r); err != nil {
		status := http.StatusInternalServerError
		message := "Password confirmation failed. Try again."
		if errors.Is(err, errPasswordConfirmation) {
			status = http.StatusUnauthorized
			message = "Owner password is incorrect."
		}
		s.renderStatus(w, "models.html", status, s.modelsData(r, message, "", nil))
		return false
	}
	return true
}

func (s *Server) renderModelFormError(w http.ResponseWriter, r *http.Request, form modelForm, err error) {
	data := s.modelsData(r, "", "", &form)
	data.Models.FormError = err.Error()
	data.Models.Editing = form.ID != "" && r.PathValue("model_id") != ""
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
