package deployment

import (
	"encoding/xml"
	"fmt"
	"os"
	"runtime"
	"strconv"
	"strings"
)

var services = []string{"qdrant", "console"}

func servicePath(name string) string {
	if runtime.GOOS == "darwin" {
		return "/Library/LaunchDaemons/com.umbratic." + name + ".plist"
	}
	return "/etc/systemd/system/umbratic-" + name + ".service"
}
func stopServices() error {
	for i := len(services) - 1; i >= 0; i-- {
		name := services[i]
		if _, err := os.Stat(servicePath(name)); os.IsNotExist(err) {
			continue
		}
		if runtime.GOOS == "darwin" {
			if _, err := output("launchctl", "print", "system/com.umbratic."+name); err == nil {
				if err := run("launchctl", "bootout", "system", servicePath(name)); err != nil {
					return err
				}
			}
		} else {
			if err := run("systemctl", "stop", "umbratic-"+name); err != nil {
				return err
			}
		}
	}
	return nil
}
func startServices() error {
	if runtime.GOOS == "linux" {
		if err := run("systemctl", "daemon-reload"); err != nil {
			return err
		}
	}
	for _, name := range services {
		var err error
		if runtime.GOOS == "darwin" {
			err = run("launchctl", "bootstrap", "system", servicePath(name))
		} else {
			err = run("systemctl", "enable", "--now", "umbratic-"+name)
		}
		if err != nil {
			return err
		}
	}
	return nil
}
func xmlText(s string) string {
	var b strings.Builder
	_ = xml.EscapeText(&b, []byte(s))
	return b.String()
}
func writeServices(p Package) error {
	c := p.Config
	console := []string{installDir + "/bin/veil-console", "--managed", "--state-dir", stateDir, "--veil-binary", installDir + "/bin/veil", "--entitlement", installDir + "/entitlement.json", "--port", strconv.Itoa(c.ConsolePort), "--veil-address", fmt.Sprintf("127.0.0.1:%d", c.VeilPort)}
	console = append(console, "--caddy-binary", installDir+"/bin/caddy")
	if runtime.GOOS == "darwin" {
		console = append(console, "--models-dir", macModelsDir)
	}
	if c.Profile == "metal" {
		console = append(console, "--vllm-binary", installDir+"/venv/bin/vllm")
	} else {
		console = append(console, "--vllm-docker-image", p.Manifest.Image)
	}
	commands := map[string][]string{
		"console": console,
		"qdrant":  {installDir + "/bin/qdrant", "--config-path", stateDir + "/qdrant.yaml"},
	}
	for _, name := range services {
		args := commands[name]
		var content string
		if runtime.GOOS == "darwin" {
			var array strings.Builder
			for _, arg := range args {
				array.WriteString("<string>" + xmlText(arg) + "</string>")
			}
			content = fmt.Sprintf(`<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>
<key>Label</key><string>com.umbratic.%s</string><key>UserName</key><string>%s</string>
<key>ProgramArguments</key><array>%s</array><key>WorkingDirectory</key><string>%s</string>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ExitTimeOut</key><integer>60</integer><key>Umask</key><integer>63</integer>
<key>EnvironmentVariables</key><dict><key>HOME</key><string>%s</string><key>PATH</key><string>%s/bin:%s/venv/bin:/usr/bin:/bin:/usr/sbin:/sbin</string><key>XDG_DATA_HOME</key><string>%s/.local/share</string></dict>
<key>StandardOutPath</key><string>%s/%s.log</string><key>StandardErrorPath</key><string>%s/%s.log</string>
</dict></plist>`, name, serviceUser, array.String(), xmlText(stateDir), xmlText(stateDir), installDir, installDir, xmlText(stateDir), xmlText(stateDir), name, xmlText(stateDir), name)
		} else {
			// Fixed installation paths and numeric ports; image references are validated.
			content = fmt.Sprintf("[Unit]\nDescription=Umbratic %s\nAfter=network-online.target docker.service\n[Service]\nUser=%s\nWorkingDirectory=%s\nEnvironment=HOME=%s\nEnvironment=PATH=%s/bin:/usr/bin:/bin\nEnvironment=UMBRATIC_RUNTIME_PROFILE=%s\nExecStart=%s\nRestart=on-failure\nTimeoutStopSec=90\nKillMode=control-group\nUMask=0077\nNoNewPrivileges=true\n[Install]\nWantedBy=multi-user.target\n", name, serviceUser, stateDir, stateDir, installDir, c.Profile, strings.Join(args, " "))
		}
		if err := os.WriteFile(servicePath(name), []byte(content), 0644); err != nil {
			return err
		}
	}
	return nil
}
