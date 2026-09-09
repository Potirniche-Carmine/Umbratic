package main

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
	"umbratic-veil-console/internal/deployment"
)

func main() {
	clean := flag.Bool("clean", false, "remove the current installation and private state before installing")
	check := flag.Bool("check", false, "validate package and host without installing")
	flag.Parse()
	executable, err := os.Executable()
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	p, err := deployment.Load(filepath.Dir(filepath.Dir(executable)))
	if err == nil {
		err = deployment.Preflight(p)
	}
	if err == nil && !*check {
		err = deployment.Install(p, *clean)
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "Deployment failed:", err)
		os.Exit(1)
	}
	if *check {
		fmt.Println("Package and host checks passed.")
	}
}
