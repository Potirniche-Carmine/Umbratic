package config

import "strings"

func supportedEffort(value string) bool {
	switch value {
	case "on", "off", "low", "medium", "high", "xhigh", "max":
		return true
	}
	return false
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
