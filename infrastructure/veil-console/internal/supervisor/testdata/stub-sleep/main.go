package main

import "time"

// A stand-in for vLLM that starts and stays up. The supervisor tests need a
// real child they can spawn, double-start, and reap, without a GPU or an HTTP
// server. Arguments are ignored on purpose: argv is asserted elsewhere.
func main() {
	time.Sleep(time.Hour)
}
