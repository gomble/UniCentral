//go:build windows

package shell

import (
	"errors"
	"os"
	"os/exec"
)

func startPty(cmd *exec.Cmd) (*os.File, error) {
	return nil, errors.New("pty not supported on windows")
}

func resizePty(f *os.File, cols, rows int) {}
