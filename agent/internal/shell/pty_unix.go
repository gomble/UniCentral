//go:build !windows

package shell

import (
	"os"
	"os/exec"
	"strconv"
	"syscall"
	"unsafe"
)

const (
	ioctlTIOCSWINSZ = 0x5414
	ioctlTIOCGPTN   = 0x80045430
	ioctlTIOCSPTLCK = 0x40045431
)

func startPty(cmd *exec.Cmd) (*os.File, error) {
	ptmx, err := os.OpenFile("/dev/ptmx", os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		return nil, err
	}

	sname, err := ptsname(ptmx)
	if err != nil {
		ptmx.Close()
		return nil, err
	}

	if err := unlockpt(ptmx); err != nil {
		ptmx.Close()
		return nil, err
	}

	tty, err := os.OpenFile(sname, os.O_RDWR|syscall.O_NOCTTY, 0)
	if err != nil {
		ptmx.Close()
		return nil, err
	}

	cmd.Stdin = tty
	cmd.Stdout = tty
	cmd.Stderr = tty
	cmd.SysProcAttr = &syscall.SysProcAttr{Setsid: true, Setctty: true}

	if err := cmd.Start(); err != nil {
		ptmx.Close()
		tty.Close()
		return nil, err
	}
	tty.Close()
	return ptmx, nil
}

func resizePty(ptmx *os.File, cols, rows int) {
	ws := struct {
		Row uint16
		Col uint16
		X   uint16
		Y   uint16
	}{uint16(rows), uint16(cols), 0, 0}
	syscall.Syscall(syscall.SYS_IOCTL, ptmx.Fd(), ioctlTIOCSWINSZ, uintptr(unsafe.Pointer(&ws)))
}

func ptsname(f *os.File) (string, error) {
	var n uint32
	_, _, e := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), ioctlTIOCGPTN, uintptr(unsafe.Pointer(&n)))
	if e != 0 {
		return "", e
	}
	return "/dev/pts/" + strconv.Itoa(int(n)), nil
}

func unlockpt(f *os.File) error {
	var u int32
	_, _, e := syscall.Syscall(syscall.SYS_IOCTL, f.Fd(), ioctlTIOCSPTLCK, uintptr(unsafe.Pointer(&u)))
	if e != 0 {
		return e
	}
	return nil
}
