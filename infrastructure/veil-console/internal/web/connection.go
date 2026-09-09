package web

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
	"umbratic-veil-console/internal/config"
)

func (s *Server) StartConnection(ctx context.Context) {
	if !s.proxy.Available() {
		return
	}
	for {
		if ctx.Err() != nil {
			return
		}
		if err := s.proxy.Start(ctx); err != nil {
			log.Print("HTTPS did not start; configure Connection on the Veil page")
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(30 * time.Second):
		}
	}
}
func (s *Server) connectionApply(w http.ResponseWriter, r *http.Request) {
	if !s.proxy.Available() {
		http.Error(w, "HTTPS is unavailable in this installation", http.StatusServiceUnavailable)
		return
	}
	// Public certificate issuance can outlast the ordinary page response deadline.
	_ = http.NewResponseController(w).SetWriteDeadline(time.Now().Add(2 * time.Minute))
	port, _ := strconv.Atoi(r.FormValue("port"))
	c := config.Connection{Host: strings.ToLower(strings.TrimSpace(r.FormValue("host"))), Port: port, TLS: r.FormValue("tls")}
	err := s.proxy.Apply(r.Context(), c, func(c config.Connection) error {
		if err := s.store.SaveConnection(r.Context(), c); err != nil {
			return errors.New("connection settings could not be saved")
		}
		return nil
	})
	if err != nil {
		s.store.Audit(r.Context(), "connection.apply", "failed", time.Now())
		data := s.dashboardData(r, err.Error(), "")
		data.Connection = c
		s.renderStatus(w, "dashboard.html", http.StatusBadRequest, data)
		return
	}
	s.store.Audit(r.Context(), "connection.apply", "succeeded", time.Now())
	s.render(w, "dashboard.html", s.dashboardData(r, "", "Connection saved. Use the new address on employee devices and issue new enrollment codes for pending invitations."))
}
