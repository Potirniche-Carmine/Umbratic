// Build the upstream standard Caddy distribution with reviewed dependency fixes
// and the same patched Go toolchain required by Veil and Console.
package main

import (
	caddycmd "github.com/caddyserver/caddy/v2/cmd"
	_ "github.com/caddyserver/caddy/v2/modules/standard"
)

func main() {
	caddycmd.Main()
}
