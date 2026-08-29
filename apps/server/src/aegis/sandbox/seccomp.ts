/**
 * KS-4 seccomp profile, as a module so it survives `tsc` without a copy step.
 * Aegis.bootstrap writes it to the data directory and passes that path to the
 * container engine.
 *
 * Passing --security-opt seccomp=<file> REPLACES the engine's default profile,
 * so this deny list is deliberately a SUPERSET of what Docker blocks by default.
 */

export const SECCOMP_PROFILE_NAME = "aegis-strict-v1";

export const SECCOMP_STRICT: Readonly<Record<string, unknown>> = {
  "_comment": [
    "AEGIS KS-4 seccomp profile. Passing --security-opt seccomp=<file> REPLACES the",
    "container engine's default profile, so this deny list is deliberately a SUPERSET",
    "of the syscalls Docker's default profile blocks. It removes the namespace,",
    "kernel-module, kernel-memory and tracing syscalls that container escapes and",
    "cross-process credential theft rely on. Layered on top of --cap-drop ALL and",
    "no-new-privileges; it is not a substitute for a microVM (see RR-1)."
  ],
  "defaultAction": "SCMP_ACT_ALLOW",
  "archMap": [
    {
      "architecture": "SCMP_ARCH_X86_64",
      "subArchitectures": [
        "SCMP_ARCH_X86",
        "SCMP_ARCH_X32"
      ]
    },
    {
      "architecture": "SCMP_ARCH_AARCH64",
      "subArchitectures": [
        "SCMP_ARCH_ARM"
      ]
    }
  ],
  "syscalls": [
    {
      "names": [
        "acct",
        "add_key",
        "bpf",
        "clock_adjtime",
        "clock_adjtime64",
        "clock_settime",
        "clock_settime64",
        "create_module",
        "delete_module",
        "finit_module",
        "get_kernel_syms",
        "get_mempolicy",
        "init_module",
        "ioperm",
        "iopl",
        "kcmp",
        "kexec_file_load",
        "kexec_load",
        "keyctl",
        "lookup_dcookie",
        "mbind",
        "mount",
        "mount_setattr",
        "move_mount",
        "move_pages",
        "name_to_handle_at",
        "nfsservctl",
        "open_by_handle_at",
        "open_tree",
        "perf_event_open",
        "pivot_root",
        "process_vm_readv",
        "process_vm_writev",
        "ptrace",
        "query_module",
        "quotactl",
        "quotactl_fd",
        "reboot",
        "request_key",
        "set_mempolicy",
        "setns",
        "settimeofday",
        "stime",
        "swapoff",
        "swapon",
        "sysfs",
        "umount",
        "umount2",
        "unshare",
        "uselib",
        "userfaultfd",
        "ustat",
        "vm86",
        "vm86old"
      ],
      "action": "SCMP_ACT_ERRNO",
      "errnoRet": 1,
      "comment": "EPERM. Superset of the Docker default deny set."
    }
  ]
};
