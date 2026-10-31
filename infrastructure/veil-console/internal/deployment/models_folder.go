package deployment

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
)

// A protocol link starts an unprivileged, interactive helper. Its URL carries
// no source, destination, shell command, or Console credential.
func registerModelsFolder() error {
	user := os.Getenv("SUDO_USER")
	if runtime.GOOS == "darwin" {
		if user == "" || user == "root" {
			fmt.Printf("Open %s/Models.app once from Finder to enable the folder button.\n", installDir)
			return nil
		}
		return run("/usr/bin/sudo", "-u", user, "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister", "-f", installDir+"/Models.app")
	}
	const directory = "/usr/local/share/applications"
	if err := os.MkdirAll(directory, 0755); err != nil {
		return err
	}
	const desktop = `[Desktop Entry]
Type=Application
Name=Umbratic Models
Exec=xdg-open /var/lib/umbratic-models
Terminal=false
NoDisplay=true
MimeType=x-scheme-handler/umbratic-models;
`
	if err := os.WriteFile(directory+"/umbratic-models.desktop", []byte(desktop), 0644); err != nil {
		return err
	}
	if binary, err := exec.LookPath("update-desktop-database"); err == nil {
		if err := run(binary, directory); err != nil {
			return err
		}
	}
	if binary, err := exec.LookPath("xdg-mime"); err == nil && user != "" && user != "root" {
		return run("runuser", "-u", user, "--", binary, "default", "umbratic-models.desktop", "x-scheme-handler/umbratic-models")
	}
	fmt.Println("Without a desktop, copy model folders into /var/lib/umbratic-models and refresh Console.")
	return nil
}
