//go:build !windows

package main

import (
	"fmt"
	"os"
)

// serviceMain: on Unix the agent is started by systemd as an ordinary process.
func serviceMain() (int, bool) { return 0, false }

func serviceCommand([]string) int {
	fmt.Fprintln(os.Stderr, "gsm-agent service: only on Windows; use systemctl with the gsm-agent unit here")
	return 2
}
