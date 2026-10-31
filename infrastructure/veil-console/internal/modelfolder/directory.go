package modelfolder

import "runtime"

func Directory() string {
	if runtime.GOOS == "darwin" {
		return "/Library/Application Support/Umbratic/Veil Console/Models"
	}
	return "/var/lib/umbratic-models"
}
