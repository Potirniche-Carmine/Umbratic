package config

import (
	"regexp"
	"strings"
)

var effortName = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)

func (m ManagedModel) ExtraEfforts() string {
	var values []string
	for _, effort := range m.Efforts() {
		if effort != "off" && effort != "on" && effort != "low" && effort != "medium" && effort != "high" {
			values = append(values, effort)
		}
	}
	return strings.Join(values, ", ")
}

func (m ManagedModel) Efforts() []string {
	if m.ReasoningEfforts == "" {
		return []string{}
	}
	return strings.Split(m.ReasoningEfforts, ",")
}

func (m ManagedModel) AllowsEffort(effort string) bool {
	for _, allowed := range m.Efforts() {
		if allowed == effort {
			return true
		}
	}
	return false
}
