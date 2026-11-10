package remoteterminal

import "syscall"

// ioctlReadTermios is the ioctl request that reads the termios of a tty.
const ioctlReadTermios = syscall.TCGETS
