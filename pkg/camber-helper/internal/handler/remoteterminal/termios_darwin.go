package remoteterminal

import "syscall"

// ioctlReadTermios is the ioctl request that reads a tty's termios.
const ioctlReadTermios = syscall.TIOCGETA
