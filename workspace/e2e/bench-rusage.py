"""What macOS has counted for some processes since each began, for the bench (bench.spec.ts).

For each process id it prints the instructions the process has retired, the CPU time it has
used, and how much of that time ran on the fast cores, as one line of JSON:

  {"<pid>": {"instructions": n, "cpuNs": n, "fastNs": n}, "<pid>": null}

A process that is gone, or is not ours to read, is null. The counts come from
proc_pid_rusage with RUSAGE_INFO_V6, the call behind Activity Monitor: it only reads, and it
is in macOS only. On anything else this script fails, and the bench carries on without it.

Usage: python3 -I bench-rusage.py <pid> [<pid> ...]
"""
import ctypes
import json
import sys

RUSAGE_INFO_V6 = 6

# struct rusage_info_v6 in <sys/resource.h>: sixteen bytes of id, then 64-bit counts in this order.
FIELDS = [
    "user_time", "system_time", "pkg_idle_wkups", "interrupt_wkups", "pageins", "wired_size",
    "resident_size", "phys_footprint", "proc_start_abstime", "proc_exit_abstime",
    "child_user_time", "child_system_time", "child_pkg_idle_wkups", "child_interrupt_wkups",
    "child_pageins", "child_elapsed_abstime", "diskio_bytesread", "diskio_byteswritten",
    "qos_default", "qos_maintenance", "qos_background", "qos_utility", "qos_legacy",
    "qos_user_initiated", "qos_user_interactive", "billed_system_time", "serviced_system_time",
    "logical_writes", "lifetime_max_phys_footprint", "instructions", "cycles", "billed_energy",
    "serviced_energy", "interval_max_phys_footprint", "runnable_time", "flags", "user_ptime",
    "system_ptime", "pinstructions", "pcycles", "energy_nj", "penergy_nj",
]


class Info(ctypes.Structure):
    # The struct ends with fields this script does not read: room is left for them.
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(f, ctypes.c_uint64) for f in FIELDS] + [("rest", ctypes.c_uint64 * 16)]


class Timebase(ctypes.Structure):
    _fields_ = [("numer", ctypes.c_uint32), ("denom", ctypes.c_uint32)]


def main():
    proc = ctypes.CDLL("/usr/lib/libproc.dylib")
    system = ctypes.CDLL("/usr/lib/libSystem.B.dylib")
    # The times are in the machine's own ticks: this turns them into nanoseconds.
    timebase = Timebase()
    system.mach_timebase_info(ctypes.byref(timebase))

    def ns(ticks):
        return ticks * timebase.numer // timebase.denom

    out = {}
    for pid in sys.argv[1:]:
        info = Info()
        if proc.proc_pid_rusage(int(pid), RUSAGE_INFO_V6, ctypes.byref(info)) != 0:
            out[pid] = None
            continue
        out[pid] = {
            "instructions": info.instructions,
            "cpuNs": ns(info.user_time + info.system_time),
            "fastNs": ns(info.user_ptime + info.system_ptime),
        }
    print(json.dumps(out))


main()
